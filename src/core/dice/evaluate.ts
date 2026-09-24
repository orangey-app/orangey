/**
 * Evaluate a parsed dice expression against a RandomSource.
 *
 * Every die is recorded individually, kept or dropped, so the UI can show
 * "4d6kh3 → [6, 5, 2̶, 4] = 15" and a screen reader can say the same thing.
 */

import type { RandomSource } from "../rng.ts";
import type { DiceNode, Expression, Node, Term } from "./grammar.ts";
import { EXPLODE_CAP, REROLL_CAP, facesOf, matchesCmp, nodeText, parse } from "./grammar.ts";

export interface DieRoll {
  value: number;
  kept: boolean;
  /** Thrown away by a reroll; shown, like a dropped die, but not counted. */
  rerolled?: boolean;
  /** Drawn because a die came up on its top face. */
  exploded?: boolean;
  /** For a success pool: did this kept die meet the target? */
  success?: boolean;
}

export interface TermResult {
  sign: 1 | -1;
  /** The term as written, canonically ("4d6kh3", "5"). */
  text: string;
  /** Present for dice terms only. */
  dice?: DieRoll[];
  sides?: number;
  /**
   * The lowest and highest a kept die can finally show.
   *
   * Not simply 1 and `sides`: Fate dice run -1 to +1, and an unlimited
   * reroll means the faces it rerolls can never be the final value. The tray
   * paints its highs and lows from these, which is why they travel with the
   * result rather than being worked out again downstream.
   */
  faceMin?: number;
  faceMax?: number;
  fate?: boolean;
  /** This term counts successes rather than adding faces up. */
  successes?: boolean;
  /** Sum of kept dice, or the constant. Always non-negative; sign is separate. */
  value: number;
  /** Signed contribution to the total. */
  subtotal: number;
}

export interface RollResult {
  /** What the user typed. */
  input: string;
  /** Canonical form. */
  expression: string;
  terms: TermResult[];
  total: number;
  /** Theoretical bounds, for tests and for "natural 20" style highlighting. */
  min: number;
  max: number;
  /** True when every kept die in the whole roll showed its highest face. */
  isMaximum: boolean;
  isMinimum: boolean;
  /** Something in here explodes, so `max` is a floor rather than a ceiling. */
  openEnded: boolean;
  seed?: string;
}

function keepIndices(values: number[], node: DiceNode): boolean[] {
  const kept = values.map(() => true);
  if (!node.keep) return kept;
  const order = values.map((v, i) => ({ v, i }));
  const { mode, n } = node.keep;
  // Sort descending for "high" modes, ascending for "low" ones. Ties break by
  // index so the display order of equal dice is stable.
  const high = mode === "kh" || mode === "dh";
  order.sort((a, b) => (high ? b.v - a.v : a.v - b.v) || a.i - b.i);
  if (mode === "kh" || mode === "kl") {
    for (let k = n; k < order.length; k++) kept[order[k].i] = false;
  } else {
    for (let k = 0; k < n; k++) kept[order[k].i] = false;
  }
  return kept;
}

/** One face of this die, in the numbers a player reads. */
function drawFace(node: DiceNode, rng: RandomSource): number {
  return node.fate ? rng.int(1, 3) - 2 : rng.int(1, node.sides);
}

/** The highest face, which is what an exploding die explodes on. */
function topFace(node: DiceNode): number {
  return node.fate ? 1 : node.sides;
}

/**
 * The lowest and highest a die of this node can finally come to rest on.
 *
 * An unlimited reroll removes faces from the possible outcomes entirely: a
 * `d6r1` can never end on a 1, so its floor is 2. `ro` rerolls once, so the
 * rerolled face can still come back and the range is unchanged.
 */
function faceRange(node: DiceNode): { min: number; max: number } {
  const faces = facesOf(node);
  const live = node.reroll && !node.reroll.once
    ? faces.filter((f) => !matchesCmp(f, node.reroll!.cmp, node.reroll!.n))
    : faces;
  const usable = live.length ? live : faces;
  return { min: Math.min(...usable), max: Math.max(...usable) };
}

function evalNode(node: Node, rng: RandomSource): { value: number; dice?: DieRoll[]; sides?: number } {
  if (node.kind === "const") return { value: node.value };

  // 1. The original dice, left to right, exactly as they always were. An
  //    expression with no new modifiers must draw in precisely this order
  //    and stop here, or every seeded roll ever recorded changes.
  const dice: DieRoll[] = [];
  for (let i = 0; i < node.count; i++) dice.push({ value: drawFace(node, rng), kept: true });

  if (node.reroll || node.explode) {
    const top = topFace(node);
    let added = 0;
    // A queue, not a loop over a fixed array: an exploded die joins the end
    // and is then treated like any other, so it can reroll and explode too.
    for (let i = 0; i < dice.length; i++) {
      const die = dice[i];
      if (node.reroll) {
        let rerolls = 0;
        while (
          matchesCmp(die.value, node.reroll.cmp, node.reroll.n) &&
          rerolls < REROLL_CAP &&
          !(node.reroll.once && rerolls >= 1)
        ) {
          // The face that was thrown away stays visible, the way a dropped
          // die does: what happened at the table is part of the answer.
          dice.splice(i, 0, { value: die.value, kept: false, rerolled: true, exploded: die.exploded });
          i++;
          die.value = drawFace(node, rng);
          rerolls++;
        }
      }
      if (node.explode && die.value === top && added < EXPLODE_CAP) {
        added++;
        dice.push({ value: drawFace(node, rng), kept: true, exploded: true });
      }
    }
  }

  // 4. Keep and drop see only the dice that are still in play.
  const live = dice.filter((d) => !d.rerolled);
  const kept = keepIndices(live.map((d) => d.value), node);
  live.forEach((d, i) => {
    d.kept = kept[i];
  });

  // 5. A success pool counts rather than adds.
  let value: number;
  if (node.success) {
    for (const d of live) {
      if (d.kept) d.success = matchesCmp(d.value, node.success.cmp, node.success.n);
    }
    value = live.reduce((a, d) => a + (d.kept && d.success ? 1 : 0), 0);
  } else {
    value = live.reduce((a, d) => a + (d.kept ? d.value : 0), 0);
  }
  return { value, dice, sides: node.sides };
}

function boundsOf(node: Node): { min: number; max: number } {
  if (node.kind === "const") return { min: node.value, max: node.value };
  let n = node.count;
  if (node.keep) n = node.keep.mode[0] === "k" ? node.keep.n : node.count - node.keep.n;
  // A success pool is a count of dice, whatever the faces say.
  if (node.success) return { min: 0, max: n };
  // Explosions are deliberately not in `max`: there is no ceiling, and a
  // made-up one would be worse than none. `openEnded` says so instead.
  const face = faceRange(node);
  return { min: n * face.min, max: n * face.max };
}

/**
 * The lowest and highest an expression can come to, without rolling it.
 *
 * Reserving the result panel's height needs the widest number that can turn
 * up, which used to be found by rolling the expression once on a throwaway
 * seeded source and reading the bounds off the result. That worked, but it
 * meant a roll happened to answer a layout question.
 */
export function expressionBounds(input: string): { min: number; max: number; openEnded: boolean } {
  let min = 0;
  let max = 0;
  const expr = parse(input);
  const openEnded = expr.terms.some((t) => t.node.kind === "dice" && t.node.explode === true);
  for (const t of expr.terms) {
    const b = boundsOf(t.node);
    if (t.sign > 0) {
      min += b.min;
      max += b.max;
    } else {
      min -= b.max;
      max -= b.min;
    }
  }
  return { min, max, openEnded };
}

export function evaluate(expr: Expression, rng: RandomSource, input = expr.normalized): RollResult {
  const terms: TermResult[] = expr.terms.map((t: Term) => {
    const r = evalNode(t.node, rng);
    const node = t.node.kind === "dice" ? t.node : null;
    const face = node ? faceRange(node) : null;
    return {
      sign: t.sign,
      text: nodeText(t.node),
      dice: r.dice,
      sides: r.sides,
      faceMin: face?.min,
      faceMax: face?.max,
      fate: node?.fate,
      successes: node?.success !== undefined,
      value: r.value,
      subtotal: t.sign * r.value,
    };
  });

  let min = 0;
  let max = 0;
  for (const t of expr.terms) {
    const b = boundsOf(t.node);
    if (t.sign > 0) {
      min += b.min;
      max += b.max;
    } else {
      min -= b.max;
      max -= b.min;
    }
  }

  const total = terms.reduce((a, t) => a + t.subtotal, 0);
  const openEnded = expr.terms.some((t) => t.node.kind === "dice" && t.node.explode === true);

  /**
   * An extreme is "every kept die showed its face", term by term, and every
   * dice term has to agree.
   *
   * Exploded dice are left out of the maximum: they only exist because a die
   * already showed its top face, so counting them would make a maximum
   * harder to reach the better you rolled.
   */
  const diceTerms = terms.filter((t) => t.dice && t.dice.length);
  const extreme = (pick: (t: TermResult) => boolean) => diceTerms.length > 0 && diceTerms.every(pick);
  const isMaximum = extreme((t) => {
    const kept = t.dice!.filter((d) => d.kept);
    if (!kept.length) return false;
    if (t.successes) return kept.every((d) => d.success === true);
    const original = kept.filter((d) => !d.exploded);
    return original.length > 0 && original.every((d) => d.value === t.faceMax);
  });
  const isMinimum = extreme((t) => {
    const kept = t.dice!.filter((d) => d.kept);
    if (!kept.length) return false;
    if (t.successes) return kept.every((d) => d.success !== true);
    return kept.every((d) => d.value === t.faceMin);
  });

  return { input, expression: expr.normalized, terms, total, min, max, isMaximum, isMinimum, openEnded, seed: rng.seed };
}

export function rollDice(input: string, rng: RandomSource): RollResult {
  return evaluate(parse(input), rng, input);
}
