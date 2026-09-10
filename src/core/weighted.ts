/**
 * Weighted selection over a list of outcomes.
 *
 * Weights are non-negative reals and the app normalizes them (decision D6), so
 * {50,30,20} and {5,3,2} behave identically. An outcome is excluded when it is
 * disabled or its weight is zero; `disabled` is a separate flag so that turning
 * an outcome off and on again restores its original weight exactly.
 */

import type { RandomSource } from "./rng.ts";

export interface Weighted {
  weight: number;
  disabled?: boolean;
}

export class NotRollableError extends Error {
  constructor(msg = "no outcome can come up") {
    super(msg);
    this.name = "NotRollableError";
  }
}

/** The single definition of "can this outcome come up". */
export function isRollable(item: Weighted): boolean {
  return !item.disabled && Number.isFinite(item.weight) && item.weight > 0;
}

export function isValidWeight(w: unknown): w is number {
  return typeof w === "number" && Number.isFinite(w) && w >= 0;
}

/** Indices of the outcomes that can come up, in list order. */
export function rollableIndices(items: readonly Weighted[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < items.length; i++) if (isRollable(items[i])) out.push(i);
  return out;
}

export function totalWeight(items: readonly Weighted[]): number {
  let t = 0;
  for (const it of items) if (isRollable(it)) t += it.weight;
  return t;
}

/**
 * Share of the total for each item, in list order. Non-rollable items get 0.
 * The shares of rollable items sum to 1 (up to floating point).
 */
export function normalize(items: readonly Weighted[]): number[] {
  const total = totalWeight(items);
  if (total <= 0) return items.map(() => 0);
  return items.map((it) => (isRollable(it) ? it.weight / total : 0));
}

/** Percentages rounded for display, guaranteed to read as summing to 100. */
export function displayPercents(items: readonly Weighted[], decimals = 1): number[] {
  const shares = normalize(items);
  const f = 10 ** decimals;
  const rounded = shares.map((s) => Math.round(s * 100 * f) / f);
  // Largest-remainder correction so the column does not read 99.9 %.
  const live = rollableIndices(items);
  if (live.length === 0) return rounded;
  const sum = live.reduce((a, i) => a + rounded[i], 0);
  const drift = Math.round((100 - sum) * f) / f;
  if (drift !== 0) {
    let biggest = live[0];
    for (const i of live) if (shares[i] > shares[biggest]) biggest = i;
    rounded[biggest] = Math.round((rounded[biggest] + drift) * f) / f;
  }
  return rounded;
}

/** Cumulative weights over the rollable items, for binary search. */
export interface CumulativeTable {
  /** Index into the original array for each entry. */
  indices: number[];
  /** Running totals, same length as indices; last entry is the total weight. */
  cumulative: number[];
  total: number;
}

export function buildCumulative(items: readonly Weighted[]): CumulativeTable {
  const indices: number[] = [];
  const cumulative: number[] = [];
  let running = 0;
  for (let i = 0; i < items.length; i++) {
    if (!isRollable(items[i])) continue;
    running += items[i].weight;
    indices.push(i);
    cumulative.push(running);
  }
  return { indices, cumulative, total: running };
}

/** Index of the first cumulative entry strictly greater than x. */
function upperBound(cumulative: readonly number[], x: number): number {
  let lo = 0;
  let hi = cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cumulative[mid] > x) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * Pick one outcome. Returns the index into the original array so callers can
 * keep their own item objects.
 */
export function pickWeightedIndex(items: readonly Weighted[], rng: RandomSource): number {
  const table = buildCumulative(items);
  if (table.total <= 0) throw new NotRollableError();
  return pickFromTable(table, rng);
}

export function pickFromTable(table: CumulativeTable, rng: RandomSource): number {
  if (table.total <= 0) throw new NotRollableError();
  const x = rng.float() * table.total;
  const at = upperBound(table.cumulative, x);
  return table.indices[at];
}

export function pickWeighted<T extends Weighted>(items: readonly T[], rng: RandomSource): T {
  return items[pickWeightedIndex(items, rng)];
}

/** Uniform pick over any array; used where weights do not apply. */
export function pick<T>(items: readonly T[], rng: RandomSource): T {
  if (items.length === 0) throw new NotRollableError("empty list");
  return items[rng.int(0, items.length - 1)];
}

/**
 * Draw `count` distinct outcomes without replacement (bag mode's core; also
 * used by "random order" in 0.2). Throws if fewer rollable outcomes exist.
 */
export function drawWithoutReplacement(
  items: readonly Weighted[],
  count: number,
  rng: RandomSource,
): number[] {
  const live = rollableIndices(items);
  if (count > live.length) {
    throw new NotRollableError(`asked for ${count} outcomes, only ${live.length} can come up`);
  }
  const pool = live.map((i) => ({ index: i, weight: items[i].weight }));
  const out: number[] = [];
  for (let k = 0; k < count; k++) {
    // pickFromTable returns a position in `pool`, not in `items`.
    const poolPos = pickFromTable(buildCumulative(pool), rng);
    out.push(pool[poolPos].index);
    pool.splice(poolPos, 1);
  }
  return out;
}
