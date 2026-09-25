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
import { motionScale, OFFER_FLIP_MS } from "./feel.ts";
import type { ListRandomizer, Rollable } from "../model/randomizer.ts";
import type { ResultPanel } from "./components/result.ts";
import type { WheelView } from "./components/wheel.ts";
import type { DiceTray } from "./components/dice.ts";
import type { CoinView } from "./components/coin.ts";
import { chosenFromOffer, offerFromList, rollListMany, rollRandomizer, whyCannotRoll, type Outcome } from "./roll.ts";
import { bagDrawn, bagTake } from "./bag.ts";
import { withoutDrawn } from "../core/weighted.ts";
import { summarize } from "./mascot/events.ts";
import { state } from "./state.ts";
import type { RollOrigin } from "../storage/appdb.ts";

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
  /**
   * Told the outcome at the landing, with the answer on screen. A board uses
   * it to follow an outcome's link from the cell that actually rolled — the
   * same randomizer can be on a board twice, once as an entry and once opened
   * by a chain, so "the last roll of this randomizer" cannot say which.
   */
  onLanded?: (outcome: Outcome) => void;
  /** The roll whose outcome opened this randomizer, for its history row. */
  from?: RollOrigin;
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
  /** An offer is on the table and waiting for a pick. */
  onChoosing?: () => void;
  /**
   * Whether the first card of an offer should take the keyboard. The play
   * screen says yes; a board cell only when the keyboard is already in it.
   */
  focusOffer?: () => boolean;
}

export interface Roller {
  roll(): Promise<void>;
  skip(): void;
  readonly rolling: boolean;
  /** A hidden roll is waiting to be revealed. */
  readonly holding: boolean;
  /** Throw away an unrevealed roll or an unpicked offer — leaving the screen does this. */
  discard(): void;
  /** Cards are on the table and nothing has been picked. */
  readonly choosing: boolean;
  /** Take the card at this position; nothing happens when no offer is open. */
  pick(at: number): Promise<void>;
}

export function createRoller(opts: RollerOptions): Roller {
  let rolling = false;
  /**
   * A hidden roll that has happened but has not been shown yet: one outcome,
   * or the cards of an offer, face down.
   */
  let held:
    | { outcome: Outcome; offer?: undefined; randomizer: Rollable; bag: ReadonlySet<string> | null }
    | { outcome?: undefined; offer: Outcome[]; randomizer: ListRandomizer; bag: ReadonlySet<string> | null }
    | null = null;
  /**
   * Cards on the table. The draw is done (P8: decided before anything moves);
   * nothing lands, is announced as an answer, or is recorded until a pick.
   */
  let offered: { outcomes: Outcome[]; randomizer: ListRandomizer; bag: ReadonlySet<string> | null } | null = null;

  /** How long the cards take to turn over for this roll's feel. */
  const flipMs = () => OFFER_FLIP_MS * motionScale(opts.feel().motion);

  function lay(outcomes: Outcome[], faceDown: boolean): void {
    opts.result.offer(outcomes.map((o) => o.text), {
      onPick: (at) => void pick(at),
      prompt: faceDown ? "Rolled. Press Reveal." : "Choose one",
      faceDown,
      flipMs: flipMs(),
      focus: !faceDown && (opts.focusOffer?.() ?? false),
    });
  }

  async function pick(at: number): Promise<void> {
    if (!offered || !offered.outcomes[at]) return;
    const { outcomes, randomizer, bag } = offered;
    offered = null;
    opts.result.chose(at);
    // Once, through the ordinary landing: the answer, the announcement, the
    // mascot and the history row, as for any roll. The wheel stayed still
    // while the cards were out and now simply shows the pick.
    await land(randomizer, chosenFromOffer(randomizer.name, outcomes, at), bag, false);
  }

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
    // Cards are out: the next thing that happens is a pick, not a roll.
    if (offered) return;
    // A second press after a hidden roll means "show the table".
    if (held) {
      const was = held;
      held = null;
      if (was.offer) {
        offered = { outcomes: was.offer, randomizer: was.randomizer, bag: was.bag };
        lay(was.offer, false);
        opts.onChoosing?.();
        return;
      }
      await land(was.randomizer, was.outcome, was.bag, false);
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

    // Make a choice: several outcomes drawn at once, and the player picks.
    // A wheel that offers is not spun and is not rolled several at a time.
    if (rollable.type === "list" && randomizer.type === "list" && randomizer.offer !== undefined && randomizer.offer >= 2) {
      let outcomes: Outcome[];
      try {
        outcomes = offerFromList(rollable, randomizer.offer, state.source());
      } catch (e) {
        const reason = (e as Error).message;
        opts.result.clear(reason);
        if (opts.live) state.tell({ type: "roll:fail", source: randomizer.type, reason });
        return;
      }
      // One left in play is no choice: it lands like any roll, and says why.
      if (outcomes.length > 1) {
        if (opts.hidden?.()) {
          held = { offer: outcomes, randomizer, bag };
          lay(outcomes, true);
          opts.onHeld?.();
          return;
        }
        offered = { outcomes, randomizer, bag };
        lay(outcomes, false);
        opts.onChoosing?.();
        return;
      }
      const only = chosenFromOffer(randomizer.name, outcomes, 0);
      if (opts.hidden?.()) {
        held = { outcome: only, randomizer, bag };
        opts.result.pending("Rolled. Press Reveal.");
        opts.onHeld?.();
        return;
      }
      rolling = true;
      await land(randomizer, only, bag, true);
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
    opts.onLanded?.(outcome);
    if (opts.live) void state.record(randomizer, outcome, opts.from);
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
    get choosing() {
      return offered !== null;
    },
    pick,
    discard() {
      held = null;
      offered = null;
    },
  };
}
