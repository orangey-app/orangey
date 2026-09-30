/**
 * One roll, from the press to the landing, shared by the play screen, a board
 * cell and the editor's preview. The order is the contract: the result is
 * decided before the animation, nothing shows it until the landing, and it is
 * announced with the reveal, together with the mascot's reaction.
 *
 * The editor's preview rolls with `live: false`: no history, no mascot.
 */

import type { FeelSettings } from "./feel.ts";
import { motionScale, OFFER_FLIP_MS } from "./feel.ts";
import type { ListRandomizer, Rollable } from "../model/randomizer.ts";
import type { ResultPanel } from "./components/result.ts";
import type { WheelView } from "./components/wheel.ts";
import type { DiceTray } from "./components/dice.ts";
import type { CoinView } from "./components/coin.ts";
import type { InkblotView } from "./components/inkblot.ts";
import { chosenFromOffer, offerFromList, pickedOutcome, rollListMany, rollRandomizer, whyCannotRoll, type Outcome } from "./roll.ts";
import { bagDrawn, bagTake } from "./bag.ts";
import { isRollable, withoutDrawn } from "../core/weighted.ts";
import { summarize } from "./mascot/events.ts";
import { state } from "./state.ts";
import type { RollOrigin } from "../storage/appdb.ts";

export interface RollerOptions {
  randomizer: () => Rollable;
  result: ResultPanel;
  wheel: () => WheelView | null;
  tray?: DiceTray;
  coin?: CoinView;
  inkblot?: InkblotView;
  /** The settings this roll animates with, effective overrides included. */
  feel: () => FeelSettings;
  /** Record in history and tell the mascot. The editor's preview passes false. */
  live: boolean;
  onStart?: (willAnimate: boolean) => void;
  onEnd?: () => void;
  /**
   * Told the outcome at the landing. A board uses it to follow a link from the
   * cell that actually rolled, since one randomizer can be in two cells.
   */
  onLanded?: (outcome: Outcome) => void;
  /** The roll whose outcome opened this randomizer, for its history row. */
  from?: RollOrigin;
  /** Told after an outcome has been taken out of the bag, so a view can redraw. */
  onBagChange?: () => void;
  /**
   * Roll behind the screen: the first press decides the outcome and shows nothing;
   * the second reveals it, and only then does it land and get recorded.
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
  /**
   * The player picks this outcome of a list: it lands as the answer, with no
   * draw. Nothing happens mid-roll, with cards or a hidden roll waiting, or
   * for an outcome that cannot come up (off, weightless, or out of the bag).
   */
  choose(itemIndex: number): Promise<void>;
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
   * Cards on the table: drawn already, but nothing lands, is announced or is
   * recorded until a pick.
   */
  let offered: { outcomes: Outcome[]; randomizer: ListRandomizer; bag: ReadonlySet<string> | null } | null = null;

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
    // One landing for the pick, like any roll: answer, announcement, mascot, history.
    await land(randomizer, chosenFromOffer(randomizer.name, outcomes, at), bag, false);
  }

  async function choose(itemIndex: number): Promise<void> {
    if (rolling || offered || held) return;
    const randomizer = opts.randomizer();
    if (randomizer.type !== "list") return;
    const item = randomizer.items[itemIndex];
    const bag = randomizer.withoutReplacement ? bagDrawn(randomizer.id) : null;
    if (!item || !isRollable(item) || bag?.has(item.id)) return;
    await land(randomizer, pickedOutcome(randomizer, itemIndex, state.source()), bag, false);
  }

  function skip(): void {
    opts.wheel()?.skip();
    opts.tray?.skip();
    opts.coin?.skip();
    opts.inkblot?.skip();
  }

  /** Whether this roll has anything to watch, which decides when to reveal. */
  function animates(randomizer: Rollable, outcome: Outcome, feel: FeelSettings): boolean {
    if (motionScale(feel.motion) === 0) return false;
    // A list shown as a list has nothing to animate, so it reveals at once.
    if (randomizer.type === "list") return opts.wheel() !== null && outcome.itemIndex !== undefined;
    if (randomizer.type === "dice") return opts.tray !== undefined && outcome.dice !== undefined;
    if (randomizer.type === "coin") return opts.coin !== undefined;
    if (randomizer.type === "inkblot") return opts.inkblot !== undefined;
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
    // Bag mode rolls against what is left in the bag; `withoutDrawn` only marks
    // items, so indices, colours and chain targets are unchanged.
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

    // An offer: several outcomes drawn at once for the player to pick from. A wheel
    // that offers is neither spun nor rolled several at a time.
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

    // Hidden: rolled, but nothing lands, is recorded or leaves the bag until the
    // reveal; leaving the screen throws it away.
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
   * The landing: the answer is shown and announced with the reveal, and the
   * mascot reacts, together and once. `animated` is false for the reveal of a
   * hidden roll, which shows the answer at once.
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
    } else if (randomizer.type === "inkblot" && opts.inkblot && outcome.blot !== undefined) {
      await opts.inkblot.show(outcome.blot, willAnimate ? feel : { ...feel, motion: "instant" });
    }

    if (willAnimate) opts.result.show(outcome);
    // Out of the bag at the landing, not at the start: a skipped roll still lands
    // and takes; a roll that never lands takes nothing.
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
    choose,
    discard() {
      held = null;
      offered = null;
    },
  };
}
