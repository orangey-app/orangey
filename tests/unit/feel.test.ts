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
  type SpinCurve,
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
    assert.equal(curveExponent("snappy"), 4);
  });

  test("even snappy still has ground to cover late in the spin", () => {
    // At exponent 5 a six-turn snappy spin had 3° of 2340° left by t=0.70: the
    // last third of the duration was a wheel standing still.
    const delta = 6 * 360 + 180;
    assert.ok((1 - spinPosition(0.7, "snappy")) * delta > 15, `${((1 - spinPosition(0.7, "snappy")) * delta).toFixed(1)}° left at t=0.70`);
    // …and it is still the sharpest wind-down of the three.
    assert.ok(1 - spinPosition(0.7, "snappy") < (1 - spinPosition(0.7, "standard")) / 3);
  });

  test("easeSpin overshoots past the target near the end, then comes back to it", () => {
    const none = { ...DEFAULT_FEEL, wheel: { ...DEFAULT_FEEL.wheel, settleDegrees: 0 } };
    assert.equal(easeSpin(0.5, none), spinPosition(0.5, none.wheel.curve));
    // The roll-back is spread through the whole spin rather than bolted on at
    // the end, so a wheel that has to go past its target and come back is a
    // little ahead of a plain one on the way there.
    assert.ok(easeSpin(0.5, DEFAULT_FEEL, 0.02) > easeSpin(0.5, none));
    let sawOvershoot = false;
    for (let t = 0.75; t < 1; t += 0.01) {
      const v = easeSpin(t, DEFAULT_FEEL, 0.02);
      assert.ok(v >= easeSpin(t, none), "the bounce must never fall behind the plain curve");
      if (v > 1) sawOvershoot = true;
    }
    assert.ok(sawOvershoot, "a roll-back should swing past its target");
    assert.equal(easeSpin(1, DEFAULT_FEEL, 0.02), 1);
    assert.equal(easeSpin(1, none), 1);
    assert.equal(easeSpin(0, DEFAULT_FEEL, 0.02), 0);
  });

  /** Speeds sampled at 60 fps through one spin, in degrees of a `delta`° spin. */
  const speeds = (curve: SpinCurve, overshoot: number, delta = 6 * 360 + 180, durationMs = 3200): number[] => {
    const feel = { ...DEFAULT_FEEL, wheel: { ...DEFAULT_FEEL.wheel, curve } };
    const step = 16.7 / durationMs;
    const out: number[] = [];
    for (let t = 0; t < 1; t += step) {
      out.push((easeSpin(Math.min(1, t + step), feel, overshoot) - easeSpin(t, feel, overshoot)) * delta);
    }
    return out;
  };
  const CURVES = ["gentle", "standard", "snappy"] as const;
  const ROLLBACKS = [1, 4, 11, 30];

  test("the wheel passes the target by exactly the roll-back it was given", () => {
    const delta = 6 * 360 + 180;
    for (const curve of CURVES) {
      const feel = { ...DEFAULT_FEEL, wheel: { ...DEFAULT_FEEL.wheel, curve } };
      for (const degrees of ROLLBACKS) {
        let peak = -Infinity;
        for (let t = 0; t <= 1; t += 0.0005) peak = Math.max(peak, (easeSpin(t, feel, degrees / delta) - 1) * delta);
        // It used to be whatever the curve happened to be doing at t=0.75:
        // the same 11° setting gave 4.7° on gentle and 10.1° on snappy.
        assert.ok(Math.abs(peak - degrees) < degrees * 0.02, `${curve} with ${degrees}° went ${peak.toFixed(2)}° past`);
      }
    }
  });

  test("the wheel turns back once, and only once", () => {
    for (const curve of CURVES) {
      for (const degrees of ROLLBACKS) {
        const v = speeds(curve, degrees / (6 * 360 + 180));
        let turns = 0;
        for (let i = 1; i < v.length; i++) if (Math.sign(v[i]) !== Math.sign(v[i - 1]) && Math.abs(v[i]) > 1e-9) turns++;
        assert.equal(turns, 1, `${curve} with ${degrees}° changed direction ${turns} times`);
      }
    }
  });

  test("the wheel never speeds up while it is still going forwards", () => {
    // The old roll-back was added on top of a finished curve from t=0.75, and
    // began with a speed of its own: under snappy that more than doubled the
    // wheel's speed from one frame to the next — the halt-then-jump.
    for (const curve of CURVES) {
      for (const degrees of ROLLBACKS) {
        const v = speeds(curve, degrees / (6 * 360 + 180));
        for (let i = 1; i < v.length; i++) {
          if (i / v.length < 0.2 || v[i] <= 0 || v[i - 1] <= 0) continue;
          assert.ok(v[i] <= v[i - 1] * 1.02 + 1e-6, `${curve} with ${degrees}°: ${v[i - 1].toFixed(2)} -> ${v[i].toFixed(2)}°/frame`);
        }
      }
    }
  });

  test("a spin with a roll-back is smooth at any length", () => {
    for (const curve of CURVES) {
      for (const durationMs of [400, 1280, 3200, 8000]) {
        const v = speeds(curve, 11 / (6 * 360 + 180), 6 * 360 + 180, durationMs);
        // No frame may change the speed by more than the spin's own average
        // speed; a step of that size is the lurch this replaced.
        const average = v.reduce((a, b) => a + Math.abs(b), 0) / v.length;
        // The ramp-in is a deliberate change of speed; the wind-down is what
        // this is about, so start once the wheel is up to speed.
        for (let i = Math.ceil(v.length * 0.25); i < v.length; i++) {
          assert.ok(Math.abs(v[i] - v[i - 1]) <= average, `${curve} at ${durationMs}ms: ${(v[i] - v[i - 1]).toFixed(2)}°/frame step against an average of ${average.toFixed(2)}`);
        }
      }
    }
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
