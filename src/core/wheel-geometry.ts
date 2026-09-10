/**
 * Wheel geometry: weights in, arcs out (plan C4).
 *
 * Angles are degrees measured clockwise from twelve o'clock, because that is
 * where the pointer sits and it makes the spin maths readable. The wheel
 * rotates; the pointer never moves.
 */

import type { RandomSource } from "./rng.ts";
import { isRollable, normalize, type Weighted } from "./weighted.ts";

export interface Segment {
  /** Index into the original outcome array. */
  index: number;
  startAngle: number;
  endAngle: number;
  midAngle: number;
  /** Fraction of the wheel, 0..1. */
  share: number;
}

export interface LayoutOptions {
  /** Gap between segments, in degrees, taken out of each segment's span. */
  padAngle?: number;
  /** Where the first segment starts; 0 is twelve o'clock. */
  startAngle?: number;
}

/**
 * One segment per rollable outcome, in list order. Disabled outcomes and
 * zero-weight outcomes take no space at all — the remaining segments simply
 * grow to fill the wheel.
 */
export function layout(items: readonly Weighted[], opts: LayoutOptions = {}): Segment[] {
  const pad = opts.padAngle ?? 0.25;
  const shares = normalize(items);
  const live: number[] = [];
  for (let i = 0; i < items.length; i++) if (isRollable(items[i])) live.push(i);
  if (live.length === 0) return [];

  // With one live outcome a gap would leave a visible seam in a full circle.
  const usePad = live.length > 1 ? pad : 0;
  let angle = opts.startAngle ?? 0;
  const out: Segment[] = [];
  for (const index of live) {
    const span = shares[index] * 360;
    const start = angle + usePad / 2;
    const end = angle + span - usePad / 2;
    out.push({ index, startAngle: start, endAngle: end, midAngle: (start + end) / 2, share: shares[index] });
    angle += span;
  }
  return out;
}

const rad = (deg: number) => ((deg - 90) * Math.PI) / 180;

export function pointOnCircle(cx: number, cy: number, r: number, deg: number): [number, number] {
  return [cx + r * Math.cos(rad(deg)), cy + r * Math.sin(rad(deg))];
}

/**
 * SVG path for an annular segment. `inner` of 0 gives a pie slice.
 * A segment spanning the whole circle is drawn as two arcs, because a single
 * 360° arc collapses to nothing in SVG.
 */
export function arcPath(seg: Segment, cx: number, cy: number, outer: number, inner = 0): string {
  const span = seg.endAngle - seg.startAngle;
  if (span >= 359.999) {
    const p = (r: number) => `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.001} ${cy - r} Z`;
    return inner > 0 ? `${p(outer)} ${p(inner)}` : p(outer);
  }
  const large = span > 180 ? 1 : 0;
  const [x1, y1] = pointOnCircle(cx, cy, outer, seg.startAngle);
  const [x2, y2] = pointOnCircle(cx, cy, outer, seg.endAngle);
  if (inner <= 0) {
    return `M ${cx} ${cy} L ${x1} ${y1} A ${outer} ${outer} 0 ${large} 1 ${x2} ${y2} Z`;
  }
  const [x3, y3] = pointOnCircle(cx, cy, inner, seg.endAngle);
  const [x4, y4] = pointOnCircle(cx, cy, inner, seg.startAngle);
  return `M ${x1} ${y1} A ${outer} ${outer} 0 ${large} 1 ${x2} ${y2} L ${x3} ${y3} A ${inner} ${inner} 0 ${large} 0 ${x4} ${y4} Z`;
}

export interface SpinPlan {
  /** Total clockwise rotation of the wheel, in degrees. */
  rotation: number;
  /** Where inside the segment the pointer will land, for the test to check. */
  landingAngle: number;
  segment: Segment;
}

/**
 * Plan a spin that ends with the pointer inside `segment`.
 *
 * The result is decided before this is called (decision D7); all this does is
 * choose a pleasant-looking way to arrive there. The landing point is drawn
 * uniformly within the segment but kept clear of both edges, so the pointer
 * never appears to sit exactly on a boundary — which looks like a bug even
 * when it is not.
 */
export function planSpin(
  segment: Segment,
  rng: RandomSource,
  opts: { turns?: number; currentRotation?: number; edgeMargin?: number } = {},
): SpinPlan {
  const turns = Math.max(0, Math.round(opts.turns ?? 6));
  const margin = opts.edgeMargin ?? 0.06;
  const span = segment.endAngle - segment.startAngle;
  const inset = span * margin;
  const landing = segment.startAngle + inset + rng.float() * Math.max(0, span - 2 * inset);

  const current = opts.currentRotation ?? 0;
  // Rotation that brings `landing` under the pointer, then whole turns on top,
  // always forwards from where the wheel is now.
  const base = ((-landing - current) % 360 + 360) % 360;
  return { rotation: current + base + turns * 360, landingAngle: landing, segment };
}

/** Which segment is under the pointer at a given rotation. For tests. */
export function segmentAtPointer(segments: readonly Segment[], rotation: number): Segment | null {
  const at = ((-rotation % 360) + 360) % 360;
  for (const s of segments) {
    const start = ((s.startAngle % 360) + 360) % 360;
    const end = start + (s.endAngle - s.startAngle);
    if ((at >= start && at <= end) || (at + 360 >= start && at + 360 <= end)) return s;
  }
  return null;
}
