import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_FEEL,
  LIMITS,
  bounceMs,
  coinDuration,
  curveExponent,
  diceDuration,
  easeSpin,
  effectiveFeel,
  motionScale,
  normalizeFeel,
  normalizeOverride,
  overshootFraction,
  settleForSpin,
  spinPosition,
  wheelDuration,
} from "../../src/ui/feel.ts";

describe("feel settings", () => {
  test("defaults survive normalisation unchanged", () => {
    assert.deepEqual(normalizeFeel(DEFAULT_FEEL), DEFAULT_FEEL);
  });

  test("missing or corrupt values fall back to the defaults", () => {
    assert.deepEqual(normalizeFeel(undefined), DEFAULT_FEEL);
    assert.deepEqual(normalizeFeel({ wheel: "nonsense" }), DEFAULT_FEEL);
    assert.equal(normalizeFeel({ motion: "sideways" }).motion, "full");
  });

  test("out-of-range values are clamped rather than rejected", () => {
    const f = normalizeFeel({
      wheel: { durationMs: 999999, turns: 400, curve: "wobbly", settleDegrees: 400 },
      dice: { tumbleMs: -50, bounces: 99, spread: 4 },
      coin: { flips: 0, durationMs: 99999, arc: 9 },
    });
    assert.equal(f.wheel.durationMs, LIMITS.wheelDuration[1]);
    assert.equal(f.wheel.turns, LIMITS.turns[1]);
    assert.equal(f.wheel.curve, "standard");
    assert.equal(f.wheel.settleDegrees, LIMITS.settleDegrees[1]);
    assert.equal(f.dice.tumbleMs, LIMITS.tumble[0]);
    assert.equal(f.dice.bounces, LIMITS.bounces[1]);
    assert.equal(f.dice.spread, LIMITS.spread[1]);
    assert.equal(f.coin.flips, LIMITS.coinFlips[0]);
    assert.equal(f.coin.durationMs, LIMITS.coinDuration[1]);
    assert.equal(f.coin.arc, LIMITS.coinArc[1]);
  });

  test("the roll-back that used to be a word is read as degrees", () => {
    assert.equal(normalizeFeel({ wheel: { settle: "none" } }).wheel.settleDegrees, 0);
    assert.equal(normalizeFeel({ wheel: { settle: "slight" } }).wheel.settleDegrees, 4);
    assert.equal(normalizeFeel({ wheel: { settle: "bouncy" } }).wheel.settleDegrees, 11);
    assert.equal(normalizeFeel({ wheel: { settleDegrees: 7, settle: "bouncy" } }).wheel.settleDegrees, 7, "the number wins");
  });

  test("turns and bounces are whole numbers", () => {
    const f = normalizeFeel({ wheel: { turns: 4.7 }, dice: { bounces: 1.4 } });
    assert.equal(f.wheel.turns, 5);
    assert.equal(f.dice.bounces, 1);
  });

  test("quick is 0.4x and instant is zero", () => {
    assert.equal(motionScale("full"), 1);
    assert.equal(motionScale("quick"), 0.4);
    assert.equal(motionScale("instant"), 0);
    const f = { ...DEFAULT_FEEL, motion: "quick" as const };
    assert.equal(wheelDuration(f), DEFAULT_FEEL.wheel.durationMs * 0.4);
    assert.equal(diceDuration(f), DEFAULT_FEEL.dice.tumbleMs * 0.4);
    assert.equal(coinDuration(f), DEFAULT_FEEL.coin.durationMs * 0.4);
    assert.equal(wheelDuration({ ...DEFAULT_FEEL, motion: "instant" }), 0);
  });

  test("haptics default to off and only accept a real true", () => {
    assert.equal(normalizeFeel({}).haptics, false);
    assert.equal(normalizeFeel({ haptics: "yes" }).haptics, false);
    assert.equal(normalizeFeel({ haptics: true }).haptics, true);
  });
});

describe("the spin curve", () => {
  test("starts and ends at rest", () => {
    for (const curve of ["gentle", "standard", "snappy"] as const) {
      assert.equal(spinPosition(0, curve), 0);
      assert.equal(spinPosition(1, curve), 1);
      // Eases in: the first twentieth of the time covers well under a twentieth of the distance.
      assert.ok(spinPosition(0.05, curve) < 0.05 * 0.6, `${curve} does not ease in`);
      // Eases out: the last twentieth covers well under a twentieth too.
      assert.ok(1 - spinPosition(0.95, curve) < 0.05 * 0.6, `${curve} does not ease out`);
    }
  });

  test("is monotonic", () => {
    for (const curve of ["gentle", "standard", "snappy"] as const) {
      let last = -1;
      for (let t = 0; t <= 1.0001; t += 0.01) {
        const p = spinPosition(t, curve);
        assert.ok(p >= last - 1e-12, `${curve} goes backwards at t=${t}`);
        last = p;
      }
    }
  });

  test("a snappier curve is further along at the halfway point", () => {
    assert.ok(spinPosition(0.5, "snappy") > spinPosition(0.5, "standard"));
    assert.ok(spinPosition(0.5, "standard") > spinPosition(0.5, "gentle"));
    assert.equal(curveExponent("gentle"), 2);
    assert.equal(curveExponent("snappy"), 5);
  });

  test("easeSpin overshoots past the target near the end, then comes back to it", () => {
    const none = { ...DEFAULT_FEEL, wheel: { ...DEFAULT_FEEL.wheel, settleDegrees: 0 } };
    assert.equal(easeSpin(0.5, none), easeSpin(0.5, DEFAULT_FEEL));
    let sawOvershoot = false;
    for (let t = 0.75; t < 1; t += 0.01) {
      const v = easeSpin(t, DEFAULT_FEEL, 0.02);
      assert.ok(v >= easeSpin(t, none), "the bounce must never fall behind the plain curve");
      if (v > 1) sawOvershoot = true;
    }
    assert.ok(sawOvershoot, "a roll-back should swing past its target");
    assert.equal(easeSpin(1, DEFAULT_FEEL, 0.02), 1);
    assert.equal(easeSpin(1, none), 1);
  });
});

describe("roll-back and bounce", () => {
  test("each spin uses between half and all of the maximum", () => {
    const seen = [0, 0.25, 0.5, 0.999].map((r) => settleForSpin(DEFAULT_FEEL, () => r));
    assert.ok(Math.abs(seen[0] - 5.5) < 1e-9, `at the low end ${seen[0]}`);
    assert.ok(seen[3] < 11 && seen[3] > 10.9);
    for (const v of seen) assert.ok(v >= 5.5 && v <= 11);
    assert.equal(settleForSpin({ ...DEFAULT_FEEL, wheel: { ...DEFAULT_FEEL.wheel, settleDegrees: 0 } }), 0);
  });

  test("the overshoot is a fixed number of degrees whatever the spin length", () => {
    assert.ok(Math.abs(overshootFraction(8, 360) * 360 - overshootFraction(8, 3600) * 3600) < 1e-9);
    assert.equal(overshootFraction(0, 360), 0);
    assert.equal(overshootFraction(8, 0), 0);
  });

  test("the landing bounce grows with the roll-back and follows the motion level", () => {
    const at = (deg: number, motion: "full" | "quick" | "instant" = "full") =>
      bounceMs({ ...DEFAULT_FEEL, motion, wheel: { ...DEFAULT_FEEL.wheel, settleDegrees: deg } });
    assert.equal(at(0), 0);
    assert.ok(at(4) > 0 && at(11) > at(4) && at(30) > at(11));
    assert.equal(at(11, "instant"), 0);
    assert.ok(Math.abs(at(11, "quick") - at(11) * 0.4) < 1e-9);
  });
});

describe("a randomizer's own settings", () => {
  test("an override keeps only known keys, clamped", () => {
    const o = normalizeOverride({ wheel: { turns: 99, bogus: 1 }, dice: { style: "wireframe" }, motion: "instant", coin: {} });
    assert.deepEqual(o, { wheel: { turns: 12 }, dice: { style: "wireframe" } });
    assert.equal(normalizeOverride(null), undefined);
    assert.equal(normalizeOverride({ wheel: {} }), undefined);
    assert.equal(normalizeOverride({ motion: "instant" }), undefined, "motion is global only");
  });

  test("effective settings are the global ones with the override on top", () => {
    const global = { ...DEFAULT_FEEL, wheel: { ...DEFAULT_FEEL.wheel, turns: 8, durationMs: 3000 } };
    const e = effectiveFeel(global, { wheel: { turns: 3 } });
    assert.equal(e.wheel.turns, 3);
    assert.equal(e.wheel.durationMs, 3000, "untouched keys come from the global settings");
    assert.equal(e.dice.style, "flat");
    assert.deepEqual(effectiveFeel(global, undefined), global);
  });

  test("the play-time switch forces instant without changing anything else", () => {
    const e = effectiveFeel(DEFAULT_FEEL, { wheel: { turns: 3 } }, true);
    assert.equal(e.motion, "instant");
    assert.equal(e.wheel.turns, 3);
    assert.equal(wheelDuration(e), 0);
  });
});
