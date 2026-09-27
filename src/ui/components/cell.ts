/**
 * One randomizer on a board: its own wheel, dice or coin, its own result, and
 * its own Feel settings, in a cell small enough that several fit on a screen.
 *
 * It is the play screen's surface without the furniture — no presets, no link
 * dialog, no history panel — because a board carries those once for all of its
 * cells rather than once per cell.
 */

import type { Randomizer, Rollable } from "../../model/randomizer.ts";
import { button, h } from "../dom.ts";
import { state } from "../state.ts";
import { createWheel } from "./wheel.ts";
import { createOutcomeList, type OutcomeListView } from "./outcomelist.ts";
import { canQuickEdit, openWeightEditor, saveOutcomeWeight } from "./quickweight.ts";
import { createDiceTray } from "./dice.ts";
import { createCoin } from "./coin.ts";
import { createResultPanel } from "./result.ts";
import { longestOutcome } from "../roll.ts";
import { createRoller } from "../rolling.ts";
import type { Outcome } from "../roll.ts";
import type { RollOrigin } from "../../storage/appdb.ts";
import { bagDrawn, bagLoad, bagRefill } from "../bag.ts";
import { isRollable, withoutDrawn } from "../../core/weighted.ts";
import { effectiveFeel } from "../feel.ts";

export interface CellView {
  el: HTMLElement;
  /** Roll this one. Resolves when it has landed. */
  roll(): Promise<void>;
  /** Jump a running roll to its landing. */
  skip(): void;
  readonly rolling: boolean;
  readonly randomizer: Randomizer;
  /**
   * Show this randomizer's newer version — a quick edit, or an edit made
   * elsewhere — keeping the answer on screen. False when it changed too much
   * to update in place (another type, wheel to list): build a new cell then.
   */
  update(next: Randomizer): boolean;
}

export function createCell(
  initial: Randomizer,
  opts: {
    onRoll?: () => void;
    onLanded?: (outcome: Outcome) => void;
    from?: RollOrigin;
    /**
     * The cell itself is the Roll button: a press anywhere on it rolls (and,
     * mid-roll, skips), and it takes the keyboard like a button. The pop-out
     * uses it, where a button's height is room the wheel could have.
     */
    clickToRoll?: boolean;
    /**
     * A double-tap on a slice edits its weight and saves the file (see
     * quickweight.ts). Only for a randomizer in the library.
     */
    quickEdit?: boolean;
  } = {},
): CellView {
  /** The randomizer as it stands now: `update` swaps in a newer version. */
  let randomizer = initial;
  const result = createResultPanel(opts.clickToRoll ? "Click to roll" : "Ready");
  const stage = h("div", { class: "stage cell-stage" });
  const tray = createDiceTray();
  const coin = createCoin();
  let wheel: ReturnType<typeof createWheel> | null = null;
  /**
   * A list shown as a list: its outcomes, each one a pick. A board cell used
   * to show nothing at all for one of these — only the answer under an empty
   * stage — so a list on a board could be rolled but never seen.
   */
  let outcomeList: OutcomeListView | null = null;
  /** The outcome the answer on screen came from, for putting the pointer back on it. */
  let answerIndex: number | null = null;
  const inPlay = () => {
    const r = randomizer as Extract<Randomizer, { type: "list" }>;
    return r.withoutReplacement ? withoutDrawn(r.items, bagDrawn(r.id)) : r.items;
  };

  if (randomizer.type === "list" && randomizer.view === "list") {
    outcomeList = createOutcomeList({ items: inPlay, onPick: (i) => void roller.choose(i), name: randomizer.name });
    stage.append(outcomeList.el);
  } else if (randomizer.type === "list" && randomizer.view === "wheel") {
    wheel = createWheel({
      items: inPlay,
      id: () => randomizer.id,
      onSliceEdit: opts.quickEdit && canQuickEdit(randomizer.id) ? (index, x, y) => quickEdit(index, x, y) : undefined,
      onActivate: () => void rollCell(),
      size: 260,
      slices: () => (randomizer as Extract<Randomizer, { type: "list" }>).slices,
      colours: () => state.wheelColours((randomizer as Extract<Randomizer, { type: "list" }>).palette),
    });
    stage.append(wheel.el);
  } else if (randomizer.type === "dice") {
    stage.append(tray.el);
  } else if (randomizer.type === "coin") {
    stage.append(coin.el);
  }
  const reserve = () => {
    const offer = randomizer.type === "list" && randomizer.offer !== undefined && randomizer.offer >= 2 ? randomizer.offer : 0;
    result.reserve(longestOutcome(randomizer), { offer });
  };
  reserve();

  /** A double-tap on a slice: its weight, edited on the wheel and saved. */
  function quickEdit(index: number, clientX: number, clientY: number): void {
    if (randomizer.type !== "list" || !wheel || roller.rolling) return;
    const item = randomizer.items[index];
    if (!item) return;
    openWeightEditor({
      host: wheel.el, clientX, clientY, label: item.label, weight: item.weight,
      onSave: (weight) => void saveOutcomeWeight(randomizer.id, item.id, weight).then((saved) => {
        if (saved) update(saved);
      }),
    });
  }

  function update(next: Randomizer): boolean {
    const shape = (r: Randomizer) => (r.type === "list" ? `list:${r.view}` : r.type);
    if (next.id !== randomizer.id || shape(next) !== shape(randomizer)) return false;
    randomizer = next;
    wheel?.refresh();
    // The slices changed size under a still pointer: turn the wheel back to
    // the answer on screen, at once, so the two never disagree.
    if (wheel && answerIndex !== null) void wheel.spinTo(answerIndex, { ...feelNow(), motion: "instant" });
    outcomeList?.refresh();
    reserve();
    updateBagLine();
    return true;
  }

  const feelNow = () => effectiveFeel(state.prefs.feel, randomizer.feel, state.prefs.animationsOff);

  /**
   * A bag's count and its Refill, as on the play screen. A board is where a
   * bag is most often played — one draw per scene, over an evening — so an
   * empty one must be refillable where it is, not only from its own screen.
   */
  const bagCount = h("span", { class: "faint bag-count" });
  const refillButton = button("Refill", () => {
    bagRefill(randomizer.id);
    result.clear();
    answerIndex = null;
    wheel?.refresh();
    outcomeList?.mark(null);
    outcomeList?.refresh();
    updateBagLine();
  }, { class: "ghost refill-bag" });
  const bagLine = h("div", { class: "row tight bag-line" }, bagCount, refillButton);
  bagLine.hidden = true;

  function updateBagLine(): void {
    if (randomizer.type !== "list" || !randomizer.withoutReplacement) return;
    const total = randomizer.items.filter(isRollable).length;
    const left = withoutDrawn(randomizer.items, bagDrawn(randomizer.id)).filter(isRollable).length;
    bagLine.hidden = false;
    bagCount.textContent = `${left} of ${total} left`;
    refillButton.hidden = left === total;
  }

  if (randomizer.type === "list" && randomizer.withoutReplacement) {
    void bagLoad(randomizer.id).then(() => {
      wheel?.refresh();
      outcomeList?.refresh();
      updateBagLine();
    });
  }

  const roller = createRoller({
    randomizer: () => randomizer as Rollable,
    result,
    wheel: () => wheel,
    tray,
    coin,
    feel: feelNow,
    live: true,
    onStart: () => opts.onRoll?.(),
    onLanded: (outcome) => {
      // A list shows what was drawn at once — there is no slice under a
      // pointer to vanish — and marks the answer, rolled or picked.
      answerIndex = outcome.itemIndex ?? null;
      outcomeList?.refresh();
      outcomeList?.mark(answerIndex);
      opts.onLanded?.(outcome);
    },
    from: opts.from,
    // The count changes at the landing; the wheel waits for the next roll, so
    // the winning slice does not vanish from under the pointer (as on the
    // play screen).
    onBagChange: () => updateBagLine(),
    // Several cells can offer at once after Roll all; the keyboard goes to a
    // cell's cards only when it was already in that cell.
    // Asked of the cell's own document: in a pop-out the keyboard is there.
    focusOffer: () => {
      const focused = el.ownerDocument.activeElement;
      return el.contains(focused) || (el.parentElement?.contains(focused) ?? false);
    },
  });

  /**
   * Every way of rolling a cell — its button, a click on its wheel, Roll all.
   * What was drawn last time leaves the wheel now, as the next roll starts,
   * as on the play screen; without it a cell's wheel kept every slice until
   * the page was reloaded.
   */
  function rollCell(): Promise<void> {
    wheel?.refresh();
    return roller.roll();
  }

  const el = h("div", { class: "cell", "data-randomizer": randomizer.id },
    h("h3", { class: "cell-name", text: randomizer.name }),
    stage,
    bagLine,
    result.el,
  );

  if (opts.clickToRoll) {
    el.classList.add("click-to-roll");
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", `Roll ${randomizer.name}`);
    // A button inside the cell — an offered card, Refill, a list's outcome —
    // is its own press, not a roll; and a wheel rolls from its hub only, so
    // its slices can take a double-tap (the hub calls `rollCell` itself).
    const own = (e: Event) => Boolean((e.target as Element | null)?.closest?.("button, input, select, textarea, a, .wheel-wrap, .weight-editor"));
    el.addEventListener("click", (e) => {
      if (!own(e)) void rollCell();
    });
    el.addEventListener("keydown", (e) => {
      if (own(e) || (e.key !== " " && e.key !== "Enter")) return;
      e.preventDefault();
      // Handled: the window's own Space would roll everything else too.
      e.stopPropagation();
      void rollCell();
    });
  }

  return {
    el,
    roll: rollCell,
    skip: () => roller.skip(),
    get rolling() { return roller.rolling; },
    get randomizer() { return randomizer; },
    update,
  };
}

/**
 * A Roll button for one cell. Pressing it again while the cell is running
 * means "get to the answer", which is what the cell's own roll does with a
 * roll already in flight.
 */
export function cellRollButton(cell: CellView, className: string): HTMLElement {
  const roll = button("Roll", () => {
    const skipping = cell.rolling;
    const done = cell.roll();
    if (skipping) return;
    roll.textContent = "Skip";
    void done.then(() => { roll.textContent = "Roll"; });
  }, { class: className });
  return roll;
}

/** A cell for a randomizer the board points at but the library no longer has. */
export function createMissingCell(name: string): HTMLElement {
  return h("div", { class: "cell cell-missing" },
    h("h3", { class: "cell-name", text: name }),
    h("p", { class: "faint", text: "This randomizer is not in your library any more. Remove it from the board, or import it again." }),
  );
}
