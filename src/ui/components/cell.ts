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
import { createDiceTray } from "./dice.ts";
import { createCoin } from "./coin.ts";
import { createResultPanel } from "./result.ts";
import { longestOutcome } from "../roll.ts";
import { createRoller } from "../rolling.ts";
import type { Outcome } from "../roll.ts";
import type { RollOrigin } from "../../storage/appdb.ts";
import { bagDrawn, bagLoad } from "../bag.ts";
import { withoutDrawn } from "../../core/weighted.ts";
import { effectiveFeel } from "../feel.ts";

export interface CellView {
  el: HTMLElement;
  /** Roll this one. Resolves when it has landed. */
  roll(): Promise<void>;
  /** Jump a running roll to its landing. */
  skip(): void;
  readonly rolling: boolean;
  readonly randomizer: Randomizer;
}

export function createCell(
  randomizer: Randomizer,
  opts: { onRoll?: () => void; onLanded?: (outcome: Outcome) => void; from?: RollOrigin } = {},
): CellView {
  const result = createResultPanel("Ready");
  const stage = h("div", { class: "stage cell-stage" });
  const tray = createDiceTray();
  const coin = createCoin();
  let wheel: ReturnType<typeof createWheel> | null = null;

  if (randomizer.type === "list" && randomizer.view === "wheel") {
    wheel = createWheel({
      items: () => {
        const r = randomizer as Extract<Randomizer, { type: "list" }>;
        return r.withoutReplacement ? withoutDrawn(r.items, bagDrawn(r.id)) : r.items;
      },
      id: () => randomizer.id,
      onActivate: () => void roller.roll(),
      size: 260,
      slices: () => (randomizer as Extract<Randomizer, { type: "list" }>).slices,
    });
    stage.append(wheel.el);
  } else if (randomizer.type === "dice") {
    stage.append(tray.el);
  } else if (randomizer.type === "coin") {
    stage.append(coin.el);
  }
  const offer = randomizer.type === "list" && randomizer.offer !== undefined && randomizer.offer >= 2 ? randomizer.offer : 0;
  result.reserve(longestOutcome(randomizer), { offer });

  const feelNow = () => effectiveFeel(state.prefs.feel, randomizer.feel, state.prefs.animationsOff);

  if (randomizer.type === "list" && randomizer.withoutReplacement) {
    void bagLoad(randomizer.id).then(() => wheel?.refresh());
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
    onLanded: (outcome) => opts.onLanded?.(outcome),
    from: opts.from,
    // Several cells can offer at once after Roll all; the keyboard goes to a
    // cell's cards only when it was already in that cell.
    focusOffer: () => el.contains(document.activeElement) || (el.parentElement?.contains(document.activeElement) ?? false),
  });

  const el = h("div", { class: "cell", "data-randomizer": randomizer.id },
    h("h3", { class: "cell-name", text: randomizer.name }),
    stage,
    result.el,
  );

  return {
    el,
    roll: () => roller.roll(),
    skip: () => roller.skip(),
    get rolling() { return roller.rolling; },
    get randomizer() { return randomizer; },
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
