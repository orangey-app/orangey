/** A tiny PNG writer, so the build can produce icons without a dependency. */

import { deflateSync } from "node:zlib";

const SEGMENTS = [
  [0.0, 0.34, [201, 106, 31]],
  [0.34, 0.6, [74, 107, 138]],
  [0.6, 0.8, [111, 127, 67]],
  [0.8, 1.0, [163, 58, 48]],
];

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

/** A wheel: four coloured arcs with a light hub, on a transparent square. */
export function makeIcon(size) {
  const centre = size / 2;
  const radius = size * 0.46;
  const hub = size * 0.13;
  const rows = [];

  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - centre;
      const dy = y + 0.5 - centre;
      const dist = Math.hypot(dx, dy);
      let rgba = [0, 0, 0, 0];
      if (dist <= radius) {
        if (dist <= hub) {
          rgba = [250, 248, 245, 255];
        } else {
          let angle = Math.atan2(dx, -dy) / (Math.PI * 2);
          if (angle < 0) angle += 1;
          const seg = SEGMENTS.find(([from, to]) => angle >= from && angle < to) ?? SEGMENTS[0];
          rgba = [...seg[2], 255];
        }
        // Feather the outer edge so the icon does not look jagged.
        if (dist > radius - 1.5) rgba[3] = Math.round(255 * Math.max(0, radius - dist) / 1.5);
      }
      row.set(rgba, 1 + x * 4);
    }
    rows.push(row);
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
