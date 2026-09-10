/**
 * Rolling any randomizer, in one place.
 *
 * The result is produced here, complete, before any animation starts
 * (decision D7) — the animation is only a way of arriving at it. That is what
 * lets "skip" be safe and what keeps the announced result and the drawn result
 * from ever disagreeing.
 */

import { flip } from "../core/coin.ts";
import { rollDice } from "../core/dice/evaluate.ts";
import { formatResult, speakResult } from "../core/dice/format.ts";
import { drawNumbers, formatNumbers } from "../core/number.ts";
import type { RandomSource } from "../core/rng.ts";
import { pickWeightedIndex } from "../core/weighted.ts";
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
  dice?: RollResult;
  side?: 0 | 1;
  numbers?: number[];
  isMaximum?: boolean;
  isMinimum?: boolean;
  /** The game master tagged this outcome for Orangey (wheels and coins). */
  reaction?: OutcomeReaction;
}

export function rollRandomizer(r: Randomizer, rng: RandomSource): Outcome {
  switch (r.type) {
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

function rollList(r: ListRandomizer, rng: RandomSource): Outcome {
  const index = pickWeightedIndex(r.items, rng);
  const item = r.items[index];
  const total = r.items.reduce((a, i) => a + (i.disabled || i.weight <= 0 ? 0 : i.weight), 0);
  const percent = total > 0 ? (item.weight / total) * 100 : 0;
  const pct = `${percent.toFixed(percent < 10 ? 1 : 0)}%`;
  return {
    kind: "list",
    text: item.label,
    detail: item.description ? `${item.description} · ${pct}` : pct,
    speak: `${r.name}: ${item.label}. Probability ${pct}.`,
    seed: rng.seed,
    itemIndex: index,
    reaction: item.reaction,
  };
}

export function whyCannotRoll(r: Randomizer): string | null {
  if (r.type !== "list") return null;
  if (r.items.length === 0) return "This randomizer has no outcomes yet.";
  if (!r.items.some((i) => !i.disabled && i.weight > 0)) {
    return "No outcomes can come up: they are all disabled or weigh nothing.";
  }
  return null;
}
