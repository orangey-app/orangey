/**
 * One randomizer on a board: its own wheel, dice or coin, its own result, and
 * its own Feel settings, in a cell small enough that several fit on a screen.
 *
 * It is the play screen's surface without the furniture — no presets, no link
 * dialog, no history panel — because a board carries those once for all of its
 * cells rather than once per cell.
 */

import type { Randomizer } from "../../model/randomizer.ts";
import { h } from "../dom.ts";
import { state } from "../state.ts";
import { createWheel } from "./wheel.ts";
import { createCoin, createDiceTray } from "./dice.ts";
import { createResultPanel } from "./result.ts";
import { longestOutcome, rollRandomizer, whyCannotRoll, type Outcome } from "../roll.ts";
import { summarize } from "../mascot/events.ts";
import { effectiveFeel, motionScale } from "../feel.ts";

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
  let rolling = false;
  const result = createResultPanel("Ready");
  const stage = h("div", { class: "stage cell-stage" });
  const tray = createDiceTray();
  const coin = createCoin();
  let wheel: ReturnType<typeof createWheel> | null = null;

  if (randomizer.type === "list" && randomizer.view === "wheel") {
    wheel = createWheel({
      items: () => (randomizer as Extract<Randomizer, { type: "list" }>).items,
      id: () => randomizer.id,
      onActivate: () => void roll(),
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

  async function roll(): Promise<void> {
    if (rolling) {
      skip();
      return;
    }
    const problem = whyCannotRoll(randomizer);
    if (problem) {
      result.clear(problem);
      state.tell({ type: "roll:fail", source: randomizer.type, reason: problem });
      return;
    }
    let outcome: Outcome;
    try {
      outcome = rollRandomizer(randomizer, state.source());
    } catch (e) {
      result.clear((e as Error).message);
      return;
    }
    const feel = feelNow();
    const animated =
      motionScale(feel.motion) !== 0 &&
      ((randomizer.type === "list" && wheel !== null && outcome.itemIndex !== undefined) ||
        (randomizer.type === "dice" && outcome.dice !== undefined) ||
        randomizer.type === "coin");

    rolling = true;
    opts.onRoll?.();
    if (animated) result.pending();
    else result.show(outcome);

    if (randomizer.type === "list" && wheel && outcome.itemIndex !== undefined) await wheel.spinTo(outcome.itemIndex, feel);
    else if (randomizer.type === "dice" && outcome.dice) await tray.show(outcome.dice, feel);
    else if (randomizer.type === "coin") await coin.show(outcome.text, feel);

    if (animated) result.show(outcome);
    // The landing, as on the play screen: the answer, the announcement and
    // Orangey's reaction all happen together, never at the start.
    state.tell({ type: "roll:land", source: randomizer.type, summary: summarize(outcome) });
    rolling = false;
    void state.record(randomizer, outcome);
  }

  function skip(): void {
    wheel?.skip();
    tray.skip();
    coin.skip();
  }

  const el = h("div", { class: "cell", "data-randomizer": randomizer.id },
    h("h3", { class: "cell-name", text: randomizer.name }),
    stage,
    result.el,
  );

  return {
    el,
    roll,
    skip,
    get rolling() { return rolling; },
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
