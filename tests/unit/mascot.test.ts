import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { MascotModel, mascotStateDef, mascotStateNames, registerMascotState } from "../../src/ui/mascot/model.ts";
import { MASCOT_BUILTIN_STATES, isMascotState } from "../../src/ui/mascot/states.ts";
import { mascotRestingBodyPath } from "../../src/ui/mascot/parts.ts";

const STEP = 1 / 60;
function run(m: MascotModel, seconds: number, each?: (m: MascotModel) => void): void {
  for (let i = 0; i < Math.round(seconds / STEP); i++) {
    m.step(STEP);
    each?.(m);
  }
}

describe("mascot state registry", () => {
  test("a state is what the registry says it is, and anything else is idle", () => {
    const names = mascotStateNames();
    for (const s of MASCOT_BUILTIN_STATES) assert.ok(names.includes(s), `missing ${s}`);
    assert.equal(isMascotState("happy"), true);
    assert.equal(isMascotState("smug"), false);

    // A reaction table can name a state that this build does not have — an old
    // settings file, or a row from a plugin — and that must not stop the show.
    const m = new MascotModel(() => 0.5);
    m.setState("no-such-state");
    assert.equal(m.state, "idle");

    // Adding a state is registering one: nothing upstream is edited.
    registerMascotState("wave", { pose: "happy", limbs: () => ({ G: -12 }) });
    assert.equal(mascotStateDef("wave").name, "wave");
    m.setState("wave");
    assert.equal(m.state, "wave");
    assert.equal(m.pose, "happy");
    run(m, 2);
    assert.ok(Math.abs(m.frame().limbs.G - -12) < 0.5, "the registered driver ran");
  });
});

describe("the resting shape is the drawing", () => {
  test("a fresh model draws the owner's body path, and a frozen one returns to it", () => {
    assert.equal(new MascotModel(() => 0.5).frame().bodyPath, mascotRestingBodyPath());
    // A frozen mascot is the still picture used where motion is switched off,
    // so it has to be the drawing rather than whatever frame it stopped on.
    const m = new MascotModel(() => 0.5);
    m.setState("reveal");
    run(m, 0.2);
    m.freeze();
    const f = m.frame();
    assert.equal(f.bodyPath, mascotRestingBodyPath());
    assert.equal(f.pose, "surprised");
    assert.equal(f.offsetY, 0);
  });

  test("in every state he settles back to standing, rather than drifting out of shape", () => {
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
      // Nothing may aim him away from the drawn shape: the breath is the only
      // squash there is, and it averages to nothing.
      const held = new MascotModel(() => 0.5);
      held.setState(name);
      run(held, 6.8, (mm) => assert.ok(Math.abs(mm.sq.t) <= 0.02 + 1e-9, `${name}: sq.t = ${mm.sq.t}`));
      if (name !== "idle") assert.equal(held.breath, 0, `${name} asked for a breath`);
    }
  });

  test("the mean body height over a breath cycle is the drawn height, at every wobble setting", () => {
    // height: the y-extent of the outline's control points, a monotone proxy
    // for the bbox. A wobble that inflated him would grow the layout around him.
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
      assert.ok(Math.abs(sum / n / drawn - 1) < 0.005, `gain ${gain}: mean height ${sum / n} vs drawn ${drawn}`);
    }
  });
});
