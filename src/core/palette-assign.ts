/**
 * Assigning colours to outcomes (plan C8.3).
 *
 * Requirements, in priority order:
 *   1. two segments that touch never look alike — including the wrap-around
 *      pair, because a wheel is a cycle and the last slice touches the first;
 *   2. the assignment is stable, so the same wheel shows the same colours on
 *      every reload and a GM can say "the green one";
 *   3. it terminates for any number of outcomes, even far more than the pool
 *      holds, by relaxing the threshold rather than looping forever.
 *
 * An explicitly chosen colour always wins and is never moved.
 */

import {
  chroma,
  deltaE,
  hexToOklab,
  hexToRgb,
  hueDifference,
  rgbToOklab,
  simulateDeuteranopia,
  type Oklab,
} from "./color.ts";
import { hash32 } from "./rng.ts";

/**
 * Thresholds. T was set from the palette's own distance distribution: with a
 * muted pool the median pair sits near 0.18, so a bar of 0.15 rejects the
 * pairs that actually read as "the same colour twice" while still leaving
 * roughly two thirds of the pool available at every step. A higher bar looked
 * better on paper and forced the wheel to alternate between extremes.
 */
export const DEFAULT_THRESHOLDS = {
  /** Minimum OKLab distance between touching segments. */
  T: 0.15,
  /** Minimum hue separation (degrees) for two colourful neighbours... */
  hue: 25,
  /** ...unless their lightness differs by at least this much. */
  lightness: 0.12,
  /** Chroma below which a colour counts as neutral and the hue rule is moot. */
  neutralChroma: 0.04,
  /** Distance required after simulating deuteranopia, as a fraction of T. */
  cvdFactor: 0.6,
  /** Soft rule: do not reuse a colour within this many segments. */
  recentWindow: 6,
} as const;

export type Thresholds = typeof DEFAULT_THRESHOLDS;

export interface ColorCandidate {
  hex: string;
  oklab: Oklab;
  chroma: number;
  /** OKLab of the deuteranopia-simulated colour. */
  cvd: Oklab;
}

export function toCandidate(hex: string): ColorCandidate {
  const oklab = hexToOklab(hex);
  return {
    hex,
    oklab,
    chroma: chroma(oklab),
    cvd: rgbToOklab(simulateDeuteranopia(hexToRgb(hex))),
  };
}

/**
 * Are these two safe to put side by side?
 *
 * Two colours pass when they are far enough apart overall AND, if both are
 * colourful, they differ clearly in hue or clearly in lightness — that second
 * clause is what rejects "two dark blues" that a plain distance check lets
 * through. The same test is then repeated through a deuteranopia simulation at
 * a lower bar, which is what stops a red/green pair that is obvious to most
 * people and identical to some.
 */
export function distinct(a: ColorCandidate, b: ColorCandidate, t: Thresholds = DEFAULT_THRESHOLDS, scale = 1): boolean {
  const T = t.T * scale;
  if (deltaE(a.oklab, b.oklab) < T) return false;
  if (a.chroma > t.neutralChroma && b.chroma > t.neutralChroma) {
    const hueOk = hueDifference(a.oklab, b.oklab) >= t.hue;
    const lightOk = Math.abs(a.oklab.L - b.oklab.L) >= t.lightness;
    if (!hueOk && !lightOk) return false;
  }
  if (deltaE(a.cvd, b.cvd) < T * t.cvdFactor) return false;
  return true;
}

export interface AssignInput {
  /** One entry per outcome, in wheel order. A string fixes that outcome's colour. */
  fixed: (string | null | undefined)[];
  /** Stable id of the randomizer; decides where in the pool the wheel starts. */
  id: string;
  /** The ordered candidate pool. */
  pool: ColorCandidate[];
  /** A wheel wraps; a plain list does not. */
  cyclic?: boolean;
  thresholds?: Thresholds;
}

export interface AssignResult {
  /** Hex colour per outcome, same length and order as `fixed`. */
  colors: string[];
  /** How far the threshold had to be relaxed: 1 means not at all. */
  scale: number;
  /** Neighbour pairs that still fail at the final scale, for the editor to flag. */
  clashes: [number, number][];
}

/**
 * Deterministic given (id, fixed colours, pool). Adding an outcome at the end
 * does not recolour the ones before it, because the walk is left to right and
 * only the new tail is affected.
 */
export function assignColors(input: AssignInput): AssignResult {
  const t = input.thresholds ?? DEFAULT_THRESHOLDS;
  const n = input.fixed.length;
  const pool = input.pool;
  const cyclic = input.cyclic ?? true;
  if (n === 0) return { colors: [], scale: 1, clashes: [] };
  if (pool.length === 0) throw new Error("colour pool is empty");

  const offset = pool.length > 0 ? hash32(input.id) % pool.length : 0;
  const rotated = [...pool.slice(offset), ...pool.slice(0, offset)];

  for (const scale of [1, 0.8, 0.64, 0.5]) {
    const chosen: (ColorCandidate | null)[] = new Array(n).fill(null);
    let cursor = 0;
    let ok = true;

    for (let i = 0; i < n && ok; i++) {
      const fixedHex = input.fixed[i];
      if (fixedHex) {
        chosen[i] = toCandidate(fixedHex);
        continue;
      }
      const neighbours: ColorCandidate[] = [];
      if (i > 0 && chosen[i - 1]) neighbours.push(chosen[i - 1]!);
      // Look ahead to a fixed colour so we do not paint ourselves into a corner.
      if (i + 1 < n && input.fixed[i + 1]) neighbours.push(toCandidate(input.fixed[i + 1]!));
      if (cyclic && i === n - 1 && chosen[0]) neighbours.push(chosen[0]!);

      const recent = new Set<string>();
      for (let k = Math.max(0, i - t.recentWindow); k < i; k++) {
        if (chosen[k]) recent.add(chosen[k]!.hex);
      }

      let picked: ColorCandidate | null = null;
      // Two passes: first honouring the "not seen recently" soft rule, then
      // without it. The hard neighbour rule applies in both.
      for (const honourRecent of [true, false]) {
        for (let step = 0; step < rotated.length; step++) {
          const c = rotated[(cursor + step) % rotated.length];
          if (honourRecent && recent.has(c.hex)) continue;
          if (neighbours.every((nb) => distinct(c, nb, t, scale))) {
            picked = c;
            cursor = (cursor + step + 1) % rotated.length;
            break;
          }
        }
        if (picked) break;
      }
      if (!picked) ok = false;
      else chosen[i] = picked;
    }

    if (ok) {
      const colors = chosen.map((c) => c!.hex);
      return { colors, scale, clashes: findClashes(colors, cyclic, t, scale) };
    }
  }

  // Last resort: never fail, take the locally best colour at each step.
  const chosen: ColorCandidate[] = [];
  for (let i = 0; i < n; i++) {
    const fixedHex = input.fixed[i];
    if (fixedHex) {
      chosen.push(toCandidate(fixedHex));
      continue;
    }
    const prev = chosen[i - 1];
    let best = rotated[0];
    let bestScore = -1;
    for (const c of rotated) {
      const score = prev ? deltaE(c.oklab, prev.oklab) : 1;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    chosen.push(best);
  }
  const colors = chosen.map((c) => c.hex);
  return { colors, scale: 0.5, clashes: findClashes(colors, cyclic, t, 0.5) };
}

export function findClashes(colors: string[], cyclic: boolean, t = DEFAULT_THRESHOLDS, scale = 1): [number, number][] {
  const cands = colors.map(toCandidate);
  const out: [number, number][] = [];
  const last = cyclic ? colors.length : colors.length - 1;
  for (let i = 0; i < last; i++) {
    const j = (i + 1) % colors.length;
    if (i === j) continue;
    if (!distinct(cands[i], cands[j], t, scale)) out.push([i, j]);
  }
  return out;
}
