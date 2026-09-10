import type { RandomSource } from "./rng.ts";

export interface NumberSpec {
  min: number;
  max: number;
  integer: boolean;
  /** Only meaningful for non-integer draws; integers are always inclusive. */
  inclusiveMax: boolean;
  count: number;
  unique: boolean;
}

export interface NumberResult {
  values: number[];
  spec: NumberSpec;
  seed?: string;
  /**
   * Every value sits on the top (or bottom) of the range. Only whole-number
   * draws can do it: a decimal draw has no honest "highest" value.
   */
  isMaximum: boolean;
  isMinimum: boolean;
}

export class NumberSpecError extends Error {}

export function validateSpec(spec: NumberSpec): string | null {
  if (!Number.isFinite(spec.min) || !Number.isFinite(spec.max)) return "minimum and maximum must be numbers";
  if (spec.max < spec.min) return "the maximum must not be below the minimum";
  if (!Number.isInteger(spec.count) || spec.count < 1) return "how many must be a whole number of at least 1";
  if (spec.count > 1000) return "at most 1000 numbers at a time";
  if (spec.integer) {
    if (!Number.isInteger(spec.min) || !Number.isInteger(spec.max)) return "whole-number draws need whole-number bounds";
    const range = spec.max - spec.min + 1;
    if (spec.unique && spec.count > range) return `only ${range} whole numbers lie in that range`;
  } else if (spec.unique) {
    return "unique results need whole numbers";
  }
  return null;
}

/** Partial Fisher-Yates over the range: O(count), no rejection loop. */
function uniqueIntegers(min: number, max: number, count: number, rng: RandomSource): number[] {
  const range = max - min + 1;
  if (range <= 100000) {
    const pool = new Int32Array(range);
    for (let i = 0; i < range; i++) pool[i] = min + i;
    const out: number[] = [];
    for (let k = 0; k < count; k++) {
      const j = rng.int(k, range - 1);
      const tmp = pool[k];
      pool[k] = pool[j];
      pool[j] = tmp;
      out.push(pool[k]);
    }
    return out;
  }
  const seen = new Set<number>();
  const out: number[] = [];
  while (out.length < count) {
    const v = rng.int(min, max);
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

export function drawNumbers(spec: NumberSpec, rng: RandomSource): NumberResult {
  const problem = validateSpec(spec);
  if (problem) throw new NumberSpecError(problem);

  let values: number[];
  if (spec.integer) {
    values = spec.unique
      ? uniqueIntegers(spec.min, spec.max, spec.count, rng)
      : Array.from({ length: spec.count }, () => rng.int(spec.min, spec.max));
  } else {
    const span = spec.max - spec.min;
    values = Array.from({ length: spec.count }, () => {
      const f = rng.float();
      // float() is [0,1); to include the maximum we accept the exact endpoint
      // only when the draw lands in the top ulp-sized slice, which keeps the
      // distribution uniform rather than doubling the endpoint's chance.
      const t = spec.inclusiveMax ? f * (1 + Number.EPSILON) : f;
      return spec.min + Math.min(t, 1) * span;
    });
  }
  return { values, spec, seed: rng.seed, ...extremesOf(values, spec) };
}

/** Whether a draw is as high, or as low, as its range allows. */
export function extremesOf(values: number[], spec: NumberSpec): { isMaximum: boolean; isMinimum: boolean } {
  if (!spec.integer || values.length === 0) return { isMaximum: false, isMinimum: false };
  return {
    isMaximum: values.every((v) => v === spec.max),
    isMinimum: values.every((v) => v === spec.min),
  };
}

export function formatNumbers(r: NumberResult): string {
  const fmt = (v: number) => (r.spec.integer ? String(v) : v.toFixed(4).replace(/0+$/, "").replace(/\.$/, ""));
  return r.values.map(fmt).join(", ");
}
