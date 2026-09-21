/**
 * A chain of randomizers: an outcome that sends you to another one.
 *
 * An encounter table whose worst result says "roll on the treasure table" is
 * why this exists. The outcome carries `goesTo`, and when it comes up that
 * randomizer opens beside the wheel that sent you there — and waits. It does
 * not roll itself: the table decides when the second roll happens, the way it
 * would pick up a second set of dice.
 *
 * Only the two newest stay full size. A third opens and the first becomes an
 * icon in the strip above, carrying its name and the answer it gave, because
 * three wheels across a laptop are three wheels nobody can read. Clicking an
 * icon brings that one back.
 *
 * The rule is `advanceChain` and `chainPlacement`, which know nothing about
 * the DOM. What is full size, what is an icon, what a chain does when it
 * arrives somewhere it has already been, and what it does when the randomizer
 * an outcome points at has been deleted are all questions a test can ask
 * directly rather than by clicking.
 */

import type { Randomizer } from "../../model/randomizer.ts";
import { button, h, setChildren } from "../dom.ts";
import { state } from "../state.ts";
import type { Outcome } from "../roll.ts";
import { createCell, type CellView } from "./cell.ts";

/** How many randomizers in a chain keep their full size. The rest are icons. */
export const CHAIN_FULL_SIZE = 2;

/** Where an outcome points, and what that outcome was called on the wheel. */
export interface ChainTarget {
  id: string;
  label: string;
}

export interface ChainLink {
  id: string;
  /** The randomizer's name, or the outcome's own label when it is gone. */
  name: string;
  /** The outcome that opened it; empty at the root, which nothing opened. */
  from: string;
  /** false when the library no longer has it: it opens all the same. */
  found: boolean;
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
  return item?.goesTo ? { id: item.goesTo, label: item.label } : null;
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
  // Rolling a randomizer again answers its question again, so whatever its
  // last answer had opened is no longer part of the chain. At the root that
  // is all of it: a fresh spin of the wheel starts a fresh chain.
  const kept = links.slice(0, from + 1);
  if (!target) return { links: kept, note: null };

  const already = kept.find((link) => link.id === target.id);
  if (already) {
    // Following it would put the same randomizer on screen twice and lead
    // straight back here. Saying so is more use than a chain that circles.
    return { links: kept, note: `${already.name} is already open here, so the chain stops rather than going round again.` };
  }

  const found = look(target.id);
  return {
    links: [...kept, { id: target.id, name: found?.name ?? target.label, from: target.label, found: found !== null }],
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
    const link = links[i];
    const sender = links[i - 1]?.name ?? "";
    const from = h("p", { class: "faint chain-from", text: `${sender} rolled ${link.from}` });
    const found = state.library.findById(link.id)?.randomizer ?? null;
    if (!found) {
      // The same tone as a board's gap: the outcome still comes up and still
      // says where it meant to send you.
      cells[i] = null;
      holders[i] = h("div", { class: "chain-link cell cell-missing" },
        from,
        h("h3", { class: "cell-name", text: link.name }),
        h("p", { class: "faint", text: "This randomizer is not in your library any more. Import it again, or take the link off that outcome." }),
      );
      return;
    }
    const cell = createCell(found);
    cells[i] = cell;
    const rollThis = button("Roll", () => {
      // Pressing again while it is running means "get to the answer", which
      // is what the cell's own roll does with a roll already in flight.
      const skipping = cell.rolling;
      const done = cell.roll();
      if (skipping) return;
      rollThis.textContent = "Skip";
      void done.then(() => { rollThis.textContent = "Roll"; });
    }, { class: "primary chain-roll" });
    holders[i] = h("div", { class: "chain-link" }, from, cell.el, rollThis);
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
   * A roll can be started by the play screen's button, by a chain link's own,
   * by the space bar or by a click on the wheel itself, and every one of them
   * ends in `state.record`. The chain watches for the roll that was recorded
   * rather than wrapping the four ways of starting one.
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
  });

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
    destroy() {
      unsubscribe();
    },
  };
}
