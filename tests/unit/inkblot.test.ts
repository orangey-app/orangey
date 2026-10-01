import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  INK_PAPER, INK_SEED_MAX, inkBuild, inkFieldNow, inkHeight, inkPaint, inkParams, inkResolve, inkTouchesEdge,
} from "../../src/core/inkblot.ts";
import { SeededSource } from "../../src/core/rng.ts";
import { rollRandomizer } from "../../src/model/roll.ts";
import { emptyRandomizer, validateRandomizer } from "../../src/model/randomizer.ts";
import { Check } from "../../src/model/validate.ts";

/** Paint a finished blot at width W. */
function painted(seed: number, W: number): Uint8ClampedArray {
  const H = inkHeight(W);
  const out = new Uint8ClampedArray(W * H * 4);
  inkPaint(inkFieldNow(W, H, inkResolve(seed)), 1, out);
  return out;
}

/** Byte for byte (assert.deepEqual would print a diff of every pixel). */
const same = (a: Uint8ClampedArray, b: Uint8ClampedArray): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/** Which pixels carry ink, as 0/1, on a grid of W × H. */
function inkMask(pixels: Uint8ClampedArray, W: number, H: number): Uint8Array {
  const mask = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) {
    const d = Math.abs(pixels[p * 4] - INK_PAPER[0]) + Math.abs(pixels[p * 4 + 1] - INK_PAPER[1]) + Math.abs(pixels[p * 4 + 2] - INK_PAPER[2]);
    mask[p] = d > 60 ? 1 : 0;
  }
  return mask;
}

describe("inkblots", () => {
  test("the same seed always gives the same blot, pixel for pixel", () => {
    for (const seed of [1, 4242, 777777]) {
      assert.ok(same(painted(seed, 130), painted(seed, 130)), `seed ${seed}`);
    }
  });

  test("different seeds give different blots", () => {
    assert.ok(!same(painted(11, 130), painted(12, 130)));
  });

  test("a blot has the same shape at any size", () => {
    // The bloom, the card and the download are drawn at different sizes and
    // must be one blot. Draw it twice as large, shrink the mask back, and
    // nearly every pixel agrees; only the anti-aliased rim may differ.
    for (const seed of [3, 91, 5150]) {
      const small = inkMask(painted(seed, 120), 120, inkHeight(120));
      const W = 240, H = inkHeight(W), big = inkMask(painted(seed, W), W, H);
      let differ = 0, inked = 0;
      for (let y = 0; y < inkHeight(120); y++) {
        for (let x = 0; x < 120; x++) {
          const a = small[y * 120 + x];
          const b = big[Math.min(H - 1, y * 2) * W + x * 2];
          if (a !== b) differ++;
          if (a) inked++;
        }
      }
      assert.ok(inked > 200, `seed ${seed} has ink`);
      assert.ok(differ / inked < 0.12, `seed ${seed}: ${differ} of ${inked} differ`);
    }
  });

  test("settings stay inside the chosen ranges", () => {
    let warpOnly = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const p = inkParams(seed);
      if (p.warpOnly) {
        warpOnly++;
        assert.ok(p.warp >= 0.4 && p.warp <= 1, `warp ${p.warp}`);
      }
      assert.ok(p.tendrils >= 2 && p.tendrils <= 5);
      assert.ok(p.reach >= 0.3 && p.reach <= 0.6);
      assert.ok(p.branch >= 0 && p.branch <= 0.75);
      assert.ok(p.wander >= 0.3 && p.wander <= 0.7);
      assert.ok(p.thickness >= 0.9 && p.thickness <= 1.8);
      assert.ok(p.holes >= 0.2 && p.holes <= 2);
      assert.ok(p.sat >= 0 && p.sat <= 0.5);
    }
    // About 65% pull their tendrils out of the edge.
    assert.ok(warpOnly > 220 && warpOnly < 300, `${warpOnly} of 400`);
  });

  test("blots stay on the card", () => {
    let off = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const W = 104, H = inkHeight(W), blot = inkResolve(seed);
      const out = new Uint8ClampedArray(W * H * 4);
      const field = inkFieldNow(W, H, blot);
      inkPaint(field, 1, out);
      if (inkTouchesEdge(field, out)) off++;
    }
    assert.ok(off <= 1, `${off} of 60 touch the edge`);
  });

  test("a blot whose first form runs off the card is replaced by one that fits", () => {
    const touches = (blot: ReturnType<typeof inkBuild>) => {
      const W = 104, H = inkHeight(W), out = new Uint8ClampedArray(W * H * 4);
      const field = inkFieldNow(W, H, blot);
      inkPaint(field, 1, out);
      return inkTouchesEdge(field, out);
    };
    // Seeds 41 and 72 run off in their first form; 1 does not, and keeps it.
    for (const seed of [41, 72]) {
      assert.ok(touches(inkBuild(seed, 0)), `seed ${seed}'s first form runs off`);
      assert.ok(!touches(inkResolve(seed)), `seed ${seed} resolves to one that fits`);
    }
    assert.deepEqual(inkResolve(1).K, inkBuild(1, 0).K);
  });

  test("an early moment of the bloom shows less ink than the finished blot", () => {
    const W = 130, H = inkHeight(W), field = inkFieldNow(W, H, inkResolve(808));
    const early = new Uint8ClampedArray(W * H * 4), done = new Uint8ClampedArray(W * H * 4);
    inkPaint(field, 0.1, early);
    inkPaint(field, 1, done);
    const count = (m: Uint8Array) => m.reduce((a, b) => a + b, 0);
    assert.ok(count(inkMask(early, W, H)) < count(inkMask(done, W, H)) * 0.8);
  });

  test("a roll draws one number from the random source, and reproduces from a seed", () => {
    const r = emptyRandomizer("inkblot", "Inkblot");
    const a = rollRandomizer(r as never, new SeededSource("table"));
    const b = rollRandomizer(r as never, new SeededSource("table"));
    assert.equal(a.kind, "inkblot");
    assert.equal(a.blot, b.blot);
    assert.ok(Number.isInteger(a.blot) && a.blot! >= 1 && a.blot! <= INK_SEED_MAX);
    assert.equal(a.text, "generated");
  });

  test("an inkblot file is valid with nothing but the common keys", () => {
    const check = new Check();
    assert.ok(validateRandomizer(emptyRandomizer("inkblot", "Inkblot"), check), JSON.stringify(check.issues));
  });
});
