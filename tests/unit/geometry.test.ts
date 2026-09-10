import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  arcPath,
  fitLabelToWidth,
  layout,
  MAX_LANDING_TILT,
  planSpin,
  POINTER_ANGLE,
  radialLabelRoom,
  segmentAtPointer,
} from "../../src/core/wheel-geometry.ts";
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

  test("a slice thinner than the gap keeps a positive width", () => {
    const segs = layout([{ weight: 5000 }, { weight: 1 }, { weight: 5000 }], { padAngle: 0.4 });
    for (const s of segs) assert.ok(s.endAngle > s.startAngle, `slice ${s.index}: ${s.startAngle}..${s.endAngle}`);
    assert.ok(segs[1].midAngle > segs[0].endAngle && segs[1].midAngle < segs[2].startAngle);
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

  test("the pointer sits at three o'clock", () => {
    assert.equal(POINTER_ANGLE, 90);
    const segs = layout([{ weight: 1 }, { weight: 1 }, { weight: 1 }], { padAngle: 0 });
    // Unturned, 90° is inside the first slice (0–120°).
    assert.equal(segmentAtPointer(segs, 0)?.index, 0);
    // Turning the wheel 60° anticlockwise brings 150° round to the pointer.
    assert.equal(segmentAtPointer(segs, -60)?.index, 1);
    // And 180° clockwise brings 270°, the third slice.
    assert.equal(segmentAtPointer(segs, 180)?.index, 2);
  });

  test("every winner's label arrives the right way up under the pointer", () => {
    // A label is drawn at rotate(mid − 90), reading outwards. After the spin
    // its lean from horizontal is mid − 90 + rotation; it must never pass
    // MAX_LANDING_TILT, whatever the weights.
    const rng = new SeededSource("upright");
    for (let wheel = 0; wheel < 200; wheel++) {
      const n = 1 + Math.floor(rng.float() * 40);
      const items = Array.from({ length: n }, () => ({ weight: 1 + Math.floor(rng.float() * 60) }));
      const segs = layout(items, { padAngle: 0.4 });
      let rotation = 0;
      for (const target of segs) {
        const plan = planSpin(target, rng, { turns: 6, currentRotation: rotation });
        const lean = ((((target.midAngle - 90 + plan.rotation) % 360) + 540) % 360) - 180;
        assert.ok(Math.abs(lean) <= MAX_LANDING_TILT + 1e-9, `wheel ${wheel}: lean ${lean.toFixed(1)}°`);
        assert.ok(Math.abs(lean) <= (target.endAngle - target.startAngle) / 2, "landed outside its own slice");
        rotation = plan.rotation;
      }
    }
  });

  test("a slice of more than half the wheel still lands near its middle", () => {
    const segs = layout([{ weight: 9 }, { weight: 1 }], { padAngle: 0 });
    const rng = new SeededSource("big");
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < 4000; i++) {
      const { landingAngle } = planSpin(segs[0], rng, { turns: 1 });
      lo = Math.min(lo, landingAngle - segs[0].midAngle);
      hi = Math.max(hi, landingAngle - segs[0].midAngle);
    }
    assert.ok(lo >= -MAX_LANDING_TILT && hi <= MAX_LANDING_TILT, `${lo} .. ${hi}`);
    // …and still uses the whole window rather than one spot.
    assert.ok(lo < -MAX_LANDING_TILT + 2 && hi > MAX_LANDING_TILT - 2, `${lo} .. ${hi}`);
  });
});

describe("radial labels", () => {
  // The wheel component's numbers: a 320 viewBox, labels ending at 135 (short
  // of the pointer's tip at 140), the hub at 16 plus a margin.
  const room = (span: number) => radialLabelRoom(span, { outer: 135, hub: 22 });
  const chars = (r: NonNullable<ReturnType<typeof room>>) => Math.floor(r.length / (0.6 * r.fontSize));

  test("a 48-slice wheel carries nine or more characters per label", () => {
    const r = room(360 / 48 - 0.4);
    assert.ok(r, "48 slices should be labelled");
    assert.ok(chars(r) >= 9, `${chars(r)} characters`);
  });

  test("a 32-slice wheel carries about four times what arc labels did", () => {
    const span = 360 / 32 - 0.4;
    const r = room(span);
    assert.ok(r);
    const before = Math.max(3, Math.floor(span / 3.2));
    assert.ok(chars(r) >= 4 * before - 1, `${chars(r)} characters, was ${before}`);
  });

  test("the text never reaches where the slice is narrower than a line", () => {
    for (let span = 3; span <= 360; span += 0.5) {
      const r = room(span);
      if (!r) continue;
      const half = (Math.min(span, 180) * Math.PI) / 360;
      assert.ok(2 * r.inner * Math.sin(half) >= 1.15 * r.fontSize - 1e-9, `span ${span}`);
      assert.ok(r.inner >= 22, `span ${span} reaches into the hub`);
      assert.ok(r.length > 0);
    }
  });

  test("a sliver carries no label, and bigger slices never lose theirs", () => {
    assert.equal(room(2), null);
    let labelled = false;
    for (let span = 1; span <= 360; span += 0.25) {
      const has = room(span) !== null;
      assert.ok(!labelled || has, `span ${span} lost its label after a smaller one had one`);
      labelled ||= has;
    }
    assert.ok(labelled);
  });

  test("bigger slices get a font at least as big", () => {
    let last = 0;
    for (let span = 5; span <= 360; span += 0.5) {
      const r = room(span);
      if (!r) continue;
      assert.ok(r.fontSize >= last, `span ${span}`);
      last = r.fontSize;
    }
  });

  test("labels are cut to fit, with an ellipsis", () => {
    const mono = (s: string) => Array.from(s).length * 10;
    assert.equal(fitLabelToWidth("Goblin patrol", 200, mono), "Goblin patrol");
    assert.equal(fitLabelToWidth("Goblin patrol", 130, mono), "Goblin patrol");
    assert.equal(fitLabelToWidth("Goblin patrol", 129, mono), "Goblin patr…");
    // Trailing spaces go before the ellipsis, not after it.
    assert.equal(fitLabelToWidth("Goblin patrol", 80, mono), "Goblin…");
    assert.equal(fitLabelToWidth("Goblin", 5, mono), "…");
    // A surrogate pair is one character and is never split.
    assert.equal(fitLabelToWidth("🐺🐺🐺 wolves", 40, mono), "🐺🐺🐺…");
    for (let w = 10; w < 200; w += 7) {
      assert.ok(mono(fitLabelToWidth("The lost travellers of the old road", w, mono)) <= w, `width ${w}`);
    }
  });
});
