/**
 * The pop-out: a randomizer or a board in a Document Picture-in-Picture window
 * that stays on top of other programs. This page's own code runs it, so it
 * shares history, bags, theme and library with the tab, and everything it
 * reaches must work in any window. One per tab; the button is not shown where
 * the API is missing.
 *
 * It shows cells for rolling, not editing. An outcome that leads to another
 * randomizer offers a button to swap the cell over to it (← comes back), so the
 * answer can be read first.
 */

import { isBoard, type Randomizer } from "../model/randomizer.ts";
import { appendChildren, button, h, isTyping, setChildren } from "./dom.ts";
import { state } from "./state.ts";
import { createCell, type CellView } from "./components/cell.ts";
import { advanceChain, chainTarget, createChainSurface, type ChainLink } from "./components/chain.ts";
import { loadBoardTemps } from "./board-temps.ts";
import type { Outcome } from "../model/roll.ts";

/** The part of the API this file uses; the DOM typings do not have it yet. */
interface PipApi {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
}

function pipApi(): PipApi | null {
  return (window as unknown as { documentPictureInPicture?: PipApi }).documentPictureInPicture ?? null;
}

export function canPopOut(): boolean {
  return pipApi() !== null;
}

let openPopout: { win: Window; destroy: () => void } | null = null;

/**
 * The Pop out button, or null where the API is missing. `current` is read at the
 * press, since the randomizer may have been edited in the meantime.
 */
export function popOutButton(current: () => Randomizer): HTMLElement | null {
  if (!canPopOut()) return null;
  return button("Pop out", () => void popOut(current()), {
    class: "ghost popout-button",
    title: "Open this in a small window that stays on top of other programs",
  });
}

export async function popOut(randomizer: Randomizer): Promise<void> {
  const api = pipApi();
  if (!api) return;
  const board = isBoard(randomizer);
  const across = board ? Math.min(3, Math.max(1, randomizer.entries.length)) : 1;
  let win: Window;
  try {
    // Before any other await: the browser opens the window only in direct answer
    // to the press. The size is only a suggestion.
    win = await api.requestWindow(board ? { width: 40 + across * 280, height: 620 } : { width: 360, height: 560 });
  } catch (error) {
    state.toast(`Could not open a pop-out window: ${(error as Error).message}`);
    return;
  }
  openPopout?.destroy();

  const doc = win.document;
  doc.title = `${randomizer.name} — Orangey`;
  copyStyles(doc);
  const syncTheme = () => {
    // Mirror the theme's root attributes and inline tokens (see state.applyTheme),
    // now and on every change.
    const from = document.documentElement;
    const to = doc.documentElement;
    const scheme = from.getAttribute("data-scheme");
    if (scheme) to.setAttribute("data-scheme", scheme);
    else to.removeAttribute("data-scheme");
    to.style.cssText = from.style.cssText;
  };
  syncTheme();
  const unsubscribe = state.subscribe(syncTheme, ["prefs"]);

  const temps = board ? await loadBoardTemps(randomizer.id) : [];
  const roots: Randomizer[] = board
    ? [
      ...randomizer.entries.map((e) => state.library.findById(e.id)?.randomizer).filter((r): r is Randomizer => Boolean(r)),
      // A quick wheel with nothing typed yet has nothing to roll.
      ...temps.filter((t) => t.type !== "list" || t.items.length > 0),
    ]
    : [randomizer];
  const slots = roots.map((r) => createPopoutSlot(r));

  const rollAllButton = board ? button("Roll all", () => void rollAll(), { class: "primary roll-button popout-roll-all" }) : null;
  async function rollAll(): Promise<void> {
    if (slots.some((slot) => slot.rolling)) {
      for (const slot of slots) slot.skip();
      return;
    }
    rollAllButton!.textContent = "Skip";
    // Each cell goes back to its own randomizer first, as Roll all does on a board.
    for (const slot of slots) slot.reset();
    await Promise.all(slots.map((slot) => slot.roll()));
    rollAllButton!.textContent = "Roll all";
  }

  doc.body.className = board ? "popout popout-board" : "popout popout-single";
  appendChildren(doc.body,
    h("h1", { class: "popout-title", text: randomizer.name }),
    h("div", { class: "popout-grid" },
      ...(slots.length ? slots.map((slot) => slot.el) : [h("p", { class: "faint", text: "Nothing on this board to roll." })])),
    rollAllButton,
  );

  // The play screen's keys: Space or Enter rolls (everything, on a board), Escape
  // skips. A focused button keeps its own Space and Enter.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      for (const slot of slots) slot.skip();
      return;
    }
    if (isTyping(e) || (e.target as HTMLElement | null)?.closest?.("button")) return;
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      if (board) void rollAll();
      else void slots[0]?.roll();
    }
  };
  doc.addEventListener("keydown", onKey);

  const entry = {
    win,
    destroy: () => {
      unsubscribe();
      doc.removeEventListener("keydown", onKey);
      for (const slot of slots) slot.skip();
      if (openPopout === entry) openPopout = null;
    },
  };
  openPopout = entry;
  // Closed by its own ✕, by opening another, or with the tab.
  win.addEventListener("pagehide", () => entry.destroy(), { once: true });
}

/**
 * Copy this page's styles into the pop-out, which starts with none. A sheet that
 * cannot be read is linked instead.
 */
function copyStyles(doc: Document): void {
  for (const sheet of [...document.styleSheets]) {
    try {
      const style = doc.createElement("style");
      style.textContent = [...sheet.cssRules].map((rule) => rule.cssText).join("\n");
      doc.head.append(style);
    } catch {
      if (!sheet.href) continue;
      const link = doc.createElement("link");
      link.rel = "stylesheet";
      link.href = sheet.href;
      doc.head.append(link);
    }
  }
}

interface PopoutSlot {
  el: HTMLElement;
  /** Roll whatever the slot is showing now. */
  roll(): Promise<void>;
  skip(): void;
  /** Back to its own randomizer, forgetting where its outcomes led. */
  reset(): void;
  readonly rolling: boolean;
}

/**
 * One cell of the pop-out, and the chain it can walk along in place. `links` is
 * the chain as chain.ts keeps it and `at` the link on show; going back keeps
 * what is ahead, rolling again replaces it.
 */
function createPopoutSlot(root: Randomizer): PopoutSlot {
  let links: ChainLink[] = [{ id: root.id, name: root.name, from: "", found: true }];
  let surfaces: ({ el: HTMLElement; cell: CellView | null } | undefined)[] = [];
  let at = 0;

  const back = button("", () => show(at - 1), { class: "ghost popout-back" });
  const next = button("", () => show(at + 1), { class: "ghost popout-next" });
  const note = h("p", { class: "faint popout-note" });
  const body = h("div", { class: "popout-body" });
  const el = h("div", { class: "popout-slot" }, back, body);

  function landed(i: number, randomizer: Randomizer, outcome: Outcome): void {
    // A roll that finished after the slot moved on, or was reset.
    if (i !== at || surfaces[i]?.cell?.randomizer !== randomizer) return;
    const advance = advanceChain(links, i, chainTarget(randomizer, outcome), (id) => state.library.findById(id)?.randomizer ?? null);
    links = advance.links;
    surfaces.length = i + 1;
    note.textContent = advance.note ?? "";
    render();
  }

  /** A roll is starting where the slot is: what the last answer led to goes. */
  function starting(i: number): void {
    if (i !== at) return;
    links = links.slice(0, i + 1);
    surfaces.length = i + 1;
    note.textContent = "";
    render();
  }

  function surfaceFor(i: number): { el: HTMLElement; cell: CellView | null } {
    const existing = surfaces[i];
    if (existing) return existing;
    let made: { el: HTMLElement; cell: CellView | null };
    if (i === 0) {
      const cell = createCell(root, {
        onRoll: () => starting(0),
        onLanded: (outcome) => landed(0, cell.randomizer, outcome),
        clickToRoll: true,
        quickEdit: true,
      });
      made = { cell, el: h("div", { class: "popout-root" }, cell.el) };
    } else {
      const surface = createChainSurface(links[i], links[i - 1].name, {
        onRoll: () => starting(i),
        onLanded: (outcome) => surface.cell && landed(i, surface.cell.randomizer, outcome),
        clickToRoll: true,
      });
      made = surface;
    }
    surfaces[i] = made;
    return made;
  }

  function show(i: number): void {
    if (i < 0 || i >= links.length) return;
    at = i;
    render();
  }

  function render(): void {
    const surface = surfaceFor(at);
    setChildren(body, surface.el);
    surface.el.append(next, note);
    back.hidden = at === 0;
    back.textContent = at > 0 ? `← ${links[at - 1].name}` : "";
    next.hidden = at + 1 >= links.length;
    next.textContent = at + 1 < links.length ? `→ ${links[at + 1].name}` : "";
    note.hidden = !note.textContent;
  }

  render();

  return {
    el,
    roll: () => surfaceFor(at).cell?.roll() ?? Promise.resolve(),
    skip: () => surfaceFor(at).cell?.skip(),
    reset: () => {
      links = links.slice(0, 1);
      surfaces = surfaces.slice(0, 1);
      at = 0;
      note.textContent = "";
      render();
    },
    get rolling() {
      return surfaceFor(at).cell?.rolling ?? false;
    },
  };
}
