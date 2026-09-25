/**
 * Application state: preferences, the open library, history, and the toast
 * queue. Views subscribe to changes; nothing here touches the DOM.
 */

import { CryptoSource, SeededSource, type RandomSource } from "../core/rng.ts";
import { appdb, HISTORY_CAP, HISTORY_IN_MEMORY, type HistoryEntry, type Prefs, type RollOrigin } from "../storage/appdb.ts";
import { LibraryService, type LibraryBackend } from "../storage/library.ts";
import { MemoryBackend } from "../storage/memory.ts";
import { openOpfs, reopenFolder } from "../storage/fsdir.ts";
import { IndexedDbBackend } from "../storage/idb.ts";
import { useImageStore } from "../storage/images.ts";
import type { Randomizer } from "../model/randomizer.ts";
import { newId } from "../model/randomizer.ts";
import { DEFAULT_FEEL, normalizeFeel, prefersReducedMotion, type FeelSettings } from "./feel.ts";
import { starters } from "../model/starters.ts";
import { normalizeColours, parseSettings, portableSettings, serializeSettings, type CustomColour } from "../model/settings-file.ts";
import type { Outcome } from "./roll.ts";
import { emitMascotEvent, type MascotEvent } from "./mascot/events.ts";

/**
 * A history entry as the app holds it. Striking a roll does not remove it —
 * the roll happened, and a line through it says so — so the flag rides along
 * in the record IndexedDB already keeps. An entry written before this existed
 * arrives without the field, which reads as not struck.
 */
export interface HistoryRow extends HistoryEntry {
  struck?: boolean;
}

/**
 * The randomizer a row came from. A dice roll carries its expression rather
 * than an id in `repeat`, so for those the id on the entry is what says which
 * randomizer rolled it.
 */
export function rollOwnerId(row: HistoryRow): string | null {
  return row.repeat?.kind === "randomizer" ? row.repeat.id : row.randomizerId;
}

/**
 * What a row says beyond its headline: the dice rolled inside the outcome,
 * and the roll that sent you here. Each is its own line, and either may be
 * missing — a row written before 0.5 has neither.
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
 * What changed. A view says which of these it cares about, so typing in the
 * editor no longer redraws the history panel and a toast no longer redraws
 * the library tree.
 *
 * A subscriber that names no topics hears everything, which keeps any caller
 * that was missed correct rather than silently stale.
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

/**
 * The browser's own storage for the library: the origin-private filesystem
 * where it can be written to, IndexedDB otherwise.
 *
 * With one exception. A browser that gains a writable filesystem in an update
 * — Safari did between 18 and 26 — would open an empty one and hide the
 * library its IndexedDB holds. So a library already in IndexedDB is kept over
 * an empty filesystem. The extra look costs one IndexedDB open, and only on a
 * browser whose filesystem is empty, which after the first run means never.
 */
async function pickBrowserStorage(): Promise<LibraryBackend | null> {
  const opfs = await openOpfs();
  if (!opfs) return IndexedDbBackend.open();
  const empty = (await opfs.list("").catch(() => [])).length === 0;
  if (!empty || (await IndexedDbBackend.exists()) === false) return opfs;
  const idb = await IndexedDbBackend.open();
  if (!idb) return opfs;
  if ((await idb.list("").catch(() => [])).length > 0) return idb;
  idb.close();
  return opfs;
}

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
   * Facts for the mascot (and anything else that wants them). Views emit;
   * the mascot host listens. Nothing on this bus ever writes app state.
   */
  readonly events = new EventTarget();

  #listeners = new Set<{ fn: () => void; topics: Set<StateTopic> | null }>();
  /** The save-failure toast currently on screen, if there is one. */
  #saveErrorToast: string | null = null;
  /** Undoes the previous library's change subscription when one is swapped in. */
  #unwatchLibrary: (() => void) | null = null;

  /**
   * Take a library and listen to it.
   *
   * Every place that swaps the backend goes through here, so a failed write
   * always has somebody to tell, the image store follows the library, and a
   * change to the tree reaches the views that draw it.
   */
  setLibrary(library: LibraryService): void {
    this.#unwatchLibrary?.();
    this.library = library;
    useImageStore(library.backend);
    this.#unwatchLibrary = library.onChange(() => this.emit("library"));
    library.onError(() => {
      // One toast, not one per keystroke: while the last one is still on
      // screen a further failure has nothing new to say.
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

    // Respect the system setting on first run, but let an explicit choice win
    // from then on (plan C10).
    if (!this.prefs.reducedMotionOverridden && prefersReducedMotion()) {
      this.prefs.feel = { ...this.prefs.feel, motion: "instant" };
    }

    // Storage, in order of preference: the folder the user chose last time
    // (if the browser still allows it without asking), the origin-private
    // filesystem, IndexedDB — which a page opened from disk does get — and
    // only then memory, which the UI flags loudly because nothing survives.
    let backend: LibraryBackend | null = null;
    const remembered = await reopenFolder();
    if (remembered && remembered !== "ask") backend = remembered;
    this.folderNeedsPermission = remembered === "ask";
    backend ??= await pickBrowserStorage();
    backend ??= new MemoryBackend();
    this.setLibrary(new LibraryService(backend));
    await this.library.refresh();

    // First run: a few real randomizers, so the app is not an empty page.
    // Only ever once per browser, and only into an empty library.
    // ?noseed lets the test suite start from a genuinely empty library.
    // A write that fails here is reported the way any failed save is; it
    // must not stop the app from opening, since an empty library that can be
    // looked at beats a page that says "Loading…" for ever.
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

    // The editor no longer writes on every keystroke, so something has to
    // catch the last one when the page goes away. `pagehide` covers closing
    // and navigating; `visibilitychange` covers a phone being locked or the
    // tab being switched, which on mobile is often the only one that fires.
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
   * A library in a folder can be edited by anything: an editor, a sync
   * client, another window. Coming back to the tab is the moment to look
   * again — there is no watcher for a directory handle, and polling a folder
   * of files for changes nobody may have made is not worth the battery.
   *
   * Never while there is something waiting to be written, and never while an
   * editor is open: the editor holds its own copy and only the node's path,
   * so a rescan cannot actually disturb it, but having the tree shift under
   * someone mid-edit is its own kind of surprise.
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

  applyTheme(): void {
    const root = document.documentElement;
    if (!this.prefs.scheme || this.prefs.scheme === "system") root.removeAttribute("data-scheme");
    else root.setAttribute("data-scheme", this.prefs.scheme);
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
    await this.savePrefs({ scheme: s.scheme, feel: s.feel, seed: s.seed, reducedMotionOverridden: s.reducedMotionOverridden, colours: s.colours });
  }

  /** The source the next roll should use: seeded when a seed is set. */
  source(): RandomSource {
    return this.prefs.seed ? new SeededSource(this.#nextSeedStep()) : new CryptoSource();
  }

  /**
   * A seeded session must not repeat the same number forever, so the seed is
   * advanced per roll: seed "847193" gives 847193#1, #2, ... The user shares
   * the base seed and everyone sees the same sequence.
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
    // What a row says beyond its headline: the dice inside the outcome and,
    // for a pick, what it was picked from. Both ride in `parts`, the row's
    // existing details line, rather than in a field of their own.
    const parts = [...(outcome.rolled ?? []), ...(outcome.offered ? [`chosen from ${outcome.offered.join(", ")}`] : [])];
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
   * Clear the rolls of particular randomizers — what a Recent rolls panel has
   * in front of the user — and nothing else. No ids means the whole history.
   *
   * Memory holds the most recent rolls only, so the store is walked as well:
   * an older roll of the same randomizer is part of what was asked for.
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
   * Strike a roll through, or take the line off again. The entry goes back to
   * the store whole, because the store keeps records rather than fields.
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
