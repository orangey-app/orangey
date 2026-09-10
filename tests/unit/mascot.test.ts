import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { MascotSpring, mascotField } from "../../src/ui/mascot/springs.ts";
import { MascotModel, mascotStateDef, mascotStateNames, registerMascotState } from "../../src/ui/mascot/model.ts";
import { MASCOT_BUILTIN_STATES, isMascotState } from "../../src/ui/mascot/states.ts";
import {
  MASCOT_BODY,
  MASCOT_EYES,
  MASCOT_PIVOT,
  MASCOT_POSES,
  mascotMarkup,
  mascotRestingBodyPath,
} from "../../src/ui/mascot/parts.ts";
import { SeededSource } from "../../src/core/rng.ts";

/** A deterministic random for the model, so a failure is reproducible. */
const seeded = (seed: string) => {
  const src = new SeededSource(seed);
  return () => src.float();
};

const STEP = 1 / 60;
function run(m: MascotModel, seconds: number, each?: (m: MascotModel) => void): void {
  for (let i = 0; i < Math.round(seconds / STEP); i++) {
    m.step(STEP);
    each?.(m);
  }
}

describe("mascot springs", () => {
  test("a spring settles to its target and stops", () => {
    const s = new MascotSpring(168, 7.4);
    s.t = 0.05;
    for (let i = 0; i < 600; i++) s.step(STEP);
    assert.ok(Math.abs(s.x - 0.05) < 1e-4, `x=${s.x}`);
    assert.ok(Math.abs(s.v) < 1e-4, `v=${s.v}`);
  });

  test("clamps hold under 10 000 random impulses, and the spring still returns to zero", () => {
    const random = seeded("clamps");
    const s = new MascotSpring(168, 7.4).clamp(-0.09, 0.09);
    for (let i = 0; i < 10000; i++) {
      if (random() < 0.05) s.kick((random() - 0.5) * 6);
      s.step(STEP);
      assert.ok(s.x >= -0.09 - 1e-12 && s.x <= 0.09 + 1e-12, `escaped the clamp: ${s.x}`);
    }
    for (let i = 0; i < 600; i++) s.step(STEP);
    assert.ok(Math.abs(s.x) < 1e-4, `did not return: ${s.x}`);
  });

  test("the field is the identity when every mode is zero", () => {
    for (const [x, y] of MASCOT_BODY) {
      const [fx, fy] = mascotField(x, y, { squash: 0, slosh: 0, pinch: 0 }, 1.8);
      assert.equal(fx, x);
      assert.equal(fy, y);
    }
  });

  test("the feet never move under squash: the base row is fixed", () => {
    for (const s of [-0.09, -0.03, 0.03, 0.09]) {
      const [, fy] = mascotField(60, 137.2, { squash: s, slosh: 0, pinch: 0 }, 1.8);
      assert.ok(Math.abs(fy - 137.2) < 1e-9, `base moved to ${fy} at squash ${s}`);
    }
  });
});

describe("mascot model — the resting shape is the drawing", () => {
  test("a fresh model draws exactly the owner's body path", () => {
    const m = new MascotModel(seeded("fresh"));
    assert.equal(m.frame().bodyPath, mascotRestingBodyPath());
  });

  test("no state ever sets the squash target: it is derived from a zero-mean breath", () => {
    for (const name of MASCOT_BUILTIN_STATES) {
      const m = new MascotModel(seeded(name));
      m.setState(name);
      let sumT = 0;
      let n = 0;
      run(m, 6.8, (mm) => {
        // 6.8 s is two whole breath periods (2π / 1.85 = 3.396 s)
        sumT += mm.sq.t;
        n++;
        assert.ok(Math.abs(mm.sq.t) <= 0.02 + 1e-9, `${name}: sq.t = ${mm.sq.t}`);
      });
      assert.ok(Math.abs(sumT / n) < 1e-3, `${name}: mean squash target ${sumT / n}`);
      if (name !== "idle") assert.equal(m.breath, 0, `${name} asked for a breath`);
    }
  });

  test("after ten seconds in any state with no impulses, squash has settled to zero", () => {
    for (const name of MASCOT_BUILTIN_STATES) {
      const m = new MascotModel(() => 0.5);
      m.setState(name);
      // idle would hop on its own clock; hold that off by pushing it out
      m.scratch.nudgeAt = 1e9;
      run(m, 10);
      const tail: number[] = [];
      run(m, 3.4, (mm) => tail.push(mm.sq.x));
      const mean = tail.reduce((a, b) => a + b, 0) / tail.length;
      assert.ok(Math.abs(mean) < 1e-3, `${name}: mean squash ${mean} over a breath cycle`);
      if (name !== "idle") for (const x of tail) assert.ok(Math.abs(x) < 1e-3, `${name}: squash ${x}`);
    }
  });

  test("the mean body height over a breath cycle is the drawn height, at every wobble setting", () => {
    // height: the y-extent of the outline's control points, a monotone proxy for the bbox
    const heightOf = (path: string) => {
      const ys = [...path.matchAll(/-?[\d.]+,(-?[\d.]+)/g)].map((m) => Number(m[1]));
      return Math.max(...ys) - Math.min(...ys);
    };
    const drawn = heightOf(mascotRestingBodyPath());
    for (const gain of [0, 1, 1.8]) {
      const m = new MascotModel(() => 0.5);
      m.gain = gain;
      m.setState("idle");
      m.scratch.nudgeAt = 1e9;
      run(m, 4);
      let sum = 0;
      let n = 0;
      run(m, 6.8, (mm) => {
        sum += heightOf(mm.frame().bodyPath);
        n++;
      });
      const mean = sum / n;
      assert.ok(Math.abs(mean / drawn - 1) < 0.005, `gain ${gain}: mean height ${mean} vs drawn ${drawn}`);
    }
  });

  test("standing still injects nothing: grounded, the hop integrator does not run", () => {
    const m = new MascotModel(() => 0.5);
    m.setState("oops"); // no hops of its own
    run(m, 5);
    assert.equal(m.grounded, true);
    assert.equal(m.y, 0);
    assert.equal(m.vy, 0);
    const before = m.sq.x;
    run(m, 1);
    assert.ok(Math.abs(m.sq.x - before) < 1e-6, "squash drifted while standing still");
  });
});

describe("mascot model — poses", () => {
  test("legs are canonical in every state; the anticipation file's nudge is not used", () => {
    assert.deepEqual(MASCOT_PIVOT.L, [72.7, 127.2]);
    assert.deepEqual(MASCOT_PIVOT.R, [118.95, 118.1]);
    assert.match(mascotMarkup(), /class="legL"><path class="l" d="M72\.7,127\.2/);
    assert.match(mascotMarkup(), /class="legR"><path class="l" d="M118\.95,118\.1/);
  });

  test("each pose's eyes land on the drawn placement, within a hundredth of a unit", () => {
    for (const name of MASCOT_BUILTIN_STATES) {
      const m = new MascotModel(() => 0.5);
      m.setState("idle");
      run(m, 1);
      m.setState(name);
      run(m, 2.5);
      const want = MASCOT_EYES[MASCOT_POSES[m.pose].eyes];
      for (const side of ["L", "R"] as const) {
        const e = m.frame().eyes[side];
        assert.ok(Math.hypot(e.cx - want[side][0], e.cy - want[side][1]) < 0.01, `${name} ${side}: (${e.cx}, ${e.cy})`);
        const drot = ((e.rot - want[side][2]) % 180 + 270) % 180 - 90; // ellipse symmetry
        assert.ok(Math.abs(drot) < 0.05, `${name} ${side}: rotation ${e.rot} vs ${want[side][2]}`);
      }
    }
  });

  test("eye rotation takes the short way round between placements", () => {
    const m = new MascotModel(() => 0.5);
    m.setState("idle"); // ec: L at -7.85
    m.setState("anticipate"); // sq: L at -82.96
    const target = m.eye.L.r.t;
    assert.ok(Math.abs(target - -7.85) <= 90.01, `turned ${Math.abs(target - -7.85)}° instead of the short way`);
  });

  test("every pose shows exactly two arms and one mouth in the markup rules", () => {
    for (const pose of Object.values(MASCOT_POSES)) {
      assert.equal(pose.arms.length, 2);
      assert.equal(typeof pose.mouth, "string");
    }
  });
});

describe("mascot state registry", () => {
  test("the five built-in states are registered", () => {
    const names = mascotStateNames();
    for (const s of MASCOT_BUILTIN_STATES) assert.ok(names.includes(s), `missing ${s}`);
    assert.equal(isMascotState("happy"), true);
    assert.equal(isMascotState("smug"), false);
  });

  test("an unknown state resolves to idle, and a registered one is honoured", () => {
    const m = new MascotModel(() => 0.5);
    m.setState("no-such-state");
    assert.equal(m.state, "idle");
    registerMascotState("wave", { pose: "happy", limbs: () => ({ G: -12 }) });
    assert.equal(mascotStateDef("wave").name, "wave");
    m.setState("wave");
    assert.equal(m.state, "wave");
    assert.equal(m.pose, "happy");
    run(m, 2);
    assert.ok(Math.abs(m.frame().limbs.G - -12) < 0.5, "the registered driver ran");
  });

  test("freeze produces one still frame at the pose, and it is the drawing", () => {
    const m = new MascotModel(() => 0.5);
    m.setState("reveal");
    run(m, 0.2);
    m.freeze();
    const f = m.frame();
    assert.equal(f.bodyPath, mascotRestingBodyPath());
    assert.equal(f.pose, "surprised");
    assert.equal(f.offsetY, 0);
  });
});
