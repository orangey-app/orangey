/**
 * Assigning colours to wheel outcomes.
 *
 * In priority order: touching segments never look alike (including the last
 * and the first, since a wheel is a cycle); the same wheel gets the same
 * colours on every reload; and it looks like a familiar wheel, primary colours
 * in turn. A colour the user chose always wins and is never moved.
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
 * T comes from the palette's own distance distribution: 0.15 rejects pairs that
 * read as the same colour twice while leaving most of the pool usable. A higher
 * bar forces the wheel to alternate between extremes.
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
 * Are these two safe to put side by side? They must be far apart in OKLab and,
 * if both are colourful, differ clearly in hue or lightness (a plain distance
 * check lets two dark blues through). The test is repeated at a lower bar
 * through a deuteranopia simulation to catch red/green pairs.
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
 * Red, yellow and blue in turn, like a painted prize wheel. Green is the spare,
 * for a slice that cannot take its turn's colour.
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
 * Slice i takes the cycle's colour for i. If that would look like a neighbour
 * (the last slice of a 4-, 7- or 10-slice wheel meets the first, or the user
 * coloured the slice next to it), it takes the spare, then either other cycle
 * colour. Deterministic from position alone, so adding an outcome at the end
 * recolours at most the last slice. User colours are never moved; clashes
 * between them are reported.
 */
export function assignWheelColours(
  fixed: (string | null | undefined)[],
  cyclic = true,
  // A custom theme or a wheel's own palette passes its own set: three in turn,
  // then the spare.
  colours: readonly string[] = [...WHEEL_COLOURS, WHEEL_SPARE],
): WheelColours {
  const cycle = colours.slice(0, 3);
  const spare = colours[3] ?? WHEEL_SPARE;
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
    const turn = cycle[i % cycle.length];
    const others = [1, 2].map((k) => cycle[(i + k) % cycle.length]);
    const pick = [turn, spare, ...others].find((hex) => neighbours.every((nb) => distinct(toCandidate(hex), nb)));
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
