/**
 * One randomizer on a board: its own wheel, dice or coin, its own result, and
 * its own Feel settings, in a cell small enough that several fit on a screen.
 *
 * It is the play screen's surface without the furniture — no presets, no link
 * dialog, no history panel — because a board carries those once for all of its
 * cells rather than once per cell.
 */

import type { Randomizer, Rollable } from "../../model/randomizer.ts";
import { h } from "../dom.ts";
import { state } from "../state.ts";
import { createWheel } from "./wheel.ts";
import { createDiceTray } from "./dice.ts";
import { createCoin } from "./coin.ts";
import { createResultPanel } from "./result.ts";
import { longestOutcome } from "../roll.ts";
import { createRoller } from "../rolling.ts";
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

export function createCell(randomizer: Randomizer, opts: { onRoll?: () => void } = {}): CellView {
  const result = createResultPanel("Ready");
  const stage = h("div", { class: "stage cell-stage" });
  const tray = createDiceTray();
  const coin = createCoin();
  let wheel: ReturnType<typeof createWheel> | null = null;

  if (randomizer.type === "list" && randomizer.view === "wheel") {
    wheel = createWheel({
      items: () => (randomizer as Extract<Randomizer, { type: "list" }>).items,
      id: () => randomizer.id,
      onActivate: () => void roller.roll(),
      size: 260,
    });
    stage.append(wheel.el);
  } else if (randomizer.type === "dice") {
    stage.append(tray.el);
  } else if (randomizer.type === "coin") {
    stage.append(coin.el);
  }
  result.reserve(longestOutcome(randomizer));

  const feelNow = () => effectiveFeel(state.prefs.feel, randomizer.feel, state.prefs.animationsOff);

  const roller = createRoller({
    randomizer: () => randomizer as Rollable,
    result,
    wheel: () => wheel,
    tray,
    coin,
    feel: feelNow,
    live: true,
    onStart: () => opts.onRoll?.(),
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

/** A cell for a randomizer the board points at but the library no longer has. */
export function createMissingCell(name: string): HTMLElement {
  return h("div", { class: "cell cell-missing" },
    h("h3", { class: "cell-name", text: name }),
    h("p", { class: "faint", text: "This randomizer is not in your library any more. Remove it from the board, or import it again." }),
  );
}
