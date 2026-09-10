/**
 * Wheel geometry: weights in, arcs out (plan C4).
 *
 * Angles are degrees measured clockwise from twelve o'clock. The pointer sits
 * at three o'clock, because labels are written along the radius, reading
 * outwards: whatever lands under a pointer on the right arrives horizontal and
 * reads left to right towards it. The wheel rotates; the pointer never moves.
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
    // A slice thinner than the gap would otherwise end before it starts; the
    // gap never takes more than half of it.
    const gap = Math.min(usePad, span / 2);
    const start = angle + gap / 2;
    const end = angle + span - gap / 2;
    out.push({ index, startAngle: start, endAngle: end, midAngle: (start + end) / 2, share: shares[index] });
    angle += span;
  }
  return out;
}

/** Where the pointer sits, in the same degrees as the segments: three o'clock. */
export const POINTER_ANGLE = 90;

/**
 * The most a winning label may lean away from horizontal when the wheel stops.
 * Only an outcome taking nearly half the wheel or more is affected: its
 * landing point is kept this close to the segment's middle, so the label under
 * the pointer never tips over past vertical.
 */
export const MAX_LANDING_TILT = 75;

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
 * when it is not — and within MAX_LANDING_TILT of the middle, so the winning
 * label arrives readable.
 */
export function planSpin(
  segment: Segment,
  rng: RandomSource,
  opts: { turns?: number; currentRotation?: number; edgeMargin?: number } = {},
): SpinPlan {
  const turns = Math.max(0, Math.round(opts.turns ?? 6));
  const margin = opts.edgeMargin ?? 0.06;
  const span = segment.endAngle - segment.startAngle;
  // Half the window the landing may fall in, measured from the middle: clear
  // of both edges, and never so far from the middle that the label tips over.
  const half = Math.min(span / 2 - span * margin, MAX_LANDING_TILT);
  const landing = segment.midAngle - half + rng.float() * Math.max(0, 2 * half);

  const current = opts.currentRotation ?? 0;
  // Rotation that brings `landing` under the pointer, then whole turns on top,
  // always forwards from where the wheel is now.
  const base = ((POINTER_ANGLE - landing - current) % 360 + 360) % 360;
  return { rotation: current + base + turns * 360, landingAngle: landing, segment };
}

/** Which segment is under the pointer at a given rotation. For tests. */
export function segmentAtPointer(segments: readonly Segment[], rotation: number): Segment | null {
  const at = (((POINTER_ANGLE - rotation) % 360) + 360) % 360;
  for (const s of segments) {
    const start = ((s.startAngle % 360) + 360) % 360;
    const end = start + (s.endAngle - s.startAngle);
    if ((at >= start && at <= end) || (at + 360 >= start && at + 360 <= end)) return s;
  }
  return null;
}

/** Room for one label written along a segment's radius. */
export interface RadialLabelRoom {
  fontSize: number;
  /** Where the text ends, next to the rim; it is anchored here and runs inwards. */
  outer: number;
  /** How far towards the hub the text may reach before the slice is too narrow for it. */
  inner: number;
  /** outer − inner: the most text the slice can carry, in viewBox units. */
  length: number;
}

/**
 * How much text a slice can carry along its radius.
 *
 * Along the radius the length is bounded by the wheel, not by the slice; the
 * slice only has to be as wide as the letters are tall. A slice narrows towards
 * the hub, so the text is anchored at the rim and may run inwards only as far
 * as the slice is still `lineHeight` × the font size wide. Returns null when not
 * even a few letters would fit — the list and the result panel name the slice
 * instead.
 */
export function radialLabelRoom(
  span: number,
  opts: { outer: number; hub: number; lineHeight?: number; minChars?: number },
): RadialLabelRoom | null {
  const lineHeight = opts.lineHeight ?? 1.15;
  const fontSize = span >= 40 ? 13 : span >= 20 ? 12 : span >= 12 ? 11 : span >= 8.5 ? 10 : 9;
  // Chord width of the slice at radius r is 2 r sin(span / 2); past a half
  // circle the slice is wider than its chord, so cap the half-angle at 90°.
  const halfSine = Math.sin((Math.min(span, 180) * Math.PI) / 360);
  const narrowest = halfSine > 0 ? (lineHeight * fontSize) / (2 * halfSine) : Infinity;
  const inner = Math.max(opts.hub, narrowest);
  const length = opts.outer - inner;
  // A rough average advance for a semibold sans is 0.6 em.
  if (length < (opts.minChars ?? 3) * 0.6 * fontSize) return null;
  return { fontSize, outer: opts.outer, inner, length };
}

/**
 * The longest start of `label` that fits in `width`, with an ellipsis when
 * anything had to go. `measure` returns a string's advance at the font in use.
 */
export function fitLabelToWidth(label: string, width: number, measure: (text: string) => number): string {
  if (measure(label) <= width) return label;
  const chars = Array.from(label);
  let lo = 0;
  let hi = chars.length;
  // Binary search on the kept prefix length; `lo` always fits.
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(`${chars.slice(0, mid).join("").trimEnd()}…`) <= width) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? "…" : `${chars.slice(0, lo).join("").trimEnd()}…`;
}
