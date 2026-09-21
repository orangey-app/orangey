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
  type FeelSettings,
  type SpinCurve,
} from "../../src/ui/feel.ts";

const CURVES = ["gentle", "standard", "snappy"] as const;

describe("feel settings", () => {
  test("a settings file is normalised: unknown values fall back, numbers are clamped and rounded", () => {
    // Settings are hand-editable and travel between versions, so nothing that
    // arrives may throw or reach the animation as it was written.
    assert.deepEqual(normalizeFeel(DEFAULT_FEEL), DEFAULT_FEEL, "the defaults survive untouched");
    assert.deepEqual(normalizeFeel(undefined), DEFAULT_FEEL, "no settings at all are the defaults");
    assert.deepEqual(normalizeFeel({ wheel: "nonsense" }), DEFAULT_FEEL, "a section of the wrong shape is the defaults");

    const at = (f: FeelSettings, path: string): unknown =>
      path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], f);
    const cases: [string, unknown, [string, unknown][]][] = [
      ["a wheel spun far past every limit", { wheel: { durationMs: 999999, turns: 400, curve: "wobbly", settleDegrees: 400 } }, [
        ["wheel.durationMs", LIMITS.wheelDuration[1]],
        ["wheel.turns", LIMITS.turns[1]],
        ["wheel.curve", "standard"],
        ["wheel.settleDegrees", LIMITS.settleDegrees[1]],
      ]],
      ["dice and coins out of range in both directions", { dice: { tumbleMs: -50, bounces: 99, spread: 4 }, coin: { flips: 0, durationMs: 99999, arc: 9 } }, [
        ["dice.tumbleMs", LIMITS.tumble[0]],
        ["dice.bounces", LIMITS.bounces[1]],
        ["dice.spread", LIMITS.spread[1]],
        ["coin.flips", LIMITS.coinFlips[0]],
        ["coin.durationMs", LIMITS.coinDuration[1]],
        ["coin.arc", LIMITS.coinArc[1]],
      ]],
      ["a motion level nobody ships", { motion: "sideways" }, [["motion", "full"]]],
      // Counts of whole things cannot be fractional: half a turn is not a turn.
      ["fractional turns and bounces", { wheel: { turns: 4.7 }, dice: { bounces: 1.4 } }, [["wheel.turns", 5], ["dice.bounces", 1]]],
      // The roll-back used to be a word, and settings files written then are
      // still on people's machines.
      ["the old word 'none'", { wheel: { settle: "none" } }, [["wheel.settleDegrees", 0]]],
      ["the old word 'slight'", { wheel: { settle: "slight" } }, [["wheel.settleDegrees", 4]]],
      ["the old word 'bouncy'", { wheel: { settle: "bouncy" } }, [["wheel.settleDegrees", 11]]],
      ["a number beside the old word: the number wins", { wheel: { settleDegrees: 7, settle: "bouncy" } }, [["wheel.settleDegrees", 7]]],
      // Haptics buzz the device, so only a real `true` switches them on.
      ["haptics left unsaid", {}, [["haptics", false]]],
      ["haptics as a truthy string", { haptics: "yes" }, [["haptics", false]]],
      ["haptics as a real true", { haptics: true }, [["haptics", true]]],
    ];
    for (const [what, input, expectations] of cases) {
      const f = normalizeFeel(input);
      for (const [path, expected] of expectations) assert.equal(at(f, path), expected, `${what}: ${path}`);
    }
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
});

describe("the spin curve", () => {
  test("every curve starts and ends at rest, and never goes backwards on the way", () => {
    for (const curve of CURVES) {
      assert.equal(spinPosition(0, curve), 0);
      assert.equal(spinPosition(1, curve), 1);
      // Eases in: the first twentieth of the time covers well under a twentieth of the distance.
      assert.ok(spinPosition(0.05, curve) < 0.05 * 0.6, `${curve} does not ease in`);
      // Eases out: the last twentieth covers well under a twentieth too.
      assert.ok(1 - spinPosition(0.95, curve) < 0.05 * 0.6, `${curve} does not ease out`);
      let last = -1;
      for (let t = 0; t <= 1.0001; t += 0.01) {
        const p = spinPosition(t, curve);
        assert.ok(p >= last - 1e-12, `${curve} goes backwards at t=${t}`);
        last = p;
      }
    }
  });

  test("a snappier curve gets further, sooner — but even snappy has ground to cover late in the spin", () => {
    assert.ok(spinPosition(0.5, "snappy") > spinPosition(0.5, "standard"));
    assert.ok(spinPosition(0.5, "standard") > spinPosition(0.5, "gentle"));
    assert.equal(curveExponent("gentle"), 2);
    assert.equal(curveExponent("snappy"), 4);
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
  test("a roll-back is a fixed number of degrees, between half the setting and all of it, and the landing bounce follows it", () => {
    // Half to all, so no two spins settle identically, but the setting is
    // still what the GM sees on the wheel.
    const seen = [0, 0.25, 0.5, 0.999].map((r) => settleForSpin(DEFAULT_FEEL, () => r));
    assert.ok(Math.abs(seen[0] - 5.5) < 1e-9, `at the low end ${seen[0]}`);
    assert.ok(seen[3] < 11 && seen[3] > 10.9);
    for (const v of seen) assert.ok(v >= 5.5 && v <= 11);
    assert.equal(settleForSpin({ ...DEFAULT_FEEL, wheel: { ...DEFAULT_FEEL.wheel, settleDegrees: 0 } }), 0);
    // Degrees, not a fraction of the spin: a long spin rolls back as far as a short one.
    assert.ok(Math.abs(overshootFraction(8, 360) * 360 - overshootFraction(8, 3600) * 3600) < 1e-9);
    assert.equal(overshootFraction(0, 360), 0);
    assert.equal(overshootFraction(8, 0), 0);

    // The bounce the wheel lands with is the roll-back made visible, so it
    // grows with the setting and disappears when there is none.
    const at = (deg: number, motion: "full" | "quick" | "instant" = "full") =>
      bounceMs({ ...DEFAULT_FEEL, motion, wheel: { ...DEFAULT_FEEL.wheel, settleDegrees: deg } });
    assert.equal(at(0), 0);
    assert.ok(at(4) > 0 && at(11) > at(4) && at(30) > at(11));
    assert.equal(at(11, "instant"), 0);
    assert.ok(Math.abs(at(11, "quick") - at(11) * 0.4) < 1e-9);
  });
});

describe("a randomizer's own settings", () => {
  test("an override keeps only known keys, clamped, and motion stays global", () => {
    const o = normalizeOverride({ wheel: { turns: 99, bogus: 1 }, dice: { style: "wireframe" }, motion: "instant", coin: {} });
    assert.deepEqual(o, { wheel: { turns: 12 }, dice: { style: "wireframe" } });
    assert.equal(normalizeOverride(null), undefined);
    assert.equal(normalizeOverride({ wheel: {} }), undefined, "an override that says nothing is no override");
    assert.equal(normalizeOverride({ motion: "instant" }), undefined, "motion is global only");
  });

  test("effective settings are the global ones with the override on top", () => {
    const global = { ...DEFAULT_FEEL, wheel: { ...DEFAULT_FEEL.wheel, turns: 8, durationMs: 3000 } };
    const e = effectiveFeel(global, { wheel: { turns: 3 } });
    assert.equal(e.wheel.turns, 3);
    assert.equal(e.wheel.durationMs, 3000, "untouched keys come from the global settings");
    assert.equal(e.dice.style, "flat");
    assert.deepEqual(effectiveFeel(global, undefined), global);
    // The play-time switch forces instant without changing anything else.
    const atPlay = effectiveFeel(DEFAULT_FEEL, { wheel: { turns: 3 } }, true);
    assert.equal(atPlay.motion, "instant");
    assert.equal(atPlay.wheel.turns, 3);
    assert.equal(wheelDuration(atPlay), 0);
  });
});
