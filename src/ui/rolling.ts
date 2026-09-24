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
import { rollListMany, rollRandomizer, whyCannotRoll, type Outcome } from "./roll.ts";
import { bagDrawn, bagTake } from "./bag.ts";
import { withoutDrawn } from "../core/weighted.ts";
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
  /** Told after an outcome has been taken out of the bag, so a view can redraw. */
  onBagChange?: () => void;
  /**
   * Roll behind the screen: decide the outcome, show nothing, and wait.
   *
   * A game master with the wheel on a projector needs to know what came up
   * before the table does. The first press rolls and says only that it has;
   * the second reveals, and only then does anything land or get recorded.
   */
  hidden?: () => boolean;
  /** How many outcomes one press draws. Lists only; 1 everywhere else. */
  count?: () => number;
  /** The roll is held, waiting to be revealed. */
  onHeld?: () => void;
}

export interface Roller {
  roll(): Promise<void>;
  skip(): void;
  readonly rolling: boolean;
  /** A hidden roll is waiting to be revealed. */
  readonly holding: boolean;
  /** Throw away an unrevealed roll — leaving the screen does this. */
  discard(): void;
}

export function createRoller(opts: RollerOptions): Roller {
  let rolling = false;
  /** A hidden roll that has happened but has not been shown yet. */
  let held: { outcome: Outcome; randomizer: Rollable; bag: ReadonlySet<string> | null } | null = null;

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
    // A second press after a hidden roll means "show the table".
    if (held) {
      const { outcome, randomizer: what, bag } = held;
      held = null;
      await land(what, outcome, bag, false);
      return;
    }
    const randomizer = opts.randomizer();
    // Bag mode: the roll is made against what is still in the bag, and the
    // list as a whole is left alone — `withoutDrawn` only marks, so every
    // index, colour and chain target still points where it did.
    const bag = randomizer.type === "list" && randomizer.withoutReplacement ? bagDrawn(randomizer.id) : null;
    const rollable = bag && randomizer.type === "list"
      ? { ...randomizer, items: withoutDrawn(randomizer.items, bag) }
      : randomizer;

    const problem = whyCannotRoll(randomizer, bag ?? undefined);
    if (problem) {
      opts.result.clear(problem);
      if (opts.live) state.tell({ type: "roll:fail", source: randomizer.type, reason: problem });
      return;
    }

    let outcome: Outcome;
    try {
      const many = Math.max(1, Math.trunc(opts.count?.() ?? 1));
      outcome = many > 1 && rollable.type === "list"
        ? rollListMany(rollable, many, state.source(), bag ?? undefined)
        : rollRandomizer(rollable, state.source());
    } catch (e) {
      const reason = (e as Error).message;
      opts.result.clear(reason);
      if (opts.live) state.tell({ type: "roll:fail", source: randomizer.type, reason });
      return;
    }

    // Hidden: it has been rolled, and that is all anybody may know yet.
    // Nothing lands, nothing is recorded, the bag keeps its outcome, and
    // navigating away without revealing throws the roll away.
    if (opts.hidden?.()) {
      held = { outcome, randomizer, bag };
      opts.result.pending("Rolled. Press Reveal.");
      opts.onHeld?.();
      return;
    }

    rolling = true;
    await land(randomizer, outcome, bag, true);
  }

  /**
   * The landing, in the order the whole app depends on (P8): the answer, the
   * announcement and the mascot's reaction together, once, at the end.
   *
   * `animated` is false for a reveal: the table has been waiting already, so
   * the answer arrives at once rather than after another spin.
   */
  async function land(
    randomizer: Rollable,
    outcome: Outcome,
    bag: ReadonlySet<string> | null,
    animated: boolean,
  ): Promise<void> {
    const feel = opts.feel();
    const willAnimate = animated && animates(randomizer, outcome, feel);
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
      await wheel.spinTo(outcome.itemIndex, willAnimate ? feel : { ...feel, motion: "instant" });
    } else if (randomizer.type === "dice" && opts.tray && outcome.dice) {
      await opts.tray.show(outcome.dice, willAnimate ? feel : { ...feel, motion: "instant" });
    } else if (randomizer.type === "coin" && opts.coin) {
      await opts.coin.show(outcome.text, willAnimate ? feel : { ...feel, motion: "instant" });
    }

    if (willAnimate) opts.result.show(outcome);
    // Out of the bag at the landing, never at the start: a skipped roll still
    // lands, so it still takes, and a roll that never arrived never did.
    if (bag && randomizer.type === "list") {
      const taken = outcome.indices ?? (outcome.itemIndex !== undefined ? [outcome.itemIndex] : []);
      for (const at of taken) bagTake(randomizer.id, randomizer.items[at].id);
      if (taken.length) opts.onBagChange?.();
    }
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
    get holding() {
      return held !== null;
    },
    discard() {
      held = null;
    },
  };
}
