import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { arcPath, layout, planSpin, segmentAtPointer } from "../../src/core/wheel-geometry.ts";
import { SeededSource } from "../../src/core/rng.ts";

describe("wheel geometry", () => {
  test("angular area is proportional to weight", () => {
    const segs = layout([{ weight: 50 }, { weight: 20 }, { weight: 20 }, { weight: 10 }], { padAngle: 0.25 });
    const spans = segs.map((s) => s.endAngle - s.startAngle);
    [180, 72, 72, 36].forEach((expected, i) => {
      assert.ok(Math.abs(spans[i] - expected) <= 0.5, `segment ${i}: ${spans[i]} vs ${expected}`);
    });
  });

  test("segments cover the circle exactly", () => {
    const segs = layout([{ weight: 3 }, { weight: 1 }, { weight: 1 }], { padAngle: 0 });
    assert.equal(segs[0].startAngle, 0);
    assert.ok(Math.abs(segs[segs.length - 1].endAngle - 360) < 1e-9);
    for (let i = 1; i < segs.length; i++) {
      assert.ok(Math.abs(segs[i].startAngle - segs[i - 1].endAngle) < 1e-9);
    }
  });

  test("disabled and zero-weight outcomes take no space", () => {
    const segs = layout([{ weight: 1 }, { weight: 0 }, { weight: 1, disabled: true }, { weight: 3 }], { padAngle: 0 });
    assert.deepEqual(segs.map((s) => s.index), [0, 3]);
    assert.ok(Math.abs(segs[0].endAngle - segs[0].startAngle - 90) < 1e-9);
    assert.ok(Math.abs(segs[1].endAngle - segs[1].startAngle - 270) < 1e-9);
  });

  test("with five of twelve disabled the rest still sum to 360", () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ weight: i + 1, disabled: i % 2 === 0 && i < 10 }));
    const segs = layout(items, { padAngle: 0 });
    assert.equal(segs.length, 7);
    const total = segs.reduce((a, s) => a + (s.endAngle - s.startAngle), 0);
    assert.ok(Math.abs(total - 360) < 1e-9, `total ${total}`);
  });

  test("nothing rollable produces no segments", () => {
    assert.deepEqual(layout([{ weight: 0 }, { weight: 1, disabled: true }]), []);
  });

  test("a single outcome fills the wheel without a gap", () => {
    const segs = layout([{ weight: 1 }], { padAngle: 4 });
    assert.equal(segs.length, 1);
    assert.ok(Math.abs(segs[0].endAngle - segs[0].startAngle - 360) < 1e-9);
    assert.ok(arcPath(segs[0], 100, 100, 90).startsWith("M 100 10"));
  });

  test("10000 planned spins all land inside the chosen segment", () => {
    const items = [{ weight: 50 }, { weight: 20 }, { weight: 20 }, { weight: 10 }];
    const segs = layout(items);
    const rng = new SeededSource("spin");
    let rotation = 0;
    for (let i = 0; i < 10000; i++) {
      const target = segs[i % segs.length];
      const plan = planSpin(target, rng, { turns: 6, currentRotation: rotation });
      assert.equal(segmentAtPointer(segs, plan.rotation)?.index, target.index, `spin ${i}`);
      assert.ok(plan.rotation > rotation, "a spin must always go forwards");
      rotation = plan.rotation;
    }
  });

  test("spins land inside even for a very thin segment", () => {
    const items = [{ weight: 999 }, { weight: 1 }];
    const segs = layout(items);
    const rng = new SeededSource("thin");
    for (let i = 0; i < 2000; i++) {
      const plan = planSpin(segs[1], rng, { turns: 3 });
      assert.equal(segmentAtPointer(segs, plan.rotation)?.index, 1);
    }
  });

  test("landing never sits on a segment edge", () => {
    const segs = layout([{ weight: 1 }, { weight: 1 }, { weight: 1 }]);
    const rng = new SeededSource("edges");
    for (let i = 0; i < 2000; i++) {
      const s = segs[i % 3];
      const { landingAngle } = planSpin(s, rng, { turns: 1 });
      const span = s.endAngle - s.startAngle;
      assert.ok(landingAngle >= s.startAngle + span * 0.05, "too close to the start edge");
      assert.ok(landingAngle <= s.endAngle - span * 0.05, "too close to the end edge");
    }
  });

  test("turns = 1 still lands correctly", () => {
    const segs = layout([{ weight: 1 }, { weight: 2 }, { weight: 3 }]);
    const rng = new SeededSource("one-turn");
    for (const s of segs) {
      const plan = planSpin(s, rng, { turns: 1 });
      assert.equal(segmentAtPointer(segs, plan.rotation)?.index, s.index);
      assert.ok(plan.rotation >= 360 && plan.rotation < 720 + 360);
    }
  });

  test("arc paths are well formed for pies and rings", () => {
    const segs = layout([{ weight: 1 }, { weight: 3 }]);
    const pie = arcPath(segs[1], 100, 100, 90);
    const ring = arcPath(segs[1], 100, 100, 90, 40);
    assert.match(pie, /^M 100 100 L .* A 90 90 0 1 1 .* Z$/);
    assert.match(ring, /^M .* A 90 90 0 1 1 .* L .* A 40 40 0 1 0 .* Z$/);
    assert.ok(!pie.includes("NaN") && !ring.includes("NaN"));
  });
});
