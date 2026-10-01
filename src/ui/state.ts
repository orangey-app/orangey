/**
 * Application state: preferences, the open library, history, and the toast
 * queue. Views subscribe to changes; nothing here touches the DOM.
 */

import { CryptoSource, SeededSource, type RandomSource } from "../core/rng.ts";
import { appdb, HISTORY_CAP, HISTORY_IN_MEMORY, type HistoryEntry, type Prefs, type RollOrigin } from "../storage/appdb.ts";
import { LibraryService, type LibraryBackend } from "../storage/library.ts";
import { MemoryBackend } from "../storage/memory.ts";
import { locateLibrary } from "../storage/locate.ts";
import { useImageStore } from "../storage/images.ts";
import type { Randomizer } from "../model/randomizer.ts";
import { newId } from "../model/randomizer.ts";
import { DEFAULT_FEEL, normalizeFeel, prefersReducedMotion, type FeelSettings } from "./feel.ts";
import { starters } from "../model/starters.ts";
import { normalizeCustomScheme, parseSettings, portableSettings, serializeSettings } from "../model/settings-file.ts";
import { normalizeColours, type CustomColour } from "../model/colours.ts";
import { deriveTheme, THEME_TOKENS } from "../core/theme.ts";
import { WHEEL_COLOURS, WHEEL_SPARE } from "../core/palette-assign.ts";
import type { Outcome } from "../model/roll.ts";
import { emitMascotEvent, type MascotEvent } from "./mascot/events.ts";

/**
 * A history entry as the app holds it. Striking a roll keeps it, with a line
 * through; an entry without `struck` reads as not struck.
 */
export interface HistoryRow extends HistoryEntry {
  struck?: boolean;
}

/**
 * The randomizer a row came from. A dice roll's `repeat` holds its expression,
 * not an id, so the entry's own id says which randomizer rolled it.
 */
export function rollOwnerId(row: HistoryRow): string | null {
  return row.repeat?.kind === "randomizer" ? row.repeat.id : row.randomizerId;
}

/**
 * What a row says beyond its headline: the dice rolled inside the outcome, and
 * the roll that sent you here. Either may be missing.
 */
export function rollDetails(row: HistoryRow): { parts: string | null; from: string | null } {
  return {
    parts: row.parts?.length ? row.parts.join(" · ") : null,
    from: row.from ? `from ${row.from.randomizerName} → ${row.from.label}` : null,
  };
}

/** The rows belonging to these randomizers; no ids at all means all of them. */
export function rollsInScope(rows: HistoryRow[], ids: string[]): HistoryRow[] {
  if (ids.length === 0) return rows;
  const wanted = new Set(ids);
  return rows.filter((row) => {
    const owner = rollOwnerId(row);
    return owner !== null && wanted.has(owner);
  });
}

/**
 * What changed. A subscriber names the topics it cares about; one that names
 * none hears everything.
 */
export type StateTopic = "prefs" | "history" | "toasts" | "library" | "outcome";

export interface Toast {
  id: string;
  text: string;
  actionLabel?: string;
  action?: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

/** How often coming back to the tab may re-read a folder library. */
const RESCAN_DELAY = 30_000;

export const DEFAULT_PREFS: Prefs = {
  feel: DEFAULT_FEEL,
  seed: null,
  lastPath: null,
  expandedFolders: [],
  favourites: [],
  backend: "opfs",
  reducedMotionOverridden: false,
  seeded: false,
  animationsOff: false,
  scheme: "orangey",
  colours: [],
};

class AppState {
  prefs: Prefs = { ...DEFAULT_PREFS };
  library = new LibraryService(new MemoryBackend());
  history: HistoryRow[] = [];
  lastOutcome: { outcome: Outcome; randomizer: Randomizer } | null = null;
  toasts: Toast[] = [];
  ready = false;
  /** A folder was chosen before, but the browser wants a click to reopen it. */
  folderNeedsPermission = false;
  /**
   * Facts for the mascot and anyone else listening: views emit, the mascot only
   * reads. Nothing on this bus writes app state.
   */
  readonly events = new EventTarget();

  #listeners = new Set<{ fn: () => void; topics: Set<StateTopic> | null }>();
  /** The save-failure toast currently on screen, if there is one. */
  #saveErrorToast: string | null = null;
  /** Undoes the previous library's change subscription when one is swapped in. */
  #unwatchLibrary: (() => void) | null = null;

  /**
   * Take a library and listen to it. Every backend swap goes through here, so
   * failed writes, the image store and tree changes all follow the new library.
   */
  setLibrary(library: LibraryService): void {
    this.#unwatchLibrary?.();
    this.library = library;
    useImageStore(library.backend);
    this.#unwatchLibrary = library.onChange(() => this.emit("library"));
    library.onError(() => {
      // One toast, not one per keystroke, while the last is still on screen.
      if (this.#saveErrorToast && this.toasts.some((t) => t.id === this.#saveErrorToast)) return;
      this.#saveErrorToast = this.toast("Could not save your changes", "Retry", () => {
        void this.library.flush().catch(() => {});
      });
    });
  }

  subscribe(fn: () => void, topics?: StateTopic[]): () => void {
    const entry = { fn, topics: topics ? new Set(topics) : null };
    this.#listeners.add(entry);
    return () => this.#listeners.delete(entry);
  }

  /** Tell the subscribers who asked for any of these. No topics tells everyone. */
  emit(...topics: StateTopic[]): void {
    for (const { fn, topics: wanted } of this.#listeners) {
      if (!wanted || topics.length === 0 || topics.some((t) => wanted.has(t))) fn();
    }
  }

  async load(): Promise<void> {
    const stored = await appdb.get<Partial<Prefs>>("prefs");
    this.prefs = { ...DEFAULT_PREFS, ...stored, feel: normalizeFeel(stored?.feel), colours: normalizeColours(stored?.colours) };

    // Follow the system's reduced-motion setting until the user chooses explicitly.
    if (!this.prefs.reducedMotionOverridden && prefersReducedMotion()) {
      this.prefs.feel = { ...this.prefs.feel, motion: "instant" };
    }

    // Storage, in order of preference: the folder chosen last time (if reopening
    // needs no prompt), the origin-private filesystem, IndexedDB, and only then
    // memory, which the UI flags because nothing survives.
    const located = await locateLibrary();
    this.folderNeedsPermission = located.folder === "ask";
    const backend: LibraryBackend = located.backend ?? new MemoryBackend();
    this.setLibrary(new LibraryService(backend));
    await this.library.refresh();

    // First run: a few sample randomizers, once per browser and only into an empty
    // library (`?noseed` skips this for tests). A failed write is reported like any
    // failed save and must not stop the app opening.
    const noSeed = new URLSearchParams(location.search).has("noseed");
    if (!noSeed && !this.prefs.seeded && backend.kind !== "memory" && this.library.files().length === 0) {
      try {
        for (const starter of starters()) {
          if (starter.folder) await backend.mkdir(starter.folder);
          await this.library.create(starter.folder, starter.randomizer);
        }
        this.prefs.seeded = true;
        await appdb.set("prefs", this.prefs);
      } catch (error) {
        console.error("Orangey could not write the starter randomizers", error);
        this.toast("Could not write to this browser's storage");
      }
    }
    this.history = await appdb.history(HISTORY_IN_MEMORY);
    this.ready = true;

    // Saves are debounced, so flush when the page goes away. On mobile
    // `visibilitychange` is often the only event that fires.
    const flushNow = () => void this.library.flush().catch(() => {});
    addEventListener("pagehide", flushNow);
    addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        flushNow();
        return;
      }
      this.#rescanFolder();
    });

    this.applyTheme();
    this.emit();
  }

  /**
   * Re-read a folder library when the tab comes back: anything can edit it and
   * there is no directory watcher. Never with writes pending or an editor open.
   */
  #lastRescan = 0;
  #rescanFolder(): void {
    if (this.library.backend.kind !== "fsa" || this.library.hasUnsavedChanges) return;
    if (location.hash.startsWith("#/edit/")) return;
    const now = Date.now();
    if (now - this.#lastRescan < RESCAN_DELAY) return;
    this.#lastRescan = now;
    void this.library.refresh().catch(() => {});
  }

  /**
   * The one place theme colours are set: a built-in scheme is an attribute, your
   * own adds every derived token inline, and anything else removes them again.
   */
  applyTheme(): void {
    const root = document.documentElement;
    const custom = this.prefs.scheme === "custom" ? normalizeCustomScheme(this.prefs.customScheme) : undefined;
    if (custom) {
      root.setAttribute("data-scheme", "custom");
      for (const [token, value] of Object.entries(deriveTheme(custom))) root.style.setProperty(token, value);
      return;
    }
    for (const token of THEME_TOKENS) root.style.removeProperty(token);
    // "custom" with nothing saved behind it (a damaged store) follows the system.
    const scheme = this.prefs.scheme === "custom" ? "system" : this.prefs.scheme;
    if (!scheme || scheme === "system") root.removeAttribute("data-scheme");
    else root.setAttribute("data-scheme", scheme);
  }

  /**
   * The colours a wheel is painted in: its own palette, padded with the
   * spare it would otherwise have; else your theme's; else the built-in red,
   * yellow and blue with green to spare.
   */
  wheelColours(palette?: readonly string[]): string[] {
    const custom = this.prefs.scheme === "custom" ? normalizeCustomScheme(this.prefs.customScheme) : undefined;
    const base = custom ? [...custom.wheel] : [...WHEEL_COLOURS, WHEEL_SPARE];
    if (palette && palette.length >= 3) return [palette[0], palette[1], palette[2], palette[3] ?? base[3]];
    return base;
  }

  async savePrefs(patch: Partial<Prefs>): Promise<void> {
    this.prefs = { ...this.prefs, ...patch };
    this.applyTheme();
    this.emit("prefs");
    await appdb.set("prefs", this.prefs);
  }

  setFeel(patch: Partial<FeelSettings>): void {
    void this.savePrefs({ feel: normalizeFeel({ ...this.prefs.feel, ...patch }) });
  }

  /** Add a colour to the palette; a hex already there just gets the new name. */
  addColour(colour: CustomColour): void {
    const next = normalizeColours([...this.prefs.colours.filter((c) => c.hex !== colour.hex.toLowerCase()), colour]);
    void this.savePrefs({ colours: next });
  }

  removeColour(hex: string): void {
    void this.savePrefs({ colours: this.prefs.colours.filter((c) => c.hex !== hex.toLowerCase()) });
  }

  /** The settings worth carrying to another device, as a file's text. */
  exportSettings(): string {
    return serializeSettings(portableSettings(this.prefs));
  }

  /** Apply a settings file. Throws a ValidationError; nothing changes on failure. */
  async importSettings(text: string): Promise<void> {
    const s = parseSettings(text);
    this.resetSeedSequence();
    // A settings file without a theme of its own leaves this device's theme alone.
    await this.savePrefs({
      scheme: s.scheme, feel: s.feel, seed: s.seed, reducedMotionOverridden: s.reducedMotionOverridden, colours: s.colours,
      customScheme: s.customScheme ?? this.prefs.customScheme,
    });
  }

  /** The source the next roll should use: seeded when a seed is set. */
  source(): RandomSource {
    return this.prefs.seed ? new SeededSource(this.#nextSeedStep()) : new CryptoSource();
  }

  /**
   * A seeded session advances the seed per roll ("847193" gives 847193#1, #2, …),
   * so sharing the base seed reproduces the whole sequence.
   */
  #seedStep = 0;
  #nextSeedStep(): string {
    this.#seedStep += 1;
    return `${this.prefs.seed}#${this.#seedStep}`;
  }

  resetSeedSequence(): void {
    this.#seedStep = 0;
  }

  get seedPosition(): number {
    return this.#seedStep;
  }

  tell(event: MascotEvent): void {
    emitMascotEvent(this.events, event);
  }

  async record(randomizer: Randomizer, outcome: Outcome, from?: RollOrigin): Promise<void> {
    this.lastOutcome = { outcome, randomizer };
    // Beyond the headline: the dice inside the outcome and, for a pick, what it was
    // picked from, both in `parts`.
    const parts = [
      ...(outcome.rolled ?? []),
      ...(outcome.offered ? [`chosen from ${outcome.offered.join(", ")}`] : []),
      ...(outcome.picked ? ["picked, not rolled"] : []),
      ...(outcome.blot !== undefined ? [`blot ${outcome.blot}`] : []),
    ];
    const entry: HistoryRow = {
      id: newId(),
      at: Date.now(),
      randomizerId: randomizer.id,
      randomizerName: randomizer.name,
      type: randomizer.type,
      resultText: outcome.detail && outcome.kind === "dice" ? outcome.detail : outcome.text,
      speakText: outcome.speak,
      seed: this.prefs.seed ? `${this.prefs.seed}#${this.#seedStep}` : undefined,
      repeat:
        randomizer.type === "dice"
          ? { kind: "dice", expression: randomizer.expression }
          : { kind: "randomizer", id: randomizer.id },
      ...(parts.length ? { parts } : {}),
      ...(from ? { from } : {}),
    };
    this.history = [entry, ...this.history].slice(0, HISTORY_IN_MEMORY);
    this.emit("history", "outcome");
    await appdb.addHistory(entry);
  }

  async removeHistory(id: string): Promise<void> {
    this.history = this.history.filter((h) => h.id !== id);
    this.emit("history");
    await appdb.removeHistory(id);
  }

  async clearHistory(): Promise<void> {
    this.history = [];
    this.emit("history");
    await appdb.clearHistory();
  }

  /**
   * Clear the rolls of these randomizers (no ids: the whole history). Memory holds
   * only recent rolls, so the store is walked as well.
   */
  async clearHistoryFor(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      await this.clearHistory();
      return;
    }
    const doomed = new Set(rollsInScope(this.history, ids).map((row) => row.id));
    this.history = this.history.filter((row) => !doomed.has(row.id));
    this.emit("history");
    const stored = await appdb.history(HISTORY_CAP);
    await appdb.removeHistoryMany(rollsInScope(stored, ids).map((row) => row.id));
  }

  /**
   * Strike a roll through, or undo that. The store keeps whole records, so the
   * entry is written back whole.
   */
  async setStruck(id: string, struck: boolean): Promise<void> {
    const row = this.history.find((entry) => entry.id === id);
    if (!row || row.struck === struck) return;
    const next: HistoryRow = { ...row, struck };
    this.history = this.history.map((entry) => (entry.id === id ? next : entry));
    this.emit("history");
    await appdb.addHistory(next);
  }

  toast(text: string, actionLabel?: string, action?: () => void, ms = 10000): string {
    const toast: Toast = { id: newId(), text, actionLabel, action };
    toast.timer = setTimeout(() => this.dismissToast(toast.id), ms);
    this.toasts = [...this.toasts, toast].slice(-3);
    this.emit("toasts");
    return toast.id;
  }

  dismissToast(id: string): void {
    const toast = this.toasts.find((t) => t.id === id);
    if (toast?.timer) clearTimeout(toast.timer);
    this.toasts = this.toasts.filter((t) => t.id !== id);
    this.emit("toasts");
  }

  /** Run the most recent toast's action; wired to Ctrl/Cmd+Z. */
  undoLast(): boolean {
    const toast = this.toasts[this.toasts.length - 1];
    if (!toast?.action) return false;
    toast.action();
    this.dismissToast(toast.id);
    return true;
  }

  toggleFavourite(id: string): void {
    const favourites = this.prefs.favourites.includes(id)
      ? this.prefs.favourites.filter((f) => f !== id)
      : [...this.prefs.favourites, id];
    void this.savePrefs({ favourites });
  }
}

export const state = new AppState();
