/**
 * The springs under Orangey, and the field that bends his outline.
 *
 * Pure numbers, no DOM: this is what the unit tests exercise. The one rule
 * that matters more than any other is in the model: every spring's target is
 * zero in every state, so the resting shape is the drawing and the wobble is
 * a departure from it that always comes back.
 */

import { MASCOT_BASE_Y, MASCOT_CENTRE } from "./parts.ts";

export class MascotSpring {
  x = 0;
  v = 0;
  t = 0;
  lo: number | undefined;
  hi: number | undefined;
  k: number;
  c: number;

  constructor(k: number, c: number) {
    this.k = k;
    this.c = c;
  }

  step(dt: number): void {
    const a = -this.k * (this.x - this.t) - this.c * this.v;
    this.v += a * dt;
    this.x += this.v * dt;
    // A spring with no ceiling turns the fruit into a balloon.
    if (this.hi !== undefined && this.x > this.hi) {
      this.x = this.hi;
      if (this.v > 0) this.v = 0;
    }
    if (this.lo !== undefined && this.x < this.lo) {
      this.x = this.lo;
      if (this.v < 0) this.v = 0;
    }
  }

  kick(dv: number): void {
    this.v += dv;
  }

  clamp(lo: number, hi: number): this {
    this.lo = lo;
    this.hi = hi;
    return this;
  }

  set(x: number): this {
    this.x = x;
    this.t = x;
    this.v = 0;
    return this;
  }
}

/** The three body modes, each a scalar 0 at rest. */
export interface BodyModes {
  /** Squash (+) / stretch (−), about the feet. */
  squash: number;
  /** Lateral slosh: the top leans, the base stays. */
  slosh: number;
  /** A diagonal pinch — the ripple that says "not solid". */
  pinch: number;
}

/**
 * Where a point of the drawing goes under the current modes. Identity when
 * every mode is zero, which is the property the tests pin; the base row
 * (y = MASCOT_BASE_Y) never moves under squash, so the feet stay planted.
 */
export function mascotField(x: number, y: number, m: BodyModes, gain: number): [number, number] {
  const s = m.squash * gain;
  const l = m.slosh * gain;
  const p = m.pinch * gain;
  const xr = x - MASCOT_CENTRE.x;
  const yr = y - MASCOT_CENTRE.y;
  const sin2 = (2 * xr * yr) / (xr * xr + yr * yr + 1e-6);
  return [
    x + 0.55 * s * xr + l * (MASCOT_BASE_Y - y) * 0.055 + p * sin2 * xr * 0.35,
    y - s * (y - MASCOT_BASE_Y) + p * sin2 * yr * 0.35,
  ];
}
