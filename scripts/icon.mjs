/**
 * The app icon: Orangey's head on the brand black tile, exactly as
 * assets/mascot/logo.svg draws it.
 *
 * The geometry is imported from src/ui/mascot/parts.ts rather than copied, so
 * a redrawn head reaches the favicon and the installed icon along with the
 * app itself. Everything below is a small scanline rasteriser and a tiny PNG
 * writer, because the build has no dependencies: the four cubic segments of
 * the outline are flattened to a polygon, the stem and eyes are solved
 * analytically per row, and four-by-four supersampling does the smoothing.
 *
 * The artwork is the Orangey character: Copyright (c) 2026 Amogh Kinikar,
 * all rights reserved — see LICENSE. The code around it is MIT like the rest.
 */

import { deflateSync } from "node:zlib";
import {
  MASCOT_BODY,
  MASCOT_EYES,
  MASCOT_EYE_RX,
  MASCOT_EYE_RY,
  MASCOT_LOGO_TILE,
  MASCOT_STEM,
} from "../src/ui/mascot/parts.ts";

/** The brand's four colours, in paint order. Index 0 is the tile. */
const PAINTS = [
  [37, 49, 34], // #253122 the tile
  [243, 162, 87], // #f3a257 the body
  [164, 149, 51], // #a49533 the stem
  [245, 236, 194], // #f5ecc2 the eyes
];

/** Samples per pixel per axis. Sixteen samples is smooth at every size used. */
const SS = 4;

/** The outline's four cubic segments, flattened once into a polygon. */
function bodyPolygon(perSegment = 96) {
  const p = MASCOT_BODY;
  const segments = [
    [p[0], p[1], p[2], p[3]],
    [p[3], p[4], p[5], p[6]],
    [p[6], p[7], p[8], p[9]],
    [p[9], p[10], p[11], p[0]],
  ];
  const points = [];
  for (const [a, b, c, d] of segments) {
    for (let i = 0; i < perSegment; i++) {
      const t = i / perSegment;
      const u = 1 - t;
      points.push([
        u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0],
        u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1],
      ]);
    }
  }
  return points;
}

/** Where a horizontal line at `y` is inside the polygon, as sorted x pairs. */
function polygonSpans(points, y) {
  const xs = [];
  for (let i = 0, n = points.length; i < n; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % n];
    if (y1 === y2) continue;
    if (y >= Math.min(y1, y2) && y < Math.max(y1, y2)) {
      xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
    }
  }
  xs.sort((a, b) => a - b);
  const spans = [];
  for (let i = 0; i + 1 < xs.length; i += 2) spans.push([xs[i], xs[i + 1]]);
  return spans;
}

/**
 * Where a horizontal line at `y` is inside an ellipse turned by `rot`
 * degrees about its own centre: the quadratic in dx, solved.
 */
function ellipseSpan(y, { cx, cy, rx, ry, rot = 0 }) {
  const th = (rot * Math.PI) / 180;
  const c = Math.cos(th);
  const s = Math.sin(th);
  const dy = y - cy;
  const ix = 1 / (rx * rx);
  const iy = 1 / (ry * ry);
  const A = c * c * ix + s * s * iy;
  const B = 2 * c * s * dy * (ix - iy);
  const C = dy * dy * (s * s * ix + c * c * iy) - 1;
  const disc = B * B - 4 * A * C;
  if (disc <= 0) return [];
  const root = Math.sqrt(disc);
  return [[cx + (-B - root) / (2 * A), cx + (-B + root) / (2 * A)]];
}

function paintSpans(row, spans, paint, scale, offset, width) {
  for (const [from, to] of spans) {
    const a = Math.max(0, Math.ceil((from - offset) / scale - 0.5));
    const b = Math.min(width - 1, Math.floor((to - offset) / scale - 0.5));
    for (let i = a; i <= b; i++) row[i] = paint;
  }
}

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 0);
  return Buffer.concat([head, data, crcBuf]);
}

/**
 * The logo as a square PNG of any size.
 *
 * `inset` shrinks the artwork about the tile's centre while the tile stays
 * full-bleed: 0.78 keeps every part of him inside the safe circle a maskable
 * icon may be cropped to, so the head is never clipped on a phone.
 */
export function makeIcon(size, { inset = 1 } = {}) {
  const tile = MASCOT_LOGO_TILE;
  const centre = tile / 2;
  const body = bodyPolygon();
  const eyes = ["L", "R"].map((side) => {
    const [cx, cy, rot] = MASCOT_EYES.tq[side];
    return { cx, cy, rx: MASCOT_EYE_RX, ry: MASCOT_EYE_RY, rot };
  });

  // One tile unit per sub-sample, and the offset that centres the first one.
  const scale = tile / (size * SS);
  const offset = scale / 2;
  const subWidth = size * SS;
  const row = new Uint8Array(subWidth);
  const rows = [];

  for (let y = 0; y < size; y++) {
    const acc = new Float64Array(size * 3);
    for (let sy = 0; sy < SS; sy++) {
      let ty = (y * SS + sy + 0.5) * scale;
      ty = centre + (ty - centre) / inset;
      row.fill(0);
      const paintAt = (spans, paint) =>
        paintSpans(
          row,
          spans.map(([a, b]) => [centre + (a - centre) * inset, centre + (b - centre) * inset]),
          paint,
          scale,
          offset,
          subWidth,
        );
      paintAt(polygonSpans(body, ty), 1);
      paintAt(ellipseSpan(ty, MASCOT_STEM), 2);
      for (const eye of eyes) paintAt(ellipseSpan(ty, eye), 3);

      for (let x = 0; x < size; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        for (let sx = 0; sx < SS; sx++) {
          const paint = PAINTS[row[x * SS + sx]];
          r += paint[0];
          g += paint[1];
          b += paint[2];
        }
        acc[x * 3] += r;
        acc[x * 3 + 1] += g;
        acc[x * 3 + 2] += b;
      }
    }

    const out = Buffer.alloc(1 + size * 4);
    const samples = SS * SS;
    for (let x = 0; x < size; x++) {
      out[1 + x * 4] = Math.round(acc[x * 3] / samples);
      out[1 + x * 4 + 1] = Math.round(acc[x * 3 + 1] / samples);
      out[1 + x * 4 + 2] = Math.round(acc[x * 3 + 2] / samples);
      out[1 + x * 4 + 3] = 255; // the tile is opaque, corner to corner
    }
    rows.push(out);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
