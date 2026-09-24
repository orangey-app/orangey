/**
 * One roll, from the press to the landing.
 *
 * The play screen, a cell on a board and the editor's preview all roll the
 * same way, and used to say so in three places that had already begun to
 * drift apart. The order here is the contract (plan C10): the outcome is
 * decided first, nothing shows it until the animation has arrived, and the
 * answer, the announcement and the mascot's reaction all happen together at
 * the landing — never at the start.
 *
 * A caller supplies only what it has. The editor's preview has a wheel and
 * no dice tray, and rolls with `live: false`, so it neither writes history
 * nor tells the mascot: a person trying out a wheel they are building has
 * not rolled it.
 */

import type { FeelSettings } from "./feel.ts";
import { motionScale } from "./feel.ts";
import type { Rollable } from "../model/randomizer.ts";
import type { ResultPanel } from "./components/result.ts";
import type { WheelView } from "./components/wheel.ts";
import type { DiceTray } from "./components/dice.ts";
import type { CoinView } from "./components/coin.ts";
import { rollRandomizer, whyCannotRoll, type Outcome } from "./roll.ts";
import { summarize } from "./mascot/events.ts";
import { state } from "./state.ts";

export interface RollerOptions {
  randomizer: () => Rollable;
  result: ResultPanel;
  wheel: () => WheelView | null;
  tray?: DiceTray;
  coin?: CoinView;
  /** The settings this roll animates with, effective overrides included. */
  feel: () => FeelSettings;
  /** Record in history and tell the mascot. The editor's preview passes false. */
  live: boolean;
  onStart?: (willAnimate: boolean) => void;
  onEnd?: () => void;
}

export interface Roller {
  roll(): Promise<void>;
  skip(): void;
  readonly rolling: boolean;
}

export function createRoller(opts: RollerOptions): Roller {
  let rolling = false;

  function skip(): void {
    opts.wheel()?.skip();
    opts.tray?.skip();
    opts.coin?.skip();
  }

  /** Whether this roll has anything to watch, which decides when to reveal. */
  function animates(randomizer: Rollable, outcome: Outcome, feel: FeelSettings): boolean {
    if (motionScale(feel.motion) === 0) return false;
    // A list shown as a list has nothing to animate, so it reveals at once.
    if (randomizer.type === "list") return opts.wheel() !== null && outcome.itemIndex !== undefined;
    if (randomizer.type === "dice") return opts.tray !== undefined && outcome.dice !== undefined;
    if (randomizer.type === "coin") return opts.coin !== undefined;
    return false;
  }

  async function roll(): Promise<void> {
    // A second press during a roll means "get on with it", not "roll again".
    if (rolling) {
      skip();
      return;
    }
    const randomizer = opts.randomizer();

    const problem = whyCannotRoll(randomizer);
    if (problem) {
      opts.result.clear(problem);
      if (opts.live) state.tell({ type: "roll:fail", source: randomizer.type, reason: problem });
      return;
    }

    let outcome: Outcome;
    try {
      outcome = rollRandomizer(randomizer, state.source());
    } catch (e) {
      const reason = (e as Error).message;
      opts.result.clear(reason);
      if (opts.live) state.tell({ type: "roll:fail", source: randomizer.type, reason });
      return;
    }

    const feel = opts.feel();
    const willAnimate = animates(randomizer, outcome, feel);
    rolling = true;
    opts.onStart?.(willAnimate);

    if (willAnimate) {
      opts.result.pending();
      if (opts.live) state.tell({ type: "roll:start", source: randomizer.type });
    } else {
      opts.result.show(outcome);
    }

    const wheel = opts.wheel();
    if (randomizer.type === "list" && wheel && outcome.itemIndex !== undefined) {
      await wheel.spinTo(outcome.itemIndex, feel);
    } else if (randomizer.type === "dice" && opts.tray && outcome.dice) {
      await opts.tray.show(outcome.dice, feel);
    } else if (randomizer.type === "coin" && opts.coin) {
      await opts.coin.show(outcome.text, feel);
    }

    if (willAnimate) opts.result.show(outcome);
    if (opts.live) state.tell({ type: "roll:land", source: randomizer.type, summary: summarize(outcome) });
    rolling = false;
    opts.onEnd?.();
    if (opts.live) void state.record(randomizer, outcome);
  }

  return {
    roll,
    skip,
    get rolling() {
      return rolling;
    },
  };
}
