/**
 * Application state: preferences, the open library, history, and the toast
 * queue. Views subscribe to changes; nothing here touches the DOM.
 */

import { CryptoSource, SeededSource, type RandomSource } from "../core/rng.ts";
import { appdb, type HistoryEntry, type Prefs } from "../storage/appdb.ts";
import { LibraryService, type LibraryBackend } from "../storage/library.ts";
import { MemoryBackend } from "../storage/memory.ts";
import { openOpfs, reopenFolder } from "../storage/fsdir.ts";
import { IndexedDbBackend } from "../storage/idb.ts";
import type { Randomizer } from "../model/randomizer.ts";
import { newId } from "../model/randomizer.ts";
import { DEFAULT_FEEL, normalizeFeel, prefersReducedMotion, type FeelSettings } from "./feel.ts";
import { starters } from "../model/starters.ts";
import { normalizeColours, parseSettings, portableSettings, serializeSettings, type CustomColour } from "../model/settings-file.ts";
import type { Outcome } from "./roll.ts";
import { emitMascotEvent, type MascotEvent } from "./mascot/events.ts";

export interface Toast {
  id: string;
  text: string;
  actionLabel?: string;
  action?: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

export const DEFAULT_PREFS: Prefs = {
  theme: "system",
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
  history: HistoryEntry[] = [];
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

  #listeners = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  emit(): void {
    for (const fn of this.#listeners) fn();
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
    backend ??= await openOpfs();
    backend ??= await IndexedDbBackend.open();
    backend ??= new MemoryBackend();
    this.library = new LibraryService(backend);
    await this.library.refresh();

    // First run: a few real randomizers, so the app is not an empty page.
    // Only ever once per browser, and only into an empty library.
    // ?noseed lets the test suite start from a genuinely empty library.
    const noSeed = new URLSearchParams(location.search).has("noseed");
    if (!noSeed && !this.prefs.seeded && backend.kind !== "memory" && this.library.files().length === 0) {
      for (const starter of starters()) {
        if (starter.folder) await backend.mkdir(starter.folder);
        await this.library.create(starter.folder, starter.randomizer);
      }
      this.prefs.seeded = true;
      await appdb.set("prefs", this.prefs);
    }
    this.history = await appdb.history();
    this.ready = true;
    this.applyTheme();
    this.emit();
  }

  applyTheme(): void {
    const root = document.documentElement;
    root.removeAttribute("data-theme");
    if (!this.prefs.scheme || this.prefs.scheme === "system") root.removeAttribute("data-scheme");
    else root.setAttribute("data-scheme", this.prefs.scheme);
  }

  async savePrefs(patch: Partial<Prefs>): Promise<void> {
    this.prefs = { ...this.prefs, ...patch };
    this.applyTheme();
    this.emit();
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

  async record(randomizer: Randomizer, outcome: Outcome): Promise<void> {
    this.lastOutcome = { outcome, randomizer };
    const entry: HistoryEntry = {
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
    };
    this.history = [entry, ...this.history].slice(0, 500);
    this.emit();
    await appdb.addHistory(entry);
  }

  async removeHistory(id: string): Promise<void> {
    this.history = this.history.filter((h) => h.id !== id);
    this.emit();
    await appdb.removeHistory(id);
  }

  async clearHistory(): Promise<void> {
    this.history = [];
    this.emit();
    await appdb.clearHistory();
  }

  toast(text: string, actionLabel?: string, action?: () => void, ms = 10000): void {
    const toast: Toast = { id: newId(), text, actionLabel, action };
    toast.timer = setTimeout(() => this.dismissToast(toast.id), ms);
    this.toasts = [...this.toasts, toast].slice(-3);
    this.emit();
  }

  dismissToast(id: string): void {
    const toast = this.toasts.find((t) => t.id === id);
    if (toast?.timer) clearTimeout(toast.timer);
    this.toasts = this.toasts.filter((t) => t.id !== id);
    this.emit();
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
