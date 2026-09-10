import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import {
  MASCOT_EYES,
  MASCOT_LOGO_TILE,
  MASCOT_STEM,
  mascotLogoMarkup,
  mascotRestingBodyPath,
} from "../../src/ui/mascot/parts.ts";
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

const TILE: [number, number, number] = [37, 49, 34];
const BODY: [number, number, number] = [243, 162, 87];
const STEM: [number, number, number] = [164, 149, 51];
const EYE: [number, number, number] = [245, 236, 194];

const near = (got: [number, number, number], want: [number, number, number], tol = 6) =>
  got.every((v, i) => Math.abs(v - want[i]) <= tol);

describe("the logo mark", () => {
  test("is the drawn head: the resting body path, the stem, and both three-quarter eyes", () => {
    const svg = mascotLogoMarkup();
    assert.ok(svg.includes(`d="${mascotRestingBodyPath()}"`), "not the drawn body");
    assert.ok(svg.includes(`cx="${MASCOT_STEM.cx}" cy="${MASCOT_STEM.cy}"`), "no stem");
    for (const side of ["L", "R"] as const) {
      const [cx, cy] = MASCOT_EYES.tq[side];
      assert.ok(svg.includes(`cx="${cx}" cy="${cy}"`), `no ${side} eye at the three-quarter placement`);
    }
  });

  test("carries no mouth, no limbs and no pose switching: it is the logo, not a pose", () => {
    const svg = mascotLogoMarkup();
    for (const absent of ["mouth", "arm", "leg", "data-pose", "eyeLsquint", "eyeLopen"]) {
      assert.ok(!svg.includes(absent), `the mark should not contain ${absent}`);
    }
    assert.match(svg, /aria-hidden="true"/);
  });
});

describe("the app icon", () => {
  test("is a valid opaque PNG at every size the build asks for", () => {
    for (const size of [64, 192, 512]) {
      const png = decode(makeIcon(size));
      assert.equal(png.size, size);
    }
  });

  test("draws the logo tile: brand black corner to corner, his head on it, stem and eyes in place", () => {
    const png = decode(makeIcon(512));
    const at = (tx: number, ty: number) => png.at(Math.round((tx / MASCOT_LOGO_TILE) * 512), Math.round((ty / MASCOT_LOGO_TILE) * 512));
    for (const [tx, ty] of [[2, 2], [153, 2], [2, 153], [153, 153]]) {
      assert.ok(near(at(tx, ty), TILE), `corner ${tx},${ty} is not the tile: ${at(tx, ty)}`);
    }
    for (const [tx, ty] of [[60, 110], [100, 60], [40, 70]]) {
      assert.ok(near(at(tx, ty), BODY), `${tx},${ty} is not the body colour: ${at(tx, ty)}`);
    }
    assert.ok(near(at(MASCOT_STEM.cx, MASCOT_STEM.cy), STEM), `no stem: ${at(MASCOT_STEM.cx, MASCOT_STEM.cy)}`);
    for (const side of ["L", "R"] as const) {
      const [cx, cy] = MASCOT_EYES.tq[side];
      assert.ok(near(at(cx, cy), EYE), `no ${side} eye: ${at(cx, cy)}`);
    }
    // and nothing of the old placeholder wheel: no blue, no pink, no white hub
    const seen = new Set<string>();
    for (let y = 0; y < 512; y += 3) for (let x = 0; x < 512; x += 3) seen.add(png.at(x, y).join(","));
    for (const pixel of seen) {
      const [r, g, b] = pixel.split(",").map(Number);
      const isBrand = [TILE, BODY, STEM, EYE].some((c) => near([r, g, b], c, 90));
      assert.ok(isBrand, `a colour that is not the logo's: ${pixel}`);
    }
  });

  test("the maskable copy keeps every part of him inside the circle a phone may crop to", () => {
    // A maskable icon may be cropped to a circle of 80 % of its width. Sample
    // that circle's edge: outside the safe zone there must be tile only.
    const png = decode(makeIcon(512, { inset: 0.78 }));
    const centre = 256;
    for (let deg = 0; deg < 360; deg += 5) {
      const th = (deg * Math.PI) / 180;
      const x = Math.round(centre + Math.cos(th) * 0.42 * 512);
      const y = Math.round(centre + Math.sin(th) * 0.42 * 512);
      if (x < 0 || y < 0 || x > 511 || y > 511) continue;
      assert.ok(near(png.at(x, y), TILE), `he reaches the crop edge at ${deg}°: ${png.at(x, y)}`);
    }
    // he is still there in the middle
    assert.ok(near(png.at(centre, centre), BODY));
  });
});
