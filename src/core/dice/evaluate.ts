/**
 * Evaluate a parsed dice expression against a RandomSource.
 *
 * Every die is recorded individually, kept or dropped, so the UI can show
 * "4d6kh3 → [6, 5, 2̶, 4] = 15" and a screen reader can say the same thing.
 */

import type { RandomSource } from "../rng.ts";
import type { DiceNode, Expression, Node, Term } from "./grammar.ts";
import { nodeText, parse } from "./grammar.ts";

export interface DieRoll {
  value: number;
  kept: boolean;
}

export interface TermResult {
  sign: 1 | -1;
  /** The term as written, canonically ("4d6kh3", "5"). */
  text: string;
  /** Present for dice terms only. */
  dice?: DieRoll[];
  sides?: number;
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
  /** True when every kept die on a single-die term showed its maximum. */
  isMaximum: boolean;
  isMinimum: boolean;
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

function evalNode(node: Node, rng: RandomSource): { value: number; dice?: DieRoll[]; sides?: number } {
  if (node.kind === "const") return { value: node.value };
  const values: number[] = [];
  for (let i = 0; i < node.count; i++) values.push(rng.int(1, node.sides));
  const kept = keepIndices(values, node);
  const dice = values.map((value, i) => ({ value, kept: kept[i] }));
  const value = dice.reduce((a, d) => a + (d.kept ? d.value : 0), 0);
  return { value, dice, sides: node.sides };
}

function boundsOf(node: Node): { min: number; max: number } {
  if (node.kind === "const") return { min: node.value, max: node.value };
  let n = node.count;
  if (node.keep) n = node.keep.mode[0] === "k" ? node.keep.n : node.count - node.keep.n;
  return { min: n, max: n * node.sides };
}

export function evaluate(expr: Expression, rng: RandomSource, input = expr.normalized): RollResult {
  const terms: TermResult[] = expr.terms.map((t: Term) => {
    const r = evalNode(t.node, rng);
    return {
      sign: t.sign,
      text: nodeText(t.node),
      dice: r.dice,
      sides: r.sides,
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
  const keptDice = terms.flatMap((t) => (t.dice ?? []).filter((d) => d.kept).map((d) => ({ d, sides: t.sides! })));
  const isMaximum = keptDice.length > 0 && keptDice.every(({ d, sides }) => d.value === sides);
  const isMinimum = keptDice.length > 0 && keptDice.every(({ d }) => d.value === 1);

  return { input, expression: expr.normalized, terms, total, min, max, isMaximum, isMinimum, seed: rng.seed };
}

export function rollDice(input: string, rng: RandomSource): RollResult {
  return evaluate(parse(input), rng, input);
}
