/**
 * Assigning colours to outcomes (plan C8.3).
 *
 * Requirements, in priority order:
 *   1. two segments that touch never look alike — including the wrap-around
 *      pair, because a wheel is a cycle and the last slice touches the first;
 *   2. the assignment is stable, so the same wheel shows the same colours on
 *      every reload and a GM can say "the red one";
 *   3. it looks like a wheel people already know: primary colours in turn.
 *      (It used to be a hashed walk through a 71-colour pool, which read as
 *      random to anyone who had not seen it before.)
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

/**
 * The wheel's colours: red, yellow and blue in turn, the way a wheel at a
 * table or on a game show is painted, so a wheel reads as a wheel to anyone.
 * Green is the spare, for the one slice that cannot take its turn's colour.
 */
export const WHEEL_COLOURS = ["#e31f26", "#fcb315", "#006eb8"] as const;
export const WHEEL_SPARE = "#008842";

export interface WheelColours {
  /** Hex colour per outcome, same length and order as `fixed`. */
  colors: string[];
  /** Neighbour pairs that still look alike — only ever the user's own choices. */
  clashes: [number, number][];
}

/**
 * Colour every outcome that has no colour of its own.
 *
 * Slice i takes the cycle's colour for i. When that would look like a
 * neighbour — the last slice of a 4-, 7- or 10-outcome wheel meets the first,
 * which is also red, or the user has coloured a slice next to it — it takes
 * the spare instead, then either other cycle colour. Deterministic from the
 * positions alone: the same outcomes always get the same colours, and adding
 * one at the end recolours at most the last slice. A colour the user chose is
 * never moved; if two of those clash, the clash is reported, not hidden.
 */
export function assignWheelColours(fixed: (string | null | undefined)[], cyclic = true): WheelColours {
  const n = fixed.length;
  const chosen: string[] = [];
  for (let i = 0; i < n; i++) {
    const own = fixed[i];
    if (own) {
      chosen.push(own);
      continue;
    }
    const neighbours: ColorCandidate[] = [];
    if (i > 0) neighbours.push(toCandidate(chosen[i - 1]));
    if (i + 1 < n && fixed[i + 1]) neighbours.push(toCandidate(fixed[i + 1]!));
    if (cyclic && n > 2 && i === n - 1) neighbours.push(toCandidate(chosen[0]));
    const turn = WHEEL_COLOURS[i % WHEEL_COLOURS.length];
    const others = [1, 2].map((k) => WHEEL_COLOURS[(i + k) % WHEEL_COLOURS.length]);
    const pick = [turn, WHEEL_SPARE, ...others].find((hex) => neighbours.every((nb) => distinct(toCandidate(hex), nb)));
    chosen.push(pick ?? turn);
  }
  return { colors: chosen, clashes: findClashes(chosen, cyclic) };
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
