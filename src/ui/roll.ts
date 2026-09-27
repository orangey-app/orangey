/**
 * Rolling any randomizer, in one place. The result is decided before the
 * animation, complete; the animation is only a way of arriving at it, which is
 * what makes skipping safe.
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
  /** For a multiple draw: every outcome that came up, as positions in the list. */
  indices?: number[];
  /**
   * Dice written into the outcome's text, as rolled: "2d4 [1, 2] = 3". Kept apart
   * from `detail` so history can keep just the dice.
   */
  rolled?: string[];
  /** For a pick from an offer: the outcomes it was chosen from, kept in history. */
  offered?: string[];
  /**
   * Chosen by the player, not rolled. History says so: a pick must never pass for
   * a random answer.
   */
  picked?: true;
}

export function rollRandomizer(r: Randomizer, rng: RandomSource): Outcome {
  switch (r.type) {
    case "board":
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
 * Roll the dice written into an outcome's text: "{2d4} wolves" → "3 wolves".
 * Only braces opt in, so prose like "2d6 × 10 gp" is untouched; anything in
 * braces that does not parse is left as typed.
 *
 * Draws from the same source, only ever after the pick: changing that order
 * breaks seeded rolls.
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
  return listOutcome(r, pickWeightedIndex(r.items, rng), rng);
}

/**
 * One outcome of a list once the pick is made, shared by a single roll and an
 * offer so both say the same thing. The only draws here are the dice in the text.
 */
function listOutcome(r: ListRandomizer, index: number, rng: RandomSource, picked = false): Outcome {
  const item = r.items[index];
  const total = r.items.reduce((a, i) => a + (i.disabled || i.weight <= 0 ? 0 : i.weight), 0);
  const percent = total > 0 ? (item.weight / total) * 100 : 0;
  const pct = `${percent.toFixed(percent < 10 ? 1 : 0)}%`;
  // After the pick, never before it (seeded rolls).
  const rolled: string[] = [];
  const label = expandInlineDice(item.label, rng, rolled);
  const description = item.description ? expandInlineDice(item.description, rng, rolled) : undefined;
  // A pick had no odds: saying "20%" under it would suggest it was rolled.
  const parts = [...rolled, description, picked ? "picked" : pct].filter(Boolean);
  return {
    kind: "list",
    text: label,
    detail: parts.join(" · "),
    speak: picked ? `${r.name}: ${label}, picked.` : `${r.name}: ${label}. Probability ${pct}.`,
    seed: rng.seed,
    itemIndex: index,
    image: item.image,
    reaction: item.reaction,
    ...(rolled.length ? { rolled } : {}),
  };
}

/**
 * Several outcomes from one list in one press: one roll with many answers, one
 * history row. With no single winner there is no `itemIndex`, so nothing chains,
 * no picture shows and no tagged reaction fires. A bag draws without putting
 * back and stops when it runs out.
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
    ...(rolled.length ? { rolled } : {}),
  };
}

/**
 * The outcome the player picked from a list shown as a list: the same shape as
 * a roll that landed there, with no draw behind it. Dice in its text still roll
 * from `rng`.
 */
export function pickedOutcome(r: ListRandomizer, index: number, rng: RandomSource): Outcome {
  return { ...listOutcome(r, index, rng, true), picked: true };
}

/**
 * Deal m different outcomes for the player to choose from, weighted and
 * without putting back. A path of its own, so no existing roll draws any
 * differently and seeded rolls still reproduce.
 */
export function offerFromList(r: ListRandomizer, m: number, rng: RandomSource): Outcome[] {
  const wanted = Math.max(1, Math.trunc(m));
  const indices = drawWithoutReplacement(r.items, Math.min(wanted, rollableIndices(r.items).length), rng);
  return indices.map((index) => listOutcome(r, index, rng));
}

/**
 * The outcome a player picked from an offer, ready to land: its own text,
 * picture and reaction, and a detail line that says what else was offered.
 */
export function chosenFromOffer(name: string, offer: readonly Outcome[], at: number): Outcome {
  const chosen = offer[at];
  const labels = offer.map((o) => o.text);
  const note = labels.length > 1 ? `chosen from ${labels.join(", ")}` : "the only one that could come up";
  // A single roll's detail ends with the outcome's odds, which say nothing
  // about a pick; the dice and the description before them still apply.
  const detail = chosen.detail ?? "";
  const cut = detail.lastIndexOf(" · ");
  const kept = cut < 0 ? "" : detail.slice(0, cut);
  return {
    ...chosen,
    detail: [kept, note].filter(Boolean).join(" · "),
    speak: `${name}: ${chosen.text}, ${note}.`,
    ...(labels.length > 1 ? { offered: labels } : {}),
  };
}

export function whyCannotRoll(r: Randomizer, drawn?: ReadonlySet<string>): string | null {
  if (r.type === "board") return r.entries.length ? null : "This board has nothing on it yet.";
  if (r.type !== "list") return null;
  if (r.items.length === 0) return "This randomizer has no outcomes yet.";
  if (!r.items.some(isRollable)) {
    return "No outcomes can come up: they are all disabled or weigh nothing.";
  }
  // An empty bag is its own answer: the way out is Refill, not editing.
  if (r.withoutReplacement && drawn && !withoutDrawn(r.items, drawn).some(isRollable)) {
    return "The bag is empty. Refill it to draw again.";
  }
  return null;
}

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
      // Every label counts, disabled ones too: the panel's height is reserved once
      // from the longest text, so neither a roll nor enabling an outcome resizes it.
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
        // Exploding dice have no ceiling; one more digit covers a single explosion.
        return bounds.openEnded ? `${widest}0` : widest;
      } catch {
        return r.expression;
      }
    }
  }
}
