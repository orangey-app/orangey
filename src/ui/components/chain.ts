/**
 * A chain of randomizers: an outcome with `goesTo` opens that randomizer beside
 * the one that sent you there, and it waits to be rolled, as a table would pick
 * up a second set of dice.
 *
 * Only the newest two stay full size; earlier ones become icons in the strip
 * above, with their name and answer, and clicking one brings it back. The rules
 * are `advanceChain` and `chainPlacement`, which need no DOM, so tests can ask
 * them directly.
 */

import type { Randomizer } from "../../model/randomizer.ts";
import { h, setChildren } from "../dom.ts";
import { state } from "../state.ts";
import type { Outcome } from "../roll.ts";
import { cellRollButton, createCell, type CellView } from "./cell.ts";

/** How many randomizers in a chain keep their full size. The rest are icons. */
export const CHAIN_FULL_SIZE = 2;

/** Where an outcome points, and what that outcome was called on the wheel. */
export interface ChainTarget {
  id: string;
  label: string;
  /** The outcome was picked from a list, not rolled; the chain says which. */
  picked?: true;
}

export interface ChainLink {
  id: string;
  /** The randomizer's name, or the outcome's own label when it is gone. */
  name: string;
  /** The outcome that opened it; empty at the root, which nothing opened. */
  from: string;
  /** False when the library no longer has it; it opens all the same. */
  found: boolean;
  /** The outcome that opened it was picked from a list rather than rolled. */
  picked?: true;
}

export interface ChainAdvance {
  links: ChainLink[];
  /** Why the chain did not grow, in the words the screen shows. */
  note: string | null;
}

export type ChainSlot = "full" | "icon";

/** The randomizer this outcome sends you to, when it sends you anywhere. */
export function chainTarget(r: Randomizer, outcome: Outcome): ChainTarget | null {
  if (r.type !== "list" || outcome.itemIndex === undefined) return null;
  const item = r.items[outcome.itemIndex];
  return item?.goesTo ? { id: item.goesTo, label: item.label, ...(outcome.picked ? { picked: true as const } : {}) } : null;
}

/**
 * The chain after the randomizer at `from` has rolled.
 *
 * @param look  the library: what a target id resolves to, or null if it is gone
 */
export function advanceChain(
  links: readonly ChainLink[],
  from: number,
  target: ChainTarget | null,
  look: (id: string) => { name: string } | null,
): ChainAdvance {
  // Rolling a randomizer again answers its question again, so whatever its last
  // answer opened leaves the chain. At the root that is all of it.
  const kept = links.slice(0, from + 1);
  if (!target) return { links: kept, note: null };

  const already = kept.find((link) => link.id === target.id);
  if (already) {
    // Following it would show the same randomizer twice and lead straight back
    // here, so the chain stops and says why.
    return { links: kept, note: `${already.name} is already open here, so the chain stops rather than going round again.` };
  }

  const found = look(target.id);
  return {
    links: [...kept, {
      id: target.id,
      name: found?.name ?? target.label,
      from: target.label,
      found: found !== null,
      ...(target.picked ? { picked: true as const } : {}),
    }],
    note: null,
  };
}

/** Which links are full size and which are icons, with `focus` full size. */
export function chainPlacement(count: number, focus: number): ChainSlot[] {
  const at = Math.min(Math.max(focus, 0), Math.max(count - 1, 0));
  // Full size is the randomizer in focus and the one that sent you to it: the
  // newest pair until an icon is clicked, and that icon's pair afterwards.
  return Array.from({ length: count }, (_, i) => (i <= at && i > at - CHAIN_FULL_SIZE ? "full" : "icon"));
}

/**
 * A link past the root: the line saying what sent you here, then its own cell
 * and Roll button, or, when the library no longer has it, a gap that still says
 * where the outcome meant to send you. Used by the play screen and boards alike.
 */
export function createChainSurface(
  link: ChainLink,
  sender: string,
  opts: { onLanded?: (outcome: Outcome) => void; onRoll?: () => void; clickToRoll?: boolean } = {},
): { el: HTMLElement; cell: CellView | null } {
  const from = h("p", { class: "faint chain-from", text: `${sender} ${link.picked ? "picked" : "rolled"} ${link.from}` });
  const found = state.library.findById(link.id)?.randomizer ?? null;
  if (!found) {
    // Like a board's gap: the outcome still comes up and still says where it meant
    // to send you.
    return {
      cell: null,
      el: h("div", { class: "chain-link cell cell-missing" },
        from,
        h("h3", { class: "cell-name", text: link.name }),
        h("p", { class: "faint", text: "This randomizer is not in your library any more. Import it again, or take the link off that outcome." }),
      ),
    };
  }
  // Its history row says what sent you here, so the two rolls read as one.
  const cell = createCell(found, { onLanded: opts.onLanded, onRoll: opts.onRoll, clickToRoll: opts.clickToRoll, from: { randomizerName: sender, label: link.from } });
  // A cell that is its own button needs no Roll under it.
  return { cell, el: h("div", { class: "chain-link" }, from, cell.el, opts.clickToRoll ? null : cellRollButton(cell, "primary chain-roll")) };
}

/** The play screen, as the chain needs to see it: its root link, and its card. */
export interface ChainRoot {
  /** The open randomizer's identity, asked for afresh because it can be swapped. */
  id(): string;
  name(): string;
  /** The play card. It is hidden when the root becomes an icon. */
  card: HTMLElement;
  /** Whether anything is open beside the card, and whether the card is gone. */
  layout(open: boolean, wide: boolean): void;
}

export interface ChainView {
  /** The icons for everything earlier in the chain. */
  strip: HTMLElement;
  /** The randomizers that are open at full size beside the play card. */
  open: HTMLElement;
  /** The line that says why a chain stopped. */
  note: HTMLElement;
  /** Back to the root alone: the play screen swapped what it is showing. */
  reset(): void;
  /** Roll the newest randomizer the chain has open. False when there is none. */
  rollNewest(): boolean;
  /**
   * The randomizers on this screen because of the chain, root first, full
   * size or icon, that the library still has: whose rolls the screen shows.
   */
  present(): { id: string; name: string }[];
  destroy(): void;
}

export function createChainRow(root: ChainRoot): ChainView {
  const strip = h("div", { class: "chain-strip" });
  const open = h("div", { class: "chain-open" });
  const note = h("p", { class: "chain-note warning" });

  let links: ChainLink[] = [];
  /** Per link, in step with `links`. The root's surface is the play card. */
  let holders: (HTMLElement | null)[] = [];
  let cells: (CellView | null)[] = [];
  let answers: (string | null)[] = [];
  let focus = 0;
  let stopped: string | null = null;

  function reset(): void {
    links = [{ id: root.id(), name: root.name(), from: "", found: true }];
    holders = [null];
    cells = [null];
    answers = [null];
    focus = 0;
    stopped = null;
    render();
  }

  /** The surface for a link past the root: its own cell, or what is missing. */
  function build(i: number): void {
    const surface = createChainSurface(links[i], links[i - 1]?.name ?? "");
    cells[i] = surface.cell;
    holders[i] = surface.el;
  }

  function follow(from: number, target: ChainTarget | null): void {
    const advance = advanceChain(links, from, target, (id) => state.library.findById(id)?.randomizer ?? null);
    links = advance.links;
    stopped = advance.note;
    // Everything the rolled randomizer had opened is gone, surfaces and all:
    // a stale holder kept by index would show the previous chain's answer.
    holders.length = from + 1;
    cells.length = from + 1;
    answers.length = from + 1;
    for (let i = from + 1; i < links.length; i++) build(i);
    focus = links.length - 1;
    render();
  }

  function icon(link: ChainLink, i: number): HTMLElement {
    return h("button", {
      type: "button",
      class: "chain-icon",
      title: `Show ${link.name} at full size again`,
      onclick: () => { focus = i; render(); },
    },
      h("span", { class: "chain-icon-name", text: link.name }),
      h("span", { class: "chain-icon-answer", text: answers[i] ?? "not rolled" }),
    );
  }

  function render(): void {
    const places = chainPlacement(links.length, focus);
    setChildren(strip, ...links.map((link, i) => (places[i] === "icon" ? icon(link, i) : null)));
    strip.hidden = !places.includes("icon");
    setChildren(open, ...links.map((_, i) => (i > 0 && places[i] === "full" ? holders[i] : null)));
    root.card.hidden = places[0] !== "full";
    note.textContent = stopped ?? "";
    note.hidden = stopped === null;
    root.layout(open.children.length > 0, root.card.hidden);
  }

  /**
   * A roll can start from the play button, a link's own button, Space or a click
   * on the wheel, and every one ends in `state.record`; the chain watches for
   * recorded rolls rather than wrapping each way in.
   */
  let seen = state.lastOutcome;
  const unsubscribe = state.subscribe(() => {
    const last = state.lastOutcome;
    if (last === seen) return;
    seen = last;
    if (!last) return;
    const i = links.findIndex((link) => link.id === last.randomizer.id);
    if (i < 0) return;
    answers[i] = last.outcome.text;
    follow(i, chainTarget(last.randomizer, last.outcome));
  }, ["outcome"]);

  function rollNewest(): boolean {
    const places = chainPlacement(links.length, focus);
    for (let i = links.length - 1; i > 0; i--) {
      const cell = cells[i];
      if (places[i] === "full" && cell) {
        void cell.roll();
        return true;
      }
    }
    return false;
  }

  reset();

  return {
    strip,
    open,
    note,
    reset,
    rollNewest,
    present: () => links.filter((link) => link.found).map((link) => ({ id: link.id, name: link.name })),
    destroy() {
      unsubscribe();
    },
  };
}
