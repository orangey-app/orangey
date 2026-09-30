/**
 * Inkblots: a symmetrical blot made the way a real one is. A few drops of ink
 * land on one half of a sheet, the sheet is folded, and the mirror image is
 * what you see.
 *
 * Everything about a blot follows from one whole number, its seed: where the
 * drops land, the tendrils, holes and spatter, the rare red or yellow, even
 * the grain. That matters because a blot is drawn more than once — the bloom
 * runs at a lower resolution than the final picture, and the download is
 * larger still — and all of them must be the same blot. So nothing here may
 * use Math.random, and nothing may depend on the size it is drawn at: the
 * shape is a continuous field in "blot units", only thresholded per pixel.
 *
 * No page code here (see ARCHITECTURE): this computes pixels into a plain
 * buffer, and ui/components/inkblot.ts puts them on a canvas.
 *
 * The settings were chosen by marking a few thousand random blots
 * (2026-09-29); users never see them.
 */

/** Width over height of the card a blot is drawn on. */
export const INK_ASPECT = 1.3;
/** Seeds run from 1 to this; the number is short enough to read out. */
export const INK_SEED_MAX = 999999;

/** The iso-level: the field is ink wherever it is above this. */
const INK_T = 0.5;
/** A lone kernel reaches INK_T at this fraction of its radius. */
const INK_ISO = Math.sqrt(1 - Math.sqrt(INK_T));
/** Blot units per half card height: a little margin around the ink. */
const INK_VIEW = 1.12;
/** The card's paper and the ink, in RGB. */
export const INK_PAPER: readonly [number, number, number] = [251, 248, 241];
const INK_INK: readonly [number, number, number] = [22, 19, 26];
const INK_RED: readonly [number, number, number] = [190, 38, 36];
const INK_YELLOW: readonly [number, number, number] = [226, 168, 28];
/** How much the tone varies: 0 would be flat ink. */
const INK_RANGE = 0.9;
/** The chance a blot carries red or yellow at all. */
const INK_COLOUR_CHANCE = 0.15;
/** Tries at a blot that stays on the card before settling for the last. */
const INK_VARIANTS = 4;

type InkNoise = (x: number, y: number) => number;

/** A small seeded generator for the blot's own draws (mulberry32). */
function inkRandom(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const INK_GX = [1, -1, 0, 0, 0.7071, -0.7071, 0.7071, -0.7071];
const INK_GY = [0, 0, 1, -1, 0.7071, 0.7071, -0.7071, -0.7071];

/** Seeded 2-D gradient noise, roughly −1 to 1. */
function inkNoise(seed: number): InkNoise {
  const r = inkRandom(seed);
  const b = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    const t = b[i];
    b[i] = b[j];
    b[j] = t;
  }
  const p = new Uint8Array(512);
  for (let i = 0; i < 512; i++) p[i] = b[i & 255];
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  return (x, y) => {
    const X = Math.floor(x), Y = Math.floor(y), xf = x - X, yf = y - Y, xi = X & 255, yi = Y & 255;
    const aa = p[p[xi] + yi] & 7, ab = p[p[xi] + yi + 1] & 7, ba = p[p[xi + 1] + yi] & 7, bb = p[p[xi + 1] + yi + 1] & 7;
    const u = fade(xf), v = fade(yf);
    const n00 = INK_GX[aa] * xf + INK_GY[aa] * yf, n10 = INK_GX[ba] * (xf - 1) + INK_GY[ba] * yf;
    const n01 = INK_GX[ab] * xf + INK_GY[ab] * (yf - 1), n11 = INK_GX[bb] * (xf - 1) + INK_GY[bb] * (yf - 1);
    const x1 = n00 + (n10 - n00) * u, x2 = n01 + (n11 - n01) * u;
    return (x1 + (x2 - x1) * v) * 1.45;
  };
}

const inkClamp = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Metaballs, flat x, y, radius²: each ball joined with its mirror image as
 * k1 + k2 − k1·k2 rather than summed, so a drop on the fold is not twice as dense.
 */
function inkBalls(K: readonly number[], x: number, y: number): number {
  let s = 0;
  for (let i = 0; i < K.length; i += 3) {
    const bx = K[i], R2 = K[i + 2], dy = y - K[i + 1], dy2 = dy * dy;
    let k1 = 0, k2 = 0, dx = x - bx, q = (dx * dx + dy2) / R2;
    if (q < 1) { const t = 1 - q; k1 = t * t; }
    if (bx > 1e-3) { dx = x + bx; q = (dx * dx + dy2) / R2; if (q < 1) { const t = 1 - q; k2 = t * t; } }
    s += k1 + k2 - k1 * k2;
  }
  return s;
}

interface InkHole { x: number; y: number; s: number; rx: number; ry: number }

/** Holes: elliptical kernels taken out of the ink (the deepest one wins), mirrored. */
function inkHoles(holes: readonly InkHole[], x: number, y: number): number {
  let s = 0;
  for (const h of holes) {
    for (const hx of h.x > 1e-3 ? [h.x, -h.x] : [h.x]) {
      const dx = (x - hx) / h.rx, dy = (y - h.y) / h.ry, q = dx * dx + dy * dy;
      if (q < 1) { const t = 1 - q, v = h.s * t * t; if (v > s) s = v; }
    }
  }
  return s;
}

/** The settings one blot is made with, drawn from its seed. */
export interface InkParams {
  /** true: tendrils pulled out of the body's edge; false: branching walkers. */
  warpOnly: boolean;
  warp: number;
  tendrils: number;
  reach: number;
  branch: number;
  wander: number;
  thickness: number;
  holes: number;
  sat: number;
  edge: "angle" | "rough" | "none";
}

/** The chosen ranges: 65% edge-pulled tendrils, 35% walkers. */
export function inkParams(seed: number, variant = 0): InkParams {
  const r = inkRandom((Math.imul(seed + variant * 1000003, 1597334677) ^ 0x3c6ef372) >>> 0);
  const u = (a: number, b: number) => a + (b - a) * r();
  const warpOnly = r() < 0.65;
  return {
    warpOnly,
    warp: warpOnly ? u(0.4, 1) : u(0, 1),
    tendrils: 2 + Math.floor(r() * 4),
    reach: u(0.3, 0.6),
    branch: u(0, 0.75),
    wander: u(0.3, 0.7),
    thickness: u(0.9, 1.8),
    holes: 0.2 * Math.pow(10, r()),
    sat: u(0, 0.5),
    edge: (["angle", "rough", "none"] as const)[Math.floor(r() * 3)],
  };
}

/** A blot's shape, before it is drawn at any size. */
export interface InkBlot {
  seed: number;
  params: InkParams;
  K: number[];
  KB: number[];
  holes: InkHole[];
  /** Walker stamps: x, y, radius², arrival time in the bloom (0 to 1). */
  S: number[];
  /** Spatter off the edge, laid out like S. */
  D: number[];
  /** Colour: x, y, radius², 0 red or 1 yellow. */
  C: number[];
  /** When each colour arrives in the bloom. */
  cArr: [number, number];
  warpN: InkNoise;
  roughN: InkNoise;
  grainN: InkNoise;
  poolN: InkNoise;
  angN: InkNoise;
}

/**
 * Build the blot for a seed. A variant other than 0 is a fallback draw from the
 * same seed, for a blot whose first form ran off the card (see inkResolve).
 */
export function inkBuild(seed: number, variant = 0): InkBlot {
  const P = inkParams(seed, variant);
  const g = seed + variant * 1000003;
  const rb = inkRandom((Math.imul(g, 2654435761) ^ 0x51ed27) >>> 0);

  // One to three drops, anywhere on the half-sheet and only now and then on the
  // fold; then smaller drops splashed off them.
  const balls: { x: number; y: number; r: number }[] = [];
  const ndrop = 1 + Math.floor(rb() * 3);
  for (let i = 0; i < ndrop; i++) {
    const onFold = rb() < 0.15;
    balls.push({ x: onFold ? rb() * 0.06 : 0.1 + rb() * 0.75, y: (rb() - 0.5) * 1.1, r: 0.14 + rb() * 0.14 });
  }
  const n = 3 + Math.floor(rb() * 4);
  for (let i = 0; i < n; i++) {
    const par = balls[Math.floor(rb() * balls.length)], r = 0.08 + rb() * 0.17, a = rb() * Math.PI * 2, d = (par.r + r) * (0.55 + rb() * 0.35);
    const x = Math.min(Math.abs(par.x + Math.cos(a) * d), 0.95);
    const y = Math.max(-0.78, Math.min(0.78, par.y + Math.sin(a) * d * 1.1));
    balls.push({ x, y, r });
  }
  // Fit the card: centred top to bottom, and shrunk if it would run off.
  let y0 = Infinity, y1 = -Infinity, x1 = 0;
  for (const q of balls) { y0 = Math.min(y0, q.y - q.r); y1 = Math.max(y1, q.y + q.r); x1 = Math.max(x1, q.x + q.r); }
  const my = (y0 + y1) / 2, fit = Math.min(1, 0.72 / ((y1 - y0) / 2), 0.98 / x1);
  for (const q of balls) { q.y = (q.y - my) * fit; q.x *= fit; q.r *= fit; }

  const K: number[] = [], KB: number[] = [];
  for (const b of balls) { const R2 = (b.r / INK_ISO) ** 2; K.push(b.x, b.y, R2); KB.push(b.x, b.y, R2 * 3.6); }
  let cw = 0;
  for (const b of balls) cw += b.r * b.r;
  // Rays out to the edge start from a drop, chosen by size, in any direction:
  // the middle of the blot can be bare paper between two figures.
  const rayFrom = (rng: () => number): [number, number, number, number] => {
    let t = rng() * cw, b = balls[balls.length - 1];
    for (const q of balls) { t -= q.r * q.r; if (t <= 0) { b = q; break; } }
    const th = rng() * Math.PI * 2;
    return [b.x, b.y, Math.cos(th), Math.sin(th)];
  };
  const toEdge = (ox: number, oy: number, dx: number, dy: number): [number, number] => {
    let t = 0, x = ox, y = oy;
    while (inkBalls(K, x, y) > INK_T && t < 2) { t += 0.01; x = ox + dx * t; y = oy + dy * t; }
    return [x, y];
  };

  // Holes: only where ink surrounds them; now and then a slit on the fold.
  const rh = inkRandom((Math.imul(g, 2246822519) ^ 0x165667b1) >>> 0);
  const holes: InkHole[] = [];
  const nh = Math.min(40, Math.round(P.holes * 4 * (0.35 + rh() * 0.8)));
  for (let tries = 0; holes.length < nh && tries < 80 + 40 * nh; tries++) {
    const onFold = (holes.length === 0 && rh() < 0.6) || rh() < 0.08;
    const r = 0.014 + rh() * 0.026 * (0.6 + Math.min(1, P.holes) * 0.7);
    const x = onFold ? 0 : 0.03 + rh() * 0.9, y = (rh() - 0.5) * 1.5;
    const v = inkBalls(K, x, y);
    if (v < INK_T + 0.35) continue;
    let ok = true;
    for (let a = 0; a < 8 && ok; a++) {
      const ga = (a * Math.PI) / 4;
      if (inkBalls(K, x + Math.cos(ga) * r * 3.2, y + Math.sin(ga) * r * 3.2) < INK_T + 0.15) ok = false;
    }
    if (!ok) continue;
    // Kernel radius chosen so the hole that shows is about r across.
    const s = v - INK_T + 0.35, sc = 1 / Math.sqrt(1 - Math.sqrt((s - 0.35) / s));
    const el = onFold ? 2 + rh() * 1.6 : 1 + rh() * 0.7, vert = onFold || rh() < 0.5;
    holes.push({ x, y, s, rx: r * sc * (vert ? 1 : el), ry: r * sc * (vert ? el : 1) });
  }

  // Walkers (tendrils that branch and taper) and spatter, each with the moment
  // it arrives in the bloom.
  const rw = inkRandom((Math.imul(g, 40503) ^ 0x9e3779b9) >>> 0);
  const rs = inkRandom((Math.imul(g, 69069) ^ 0x2545f491) >>> 0);
  const wn = inkNoise(g * 7 + 101);
  const S: number[] = [], D: number[] = [];
  const add = (x: number, y: number, r: number, a: number) => S.push(Math.abs(x), y, (r / INK_ISO) ** 2, a);
  const addD = (x: number, y: number, r: number, a: number) => D.push(Math.abs(x), y, (r / INK_ISO) ** 2, a);
  const arrive = (pl: number) => Math.min(0.9, 0.12 + (0.75 * pl) / (P.reach * 1.45 + 1e-6));
  interface Walker { x: number; y: number; h: number; L: number; L0: number; w0: number; d: number; nz: number; pl: number }
  const queue: Walker[] = [];
  const walkers = P.warpOnly ? 0 : P.tendrils;
  for (let k = 0; k < walkers; k++) {
    const [ox, oy, dx, dy] = rayFrom(rw);
    let [x, y] = toEdge(ox, oy, dx, dy);
    x -= dx * 0.03;
    y -= dy * 0.03;
    const hh = 0.01, gx = inkBalls(K, x + hh, y) - inkBalls(K, x - hh, y), gy = inkBalls(K, x, y + hh) - inkBalls(K, x, y - hh), gl = Math.hypot(gx, gy) || 1;
    const heading = Math.atan2((-gy / gl) * 0.6 + dy * 0.4, (-gx / gl) * 0.6 + dx * 0.4);
    const L = P.reach * (0.35 + 1.1 * rw());
    queue.push({ x, y, h: heading, L, L0: L, w0: 0.045 * P.thickness * (0.6 + 0.7 * rw()), d: 0, nz: rw() * 500, pl: 0 });
  }
  while (queue.length) {
    const w = queue.shift()!;
    let { x, y, h, L, L0, w0, pl } = w;
    let wd = w0;
    while (L > 0) {
      wd = Math.max(0.005, w0 * Math.pow(Math.max(0, L) / L0, 0.8));
      add(x, y, wd, arrive(pl));
      const st = Math.min(0.012, Math.max(0.004, wd * 0.6));
      h += wn(x * 2.2 + w.nz, y * 2.2) * P.wander * st * 9;
      x += Math.cos(h) * st;
      y += Math.sin(h) * st;
      L -= st;
      pl += st;
      if (w.d < 3 && L > 0.06 && rw() < P.branch * st * 3.5) {
        const a = 0.28 + 0.4 * rw(), side = rw() < 0.5 ? 1 : -1, cl = L * (0.45 + 0.4 * rw());
        queue.push({ x, y, h: h + side * a, L: cl, L0: cl, w0: wd * 0.72, d: w.d + 1, nz: rw() * 500, pl });
        h -= side * a * 0.45;
        w0 = wd * 0.9;
        L0 = L;
      }
    }
    if (P.sat > 0 && rs() < 0.35 + P.sat * 0.65) {
      const m = 1 + Math.floor(rs() * (1 + P.sat * 6));
      let dist = 0.015;
      for (let j = 0; j < m; j++) {
        dist += 0.012 + rs() * 0.03 * (1 + P.sat);
        const ja = h + (rs() - 0.5) * (0.4 + P.sat * 0.8);
        add(x + Math.cos(ja) * dist, y + Math.sin(ja) * dist, (0.004 + rs() * rs() * 0.018) * Math.min(1.3, P.thickness), Math.min(0.97, arrive(pl) + 0.04 * (j + 1)));
      }
    }
  }
  const nd = Math.round(P.sat * 16);
  for (let k = 0; k < nd; k++) {
    const [ox, oy, dx, dy] = rayFrom(rs);
    let [x, y] = toEdge(ox, oy, dx, dy);
    const out = 0.03 + Math.pow(rs(), 1.5) * 0.32, r0 = (0.004 + rs() * rs() * 0.02) * (1.2 - out * 2), a = 0.4 + 0.5 * rs();
    x += dx * out + (rs() - 0.5) * 0.04;
    y += dy * out + (rs() - 0.5) * 0.04;
    const cl = rs() < 0.35 ? 2 + Math.floor(rs() * 3) : 1;
    for (let c = 0; c < cl; c++) addD(x + (rs() - 0.5) * 0.05 * c, y + (rs() - 0.5) * 0.05 * c, Math.max(0.0035, r0 * (c ? 0.6 : 1)), a);
  }

  // Now and then red, yellow or both, as on a few of the real cards.
  const rc = inkRandom((Math.imul(g, 374761393) ^ 0x27d4eb2f) >>> 0);
  const C: number[] = [];
  const cArr: [number, number] = [0, 0];
  if (rc() < INK_COLOUR_CHANCE) {
    const pick = rc(), cols = pick < 0.45 ? [0] : pick < 0.8 ? [1] : [0, 1];
    for (const col of cols) {
      cArr[col] = 0.3 + 0.4 * rc();
      const ng = 1 + Math.floor(rc() * 2.5);
      for (let gi = 0; gi < ng; gi++) {
        const [ox, oy, dx, dy] = rayFrom(rc);
        let [x, y] = toEdge(ox, oy, dx, dy);
        // On the edge, inside, or floating free.
        const place = rc();
        const off = place < 0.45 ? (rc() - 0.5) * 0.08 : place < 0.75 ? -(0.08 + rc() * 0.2) : 0.06 + rc() * 0.2;
        x += dx * off;
        y += dy * off;
        const nb = 2 + Math.floor(rc() * 4), rr = 0.035 + rc() * 0.05;
        for (let b = 0; b < nb; b++) {
          const a = rc() * Math.PI * 2, dd = rc() * rr * 1.3, r = rr * (0.45 + 0.6 * rc());
          C.push(Math.abs(x + Math.cos(a) * dd), y + Math.sin(a) * dd, (r / INK_ISO) ** 2, col);
        }
        const nsd = Math.floor(rc() * 4);
        for (let b = 0; b < nsd; b++) {
          const a = rc() * Math.PI * 2, dd = rr * (1.6 + rc() * 1.5);
          C.push(Math.abs(x + Math.cos(a) * dd), y + Math.sin(a) * dd, ((0.006 + rc() * 0.012) / INK_ISO) ** 2, col);
        }
      }
    }
  }
  return {
    seed, params: P, K, KB, holes, S, D, C, cArr,
    warpN: inkNoise(g * 13 + 7), roughN: inkNoise(g * 17 + 3), grainN: inkNoise(g * 19 + 5),
    poolN: inkNoise(g * 23 + 9), angN: inkNoise(g * 29 + 11),
  };
}

/**
 * Edge-pulled tendrils: read the body from a point moved inward along its
 * blurred outline's normal, by an amount set by noise on the normal's angle
 * (sampled on a circle, so there is no seam).
 */
function inkWarp(B: InkBlot, x: number, y: number, A: number, out: number[]): void {
  const h = 0.012, KB = B.KB, r0 = 2.2;
  const gx = inkBalls(KB, x + h, y) - inkBalls(KB, x - h, y), gy = inkBalls(KB, x, y + h) - inkBalls(KB, x, y - h), g = Math.hypot(gx, gy);
  if (g < 1e-7 || A <= 0) { out[0] = x; out[1] = y; return; }
  const nx = -gx / g, ny = -gy / g;
  const bend = Math.max(0, 1 - inkBalls(KB, x, y)) * 1.2;
  const N = B.warpN;
  let f = Math.pow(Math.max(0, N(nx * r0 + bend * 0.8 + 3.1, ny * r0 - bend * 0.6 + 7.7) * 1.6 - 0.1), 1.3);
  f += 0.6 * Math.pow(Math.max(0, N(nx * r0 * 2.3 + bend * 1.5 + 19.3, ny * r0 * 2.3 - bend + 2.2) * 1.6 - 0.15), 1.3) * Math.min(1, f * 3);
  out[0] = x - nx * A * f;
  out[1] = y - ny * A * f;
}

/**
 * A blot laid out for one size, ready to paint any moment of the bloom. Only
 * the right half is computed; painting mirrors it at the fold. Filled a few
 * rows at a time (inkFieldRows) so a big one never holds up the page.
 */
export interface InkField {
  blot: InkBlot;
  W: number;
  H: number;
  hw: number;
  scale: number;
  F0: Float32Array;
  SB: Float32Array;
  AT: Float32Array;
  OX: Float32Array;
  OY: Float32Array;
  POOL: Float32Array;
  GR: Float32Array;
  CB: [Float32Array, Float32Array] | null;
  Fv: Float32Array;
  ATv: Float32Array;
  CBv: [Float32Array, Float32Array] | null;
  /** The next row to compute. */
  row: number;
  fmax: number;
}

function inkStamp(buf: Float32Array, at: Float32Array | null, list: readonly number[], f: InkField, sum: boolean, colour?: number): void {
  const { hw, H, scale } = f;
  for (let s = 0; s < list.length; s += 4) {
    if (colour !== undefined && list[s + 3] !== colour) continue;
    const sx = list[s], sy = list[s + 1], R2 = list[s + 2], sa = list[s + 3], R = Math.sqrt(R2);
    const i0 = Math.max(0, Math.floor((sx - R) * scale)), i1 = Math.min(hw - 1, Math.ceil((sx + R) * scale));
    const j0 = Math.max(0, Math.floor((sy - R) * scale + H / 2)), j1 = Math.min(H - 1, Math.ceil((sy + R) * scale + H / 2));
    for (let j = j0; j <= j1; j++) {
      const y = (j + 0.5 - H / 2) / scale, dy = y - sy;
      for (let i = i0; i <= i1; i++) {
        const x = (i + 0.5) / scale, dx = x - sx, q = (dx * dx + dy * dy) / R2;
        if (q >= 1) continue;
        const t = (1 - q) * (1 - q), k = j * hw + i;
        if (sum) buf[k] += t;
        else if (t > buf[k]) { buf[k] = t; if (at) at[k] = sa; }
      }
    }
  }
}

/** Set a blot up at W × H pixels (W even). Nothing is computed per pixel yet. */
export function inkField(W: number, H: number, blot: InkBlot): InkField {
  const hw = W >> 1, n = hw * H, colour = blot.C.length > 0;
  const f: InkField = {
    blot, W, H, hw, scale: H / 2 / INK_VIEW,
    F0: new Float32Array(n), SB: new Float32Array(n), AT: new Float32Array(n),
    OX: new Float32Array(n), OY: new Float32Array(n), POOL: new Float32Array(n), GR: new Float32Array(n),
    CB: colour ? [new Float32Array(n), new Float32Array(n)] : null,
    Fv: new Float32Array(n), ATv: new Float32Array(n),
    CBv: colour ? [new Float32Array(n), new Float32Array(n)] : null,
    row: 0, fmax: 0,
  };
  // Walkers only for a walker blot; spatter for both.
  if (!blot.params.warpOnly) inkStamp(f.SB, f.AT, blot.S, f, false);
  inkStamp(f.SB, f.AT, blot.D, f, false);
  if (f.CB) {
    inkStamp(f.CB[0], null, blot.C, f, true, 0);
    inkStamp(f.CB[1], null, blot.C, f, true, 1);
  }
  return f;
}

/** Compute up to `rows` more rows; true once the whole field is done. */
export function inkFieldRows(f: InkField, rows: number): boolean {
  const { blot: B, H, hw, scale, F0, SB, AT, OX, OY, POOL, GR, CB } = f;
  const P = B.params, A = P.warpOnly ? P.warp * 0.45 : 0, out = [0, 0];
  const end = Math.min(H, f.row + Math.max(1, rows));
  for (let j = f.row; j < end; j++) {
    const y = (j + 0.5 - H / 2) / scale;
    for (let i = 0; i < hw; i++) {
      const x = (i + 0.5) / scale, k = j * hw + i;
      let b: number;
      if (A > 0) { inkWarp(B, x, y, A, out); b = inkBalls(B.K, out[0], out[1]) - inkHoles(B.holes, out[0], out[1]); }
      else b = inkBalls(B.K, x, y) - inkHoles(B.holes, x, y);
      // Pixels the body already covers are there from the start of the bloom.
      if (b >= INK_T) AT[k] = 0;
      let v = b + SB[k];
      if (P.edge === "rough") {
        const r = 0.07 * B.roughN(x * 16, y * 16);
        v += r;
        if (CB) { if (CB[0][k] > 0) CB[0][k] += r; if (CB[1][k] > 0) CB[1][k] += r; }
      }
      F0[k] = v;
      if (v > f.fmax) f.fmax = v;
      // The angle-warp edge: noise picks a direction, the step is fixed; two scales.
      const a1 = B.angN(x * 7, y * 7) * Math.PI, a2 = B.angN(x * 24 + 17, y * 24 - 9) * Math.PI;
      OX[k] = Math.cos(a1) * 0.014 + Math.cos(a2) * 0.005;
      OY[k] = Math.sin(a1) * 0.014 + Math.sin(a2) * 0.005;
      POOL[k] = 0.5 + 0.5 * (0.7 * B.poolN(x * 2.6 + 5, y * 2.6) + 0.3 * B.poolN(x * 7 - 3, y * 7 + 1));
      GR[k] = 0.93 + 0.07 * B.grainN(x * 55, y * 55);
    }
  }
  f.row = end;
  return end >= H;
}

function inkSample(F: Float32Array, w: number, h: number, px: number, py: number): number {
  if (px < 0) px = 0; else if (px > w - 1) px = w - 1;
  if (py < 0) py = 0; else if (py > h - 1) py = h - 1;
  const i = px | 0, j = py | 0, fx = px - i, fy = py - j, i1 = i < w - 1 ? i + 1 : i, j1 = j < h - 1 ? j + 1 : j;
  const a = F[j * w + i], b = F[j * w + i1], c = F[j1 * w + i], d = F[j1 * w + i1], top = a + (b - a) * fx;
  return top + (c + (d - c) * fx - top) * fy;
}

/**
 * Paint one moment of the bloom into an RGBA buffer of W × H: paper, ink over
 * it, colour over that. `prog` runs 0 to 1; at 1 it is the finished blot. The
 * stain spreads as the threshold falls, the ragged edge settles from three
 * times its turbulence, and tendrils and spatter arrive along their paths.
 */
export function inkPaint(f: InkField, prog: number, out: Uint8ClampedArray): void {
  const { W, H, hw, scale, F0, AT, OX, OY, POOL, GR, Fv, ATv, CB, CBv, blot } = f;
  const e = 1 - Math.pow(1 - prog, 3);
  const fin = blot.params.edge === "angle" ? 1 : 0, amp = fin + (3 - fin) * (1 - e);
  const arrival = prog * 1.08;
  const Tstart = Math.max(INK_T * 1.05, f.fmax * 0.92);
  const Tt = prog >= 1 ? INK_T : INK_T * Math.pow(Tstart / INK_T, 1 - e);
  if (amp === 0) {
    Fv.set(F0);
    ATv.set(AT);
    if (CB && CBv) { CBv[0].set(CB[0]); CBv[1].set(CB[1]); }
  } else {
    for (let j = 0; j < H; j++) {
      const y0 = (j + 0.5 - H / 2) / scale;
      for (let i = 0; i < hw; i++) {
        const k = j * hw + i, x = (i + 0.5) / scale + OX[k] * amp, y = y0 + OY[k] * amp;
        const px = Math.abs(x) * scale - 0.5, py = y * scale + H / 2 - 0.5;
        Fv[k] = inkSample(F0, hw, H, px, py);
        // Arrival is read from the same displaced point, so it follows the ragged edge.
        const ni = Math.min(hw - 1, Math.max(0, Math.round(px))), nj = Math.min(H - 1, Math.max(0, Math.round(py)));
        ATv[k] = AT[nj * hw + ni];
        if (CB && CBv) { CBv[0][k] = inkSample(CB[0], hw, H, px, py); CBv[1][k] = inkSample(CB[1], hw, H, px, py); }
      }
    }
  }
  const [pr, pg, pb] = INK_PAPER;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < hw; i++) {
      const k = j * hw + i, v = Fv[k];
      const gx = i < hw - 1 ? Fv[k + 1] - v : v - Fv[k - 1], gy = j < H - 1 ? Fv[k + hw] - v : v - Fv[k - hw];
      // Anti-aliased by the local slope: half a pixel of edge at any size.
      let a = (v - Tt) / Math.max(1e-5, Math.hypot(gx, gy)) + 0.5;
      if (a <= 0) a = 0;
      else {
        if (a > 1) a = 1;
        // Tone: the ink pools unevenly, is thicker deep in, darker at the rim.
        // Halfway between the first shading and a stretched one.
        const depth = inkClamp((v - Tt) / 1.2), rim = 1 - inkClamp((v - Tt) / 0.22);
        const d1 = inkClamp(0.1 + 0.55 * POOL[k] + 0.2 * depth + 0.4 * rim);
        const f1 = 1 - INK_RANGE * (1 - (0.12 + 0.86 * d1));
        const pc = inkClamp((POOL[k] - 0.5) * 2 + 0.5), d2 = inkClamp(0.04 + 0.66 * pc + 0.15 * depth + 0.35 * rim);
        const f2 = 1 - INK_RANGE * (1 - (0.07 + 0.93 * d2 * d2 * (3 - 2 * d2)));
        a *= ((f1 + f2) / 2) * GR[k];
        if (prog < 1) a *= inkClamp((arrival - ATv[k]) * 15);
      }
      let r = pr + (INK_INK[0] - pr) * a, g = pg + (INK_INK[1] - pg) * a, b = pb + (INK_INK[2] - pb) * a;
      if (CBv) {
        // Yellow first, red over it.
        for (let c = 1; c >= 0; c--) {
          const F = CBv[c], cv = F[k];
          if (cv <= 0) continue;
          const cgx = i < hw - 1 ? F[k + 1] - cv : cv - F[k - 1], cgy = j < H - 1 ? F[k + hw] - cv : cv - F[k - hw];
          let ac = (cv - Tt) / Math.max(1e-5, Math.hypot(cgx, cgy)) + 0.5;
          if (ac <= 0) continue;
          if (ac > 1) ac = 1;
          const crim = 1 - inkClamp((cv - Tt) / 0.22), cdd = inkClamp(0.35 + 0.45 * POOL[k] + 0.4 * crim);
          ac *= 0.92 * (1 - INK_RANGE * 0.6 * (1 - cdd)) * GR[k];
          if (prog < 1) ac *= inkClamp((arrival - blot.cArr[c]) * 6);
          const col = c ? INK_YELLOW : INK_RED, sh = 1 - 0.3 * crim;
          r += (col[0] * sh - r) * ac;
          g += (col[1] * sh - g) * ac;
          b += (col[2] * sh - b) * ac;
        }
      }
      let o = (j * W + hw + i) * 4;
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
      o = (j * W + hw - 1 - i) * 4;
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
    }
  }
}

/** Compute a whole field at once: for small sizes and for tests. */
export function inkFieldNow(W: number, H: number, blot: InkBlot): InkField {
  const f = inkField(W, H, blot);
  inkFieldRows(f, H);
  return f;
}

/** Does the finished blot touch the card's edge anywhere? */
export function inkTouchesEdge(f: InkField, painted: Uint8ClampedArray): boolean {
  const { W, H } = f, [pr, pg, pb] = INK_PAPER;
  const inked = (p: number) => Math.abs(painted[p * 4] - pr) + Math.abs(painted[p * 4 + 1] - pg) + Math.abs(painted[p * 4 + 2] - pb) > 24;
  for (let x = 0; x < W; x++) if (inked(x) || inked((H - 1) * W + x)) return true;
  for (let y = 0; y < H; y++) if (inked(y * W) || inked(y * W + W - 1)) return true;
  return false;
}

/**
 * The blot for a seed: its first form, unless that runs off the card, in which
 * case the next of a few fallback forms that does not (checked small, which is
 * cheap). Always the same answer for the same seed.
 */
export function inkResolve(seed: number): InkBlot {
  const W = 104, H = Math.round(W / INK_ASPECT);
  const buf = new Uint8ClampedArray(W * H * 4);
  let blot = inkBuild(seed, 0);
  for (let v = 0; v < INK_VARIANTS; v++) {
    blot = inkBuild(seed, v);
    const f = inkFieldNow(W, H, blot);
    inkPaint(f, 1, buf);
    if (!inkTouchesEdge(f, buf)) return blot;
  }
  return blot;
}

/** The height that goes with a width, for a card of the blot's shape. */
export function inkHeight(W: number): number {
  return Math.round(W / INK_ASPECT);
}
