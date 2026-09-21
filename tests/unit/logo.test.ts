import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { MASCOT_EYES, MASCOT_STEM, mascotLogoMarkup, mascotRestingBodyPath } from "../../src/ui/mascot/parts.ts";
import { makeIcon } from "../../scripts/icon.mjs";

/** Read back one of our own PNGs: RGBA, one IDAT, filter 0 on every row. */
function decode(png: Buffer): { size: number; at: (x: number, y: number) => [number, number, number] } {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "not a PNG");
  let offset = 8;
  let size = 0;
  const idat: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      size = data.readUInt32BE(0);
      assert.equal(data.readUInt32BE(4), size, "not square");
      assert.equal(data[8], 8);
      assert.equal(data[9], 6);
    }
    if (type === "IDAT") idat.push(data);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = 1 + size * 4;
  assert.equal(raw.length, stride * size, "wrong pixel count");
  for (let y = 0; y < size; y++) assert.equal(raw[y * stride], 0, `row ${y} is filtered`);
  return {
    size,
    at: (x, y) => {
      const i = y * stride + 1 + x * 4;
      assert.equal(raw[i + 3], 255, `pixel ${x},${y} is not opaque`);
      return [raw[i], raw[i + 1], raw[i + 2]];
    },
  };
}

describe("the logo", () => {
  test("the mark is the drawn head, and nothing of a pose", () => {
    // The logo is built from the same parts as the mascot, so that a change to
    // his shape cannot leave the icon showing an older Orangey.
    const svg = mascotLogoMarkup();
    assert.ok(svg.includes(`d="${mascotRestingBodyPath()}"`), "not the drawn body");
    assert.ok(svg.includes(`cx="${MASCOT_STEM.cx}" cy="${MASCOT_STEM.cy}"`), "no stem");
    for (const side of ["L", "R"] as const) {
      const [cx, cy] = MASCOT_EYES.tq[side];
      assert.ok(svg.includes(`cx="${cx}" cy="${cy}"`), `no ${side} eye at the three-quarter placement`);
    }
    for (const absent of ["mouth", "arm", "leg", "data-pose"]) {
      assert.ok(!svg.includes(absent), `the mark should not contain ${absent}`);
    }
    assert.match(svg, /aria-hidden="true"/);
  });

  test("the app icon renders to a square opaque PNG at every size the build asks for", () => {
    for (const size of [64, 192, 512]) {
      const png = decode(makeIcon(size));
      assert.equal(png.size, size);
      // A transparent corner would show the launcher's own background through
      // the tile, so `at` checks opacity wherever it reads.
      const last = size - 1;
      for (const [x, y] of [[0, 0], [last, 0], [0, last], [last, last], [size >> 1, size >> 1]]) png.at(x, y);
    }
  });
});
