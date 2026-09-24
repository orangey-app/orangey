/**
 * Rolling any randomizer, in one place.
 *
 * The result is produced here, complete, before any animation starts
 * (decision D7) — the animation is only a way of arriving at it. That is what
 * lets "skip" be safe and what keeps the announced result and the drawn result
 * from ever disagreeing.
 */

import { flip } from "../core/coin.ts";
import { evaluate, expressionBounds, rollDice } from "../core/dice/evaluate.ts";
import { tryParse } from "../core/dice/grammar.ts";
import { formatResult, speakResult } from "../core/dice/format.ts";
import { drawNumbers, formatNumbers } from "../core/number.ts";
import { type RandomSource } from "../core/rng.ts";
import { drawWithoutReplacement, isRollable, pickWeightedIndex, rollableIndices, withoutDrawn } from "../core/weighted.ts";
import type { ListRandomizer, OutcomeReaction, Randomizer } from "../model/randomizer.ts";
import type { RollResult } from "../core/dice/evaluate.ts";

export interface Outcome {
  kind: Randomizer["type"];
  /** The headline: what goes in the big type. */
  text: string;
  /** Supporting detail: individual dice, the weight, the faces. */
  detail?: string;
  /** What a screen reader hears. */
  speak: string;
  seed?: string;
  /** For lists: which outcome came up. */
  itemIndex?: number;
  /** The picture the winning outcome carries, when it has one. */
  image?: string;
  dice?: RollResult;
  side?: 0 | 1;
  numbers?: number[];
  isMaximum?: boolean;
  isMinimum?: boolean;
  /** The game master tagged this outcome for Orangey (wheels and coins). */
  reaction?: OutcomeReaction;
  /** For a multiple draw: every outcome that came up, in list order positions. */
  indices?: number[];
}

export function rollRandomizer(r: Randomizer, rng: RandomSource): Outcome {
  switch (r.type) {
    case "board":
      // A board has no outcome of its own: the board screen rolls what is on
      // it, one randomizer at a time, and each records its own history row.
      throw new Error("a board is rolled one randomizer at a time");
    case "list":
      return rollList(r, rng);
    case "dice": {
      const result = rollDice(r.expression, rng);
      return {
        kind: "dice",
        text: String(result.total),
        detail: formatResult(result),
        speak: speakResult(result),
        seed: rng.seed,
        dice: result,
        isMaximum: result.isMaximum,
        isMinimum: result.isMinimum,
      };
    }
    case "coin": {
      const result = flip(r.faces, rng);
      return {
        kind: "coin",
        text: result.face,
        speak: `${r.name}: ${result.face}.`,
        seed: rng.seed,
        side: result.side,
        reaction: r.faceReactions?.[result.side] ?? undefined,
      };
    }
    case "number": {
      const result = drawNumbers(r, rng);
      const text = formatNumbers(result);
      return {
        kind: "number",
        text,
        detail: `${r.count > 1 ? `${r.count} numbers` : "one number"} between ${r.min} and ${r.max}`,
        speak: `${r.name}: ${text}.`,
        seed: rng.seed,
        numbers: result.values,
        isMaximum: result.isMaximum,
        isMinimum: result.isMinimum,
      };
    }
  }
}

/** `{2d4}` in an outcome's text. Braces are required, so nothing else is touched. */
const INLINE_DICE = /\{([^{}]{1,60})\}/g;

/**
 * Roll the dice written into an outcome's text.
 *
 * "{2d4} wolves" should arrive at the table as "3 wolves". The braces are the
 * whole of the opt-in: without them, "a d20 system" and "2d6 × 10 gp" are
 * prose that happens to mention dice, and rolling those would be a surprise.
 * Anything inside braces that does not parse is left exactly as typed, so a
 * typo shows itself rather than vanishing.
 *
 * Drawn from the same source as the pick, and only ever after it (P12): a
 * seeded session replays if and only if the draws happen in the same order.
 */
function expandInlineDice(text: string, rng: RandomSource, rolled: string[]): string {
  return text.replace(INLINE_DICE, (whole, expression: string) => {
    const parsed = tryParse(expression);
    if (!parsed.ok) return whole;
    const result = evaluate(parsed.expression, rng, expression);
    rolled.push(formatResult(result));
    return String(result.total);
  });
}

function rollList(r: ListRandomizer, rng: RandomSource): Outcome {
  const index = pickWeightedIndex(r.items, rng);
  const item = r.items[index];
  const total = r.items.reduce((a, i) => a + (i.disabled || i.weight <= 0 ? 0 : i.weight), 0);
  const percent = total > 0 ? (item.weight / total) * 100 : 0;
  const pct = `${percent.toFixed(percent < 10 ? 1 : 0)}%`;
  // After the pick, never before it.
  const rolled: string[] = [];
  const label = expandInlineDice(item.label, rng, rolled);
  const description = item.description ? expandInlineDice(item.description, rng, rolled) : undefined;
  const parts = [...rolled, description, pct].filter(Boolean);
  return {
    kind: "list",
    text: label,
    detail: parts.join(" · "),
    speak: `${r.name}: ${label}. Probability ${pct}.`,
    seed: rng.seed,
    itemIndex: index,
    image: item.image,
    reaction: item.reaction,
  };
}

/**
 * Several outcomes from one list in one press.
 *
 * "Roll six wandering monsters" is one roll with six answers, not six rolls:
 * one history row, one landing, one line of text. There is no `itemIndex`,
 * so nothing chains, no picture shows and no tagged reaction fires — those
 * are all about a single winning outcome, and there is no single winner here.
 *
 * A bag draws without putting back and stops when the bag runs out; an
 * ordinary list can repeat itself, which is what "with replacement" means.
 */
export function rollListMany(r: ListRandomizer, n: number, rng: RandomSource, drawn?: ReadonlySet<string>): Outcome {
  const bag = r.withoutReplacement === true;
  const pool = bag && drawn ? withoutDrawn(r.items, drawn) : r.items;
  const wanted = Math.max(1, Math.min(20, Math.trunc(n)));

  const indices: number[] = bag
    ? drawWithoutReplacement(pool, Math.min(wanted, rollableIndices(pool).length), rng)
    : Array.from({ length: wanted }, () => pickWeightedIndex(pool, rng));

  const rolled: string[] = [];
  const labels = indices.map((i) => expandInlineDice(r.items[i].label, rng, rolled));
  const text = labels.join(", ");
  return {
    kind: "list",
    text,
    detail: `${labels.length} outcome${labels.length === 1 ? "" : "s"}`,
    speak: `${r.name}: ${text}.`,
    seed: rng.seed,
    // Deliberately no itemIndex, image or reaction: see above.
    indices,
  };
}

export function whyCannotRoll(r: Randomizer, drawn?: ReadonlySet<string>): string | null {
  if (r.type === "board") return r.entries.length ? null : "This board has nothing on it yet.";
  if (r.type !== "list") return null;
  if (r.items.length === 0) return "This randomizer has no outcomes yet.";
  if (!r.items.some(isRollable)) {
    return "No outcomes can come up: they are all disabled or weigh nothing.";
  }
  // An empty bag is its own answer: everything is still here, it has just
  // all been drawn, and the way out is Refill rather than editing anything.
  if (r.withoutReplacement && drawn && !withoutDrawn(r.items, drawn).some(isRollable)) {
    return "The bag is empty. Refill it to draw again.";
  }
  return null;
}

/**
 * The longest text this randomizer could ever put in the result panel.
 *
 * The panel reserves its height from this once, when the randomizer loads, so
 * that no roll ever changes the layout — we know every outcome in advance, so
 * there is no reason to discover the height one roll at a time. It is an upper
 * bound, not a prediction: dice report their widest total, a number draw its
 * widest row, a list its longest label.
 */
/** A label with every rollable `{expr}` at its maximum. */
function widestLabel(label: string): string {
  return label.replace(INLINE_DICE, (whole, expression: string) => {
    try {
      return String(expressionBounds(expression).max);
    } catch {
      return whole;
    }
  });
}

export function longestOutcome(r: Randomizer): string {
  const longest = (texts: string[]) => texts.reduce((a, b) => (b.length > a.length ? b : a), "");
  switch (r.type) {
    case "list": {
      // Disabled outcomes cannot come up, but enabling one must not resize
      // the panel, so every label counts. Dice written into a label are
      // measured at their largest, since that is the widest it can ever read.
      return longest(r.items.map((i) => widestLabel(i.label)));
    }
    case "coin":
      return longest([...r.faces]);
    case "number": {
      const width = (v: number) => (r.integer ? String(Math.trunc(v)) : v.toFixed(4).replace(/0+$/, "").replace(/\.$/, ""));
      const widest = longest([width(r.min), width(r.max)]);
      return Array.from({ length: Math.max(1, Math.min(r.count, 100)) }, () => widest).join(", ");
    }
    case "board":
      // Each cell on a board sizes its own panel from its own randomizer.
      return "";
    case "dice": {
      try {
        const bounds = expressionBounds(r.expression);
        const widest = longest([String(bounds.min), String(bounds.max)]);
        // An exploding roll has no ceiling, so `max` is a floor. One more
        // character is not a guarantee, but it stops the common case — a
        // single explosion — from resizing the panel.
        return bounds.openEnded ? `${widest}0` : widest;
      } catch {
        return r.expression;
      }
    }
  }
}
