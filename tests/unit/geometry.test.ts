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
  tickerWindow,
} from "../../src/core/wheel-geometry.ts";
import { SeededSource } from "../../src/core/rng.ts";

describe("wheel geometry", () => {
  test("the ticker's window always contains the winner, however long the list", () => {
    const liveCount = 5000;
    for (const position of [0, 1, 399, 400, 2500, 4998, 4999]) {
      const w = tickerWindow(liveCount, position);
      const rows = w.end - w.start;
      assert.ok(rows > 0, `position ${position}: an empty strip`);
      assert.ok(w.local >= 0 && w.local < rows, `position ${position}: local ${w.local} outside 0..${rows}`);
      assert.equal(w.start + w.local, position, `position ${position}: the window points elsewhere`);
      assert.ok(w.end <= liveCount, `position ${position}: the window runs off the end`);
    }
    // A list shorter than the window is the whole list.
    const small = tickerWindow(3, 2);
    assert.deepEqual(small, { start: 0, end: 3, local: 2 });
  });

  test("a slice's angle is its share of the weight, and the slices cover the circle exactly", () => {
    const segs = layout([{ weight: 50 }, { weight: 20 }, { weight: 20 }, { weight: 10 }], { padAngle: 0.25 });
    const spans = segs.map((s) => s.endAngle - s.startAngle);
    [180, 72, 72, 36].forEach((expected, i) => {
      assert.ok(Math.abs(spans[i] - expected) <= 0.5, `segment ${i}: ${spans[i]} vs ${expected}`);
    });
    // With no gaps the slices meet edge to edge and end where they started.
    const tight = layout([{ weight: 3 }, { weight: 1 }, { weight: 1 }], { padAngle: 0 });
    assert.equal(tight[0].startAngle, 0);
    assert.ok(Math.abs(tight[tight.length - 1].endAngle - 360) < 1e-9);
    for (let i = 1; i < tight.length; i++) {
      assert.ok(Math.abs(tight[i].startAngle - tight[i - 1].endAngle) < 1e-9, `gap before slice ${i}`);
    }
  });

  test("an outcome with no weight, or switched off, takes no space at all", () => {
    const segs = layout([{ weight: 1 }, { weight: 0 }, { weight: 1, disabled: true }, { weight: 3 }], { padAngle: 0 });
    assert.deepEqual(segs.map((s) => s.index), [0, 3], "only the rollable outcomes get a slice");
    assert.ok(Math.abs(segs[0].endAngle - segs[0].startAngle - 90) < 1e-9);
    assert.ok(Math.abs(segs[1].endAngle - segs[1].startAngle - 270) < 1e-9);
    // The survivors share the whole wheel out again, however many are off.
    const items = Array.from({ length: 12 }, (_, i) => ({ weight: i + 1, disabled: i % 2 === 0 && i < 10 }));
    const half = layout(items, { padAngle: 0 });
    assert.equal(half.length, 7);
    const total = half.reduce((a, s) => a + (s.endAngle - s.startAngle), 0);
    assert.ok(Math.abs(total - 360) < 1e-9, `total ${total}`);
    assert.deepEqual(layout([{ weight: 0 }, { weight: 1, disabled: true }]), [], "nothing rollable is no wheel");
  });

  test("a slice thinner than the gap keeps a positive width", () => {
    const segs = layout([{ weight: 5000 }, { weight: 1 }, { weight: 5000 }], { padAngle: 0.4 });
    for (const s of segs) assert.ok(s.endAngle > s.startAngle, `slice ${s.index}: ${s.startAngle}..${s.endAngle}`);
    assert.ok(segs[1].midAngle > segs[0].endAngle && segs[1].midAngle < segs[2].startAngle);
  });

  test("a single outcome fills the wheel without a gap, and every arc path is well formed", () => {
    const one = layout([{ weight: 1 }], { padAngle: 4 });
    assert.equal(one.length, 1);
    assert.ok(Math.abs(one[0].endAngle - one[0].startAngle - 360) < 1e-9, "there is nothing to leave a gap from");
    assert.ok(arcPath(one[0], 100, 100, 90).startsWith("M 100 10"));
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

  test("a planned spin lands inside the segment it was told to land in, however thin", () => {
    const segs = layout([{ weight: 50 }, { weight: 20 }, { weight: 20 }, { weight: 10 }]);
    const rng = new SeededSource("spin");
    let rotation = 0;
    for (let i = 0; i < 10000; i++) {
      const target = segs[i % segs.length];
      const plan = planSpin(target, rng, { turns: 6, currentRotation: rotation });
      assert.equal(segmentAtPointer(segs, plan.rotation)?.index, target.index, `spin ${i}`);
      assert.ok(plan.rotation > rotation, "a spin must always go forwards");
      rotation = plan.rotation;
    }
    // A one-in-a-thousand slice is the case that used to slip past the pointer.
    const thin = layout([{ weight: 999 }, { weight: 1 }]);
    const thinRng = new SeededSource("thin");
    for (let i = 0; i < 2000; i++) {
      assert.equal(segmentAtPointer(thin, planSpin(thin[1], thinRng, { turns: 3 }).rotation)?.index, 1, `thin spin ${i}`);
    }
    // The shortest spin has the least room to correct itself.
    const short = layout([{ weight: 1 }, { weight: 2 }, { weight: 3 }]);
    const shortRng = new SeededSource("one-turn");
    for (const s of short) {
      const plan = planSpin(s, shortRng, { turns: 1 });
      assert.equal(segmentAtPointer(short, plan.rotation)?.index, s.index);
      assert.ok(plan.rotation >= 360 && plan.rotation < 720 + 360);
    }
  });

  test("a landing sits clear of the edges, and uses the whole window it is given", () => {
    const thirds = layout([{ weight: 1 }, { weight: 1 }, { weight: 1 }]);
    const rng = new SeededSource("edges");
    for (let i = 0; i < 2000; i++) {
      const s = thirds[i % 3];
      const { landingAngle } = planSpin(s, rng, { turns: 1 });
      const span = s.endAngle - s.startAngle;
      assert.ok(landingAngle >= s.startAngle + span * 0.05, "too close to the start edge");
      assert.ok(landingAngle <= s.endAngle - span * 0.05, "too close to the end edge");
    }
    // A slice bigger than the tilt allows is held near its middle instead…
    const big = layout([{ weight: 9 }, { weight: 1 }], { padAngle: 0 });
    const bigRng = new SeededSource("big");
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < 4000; i++) {
      const { landingAngle } = planSpin(big[0], bigRng, { turns: 1 });
      lo = Math.min(lo, landingAngle - big[0].midAngle);
      hi = Math.max(hi, landingAngle - big[0].midAngle);
    }
    assert.ok(lo >= -MAX_LANDING_TILT && hi <= MAX_LANDING_TILT, `${lo} .. ${hi}`);
    // …and still uses the whole window rather than one spot.
    assert.ok(lo < -MAX_LANDING_TILT + 2 && hi > MAX_LANDING_TILT - 2, `${lo} .. ${hi}`);
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
});

describe("radial labels", () => {
  // The wheel component's numbers: a 320 viewBox, labels ending at 135 (short
  // of the pointer's tip at 140), the hub at 16 plus a margin.
  const room = (span: number) => radialLabelRoom(span, { outer: 135, hub: 22 });
  const chars = (r: NonNullable<ReturnType<typeof room>>) => Math.floor(r.length / (0.6 * r.fontSize));

  test("a label fits the slice it sits in, and a sliver gets none", () => {
    let last = 0;
    let labelled = false;
    for (let span = 1; span <= 360; span += 0.25) {
      const r = room(span);
      const has = r !== null;
      // Once a slice is wide enough to be labelled, every wider one is too.
      assert.ok(!labelled || has, `span ${span} lost its label after a smaller one had one`);
      labelled ||= has;
      if (!r) continue;
      // The text stops before the slice gets narrower than a line of it…
      const half = (Math.min(span, 180) * Math.PI) / 360;
      assert.ok(2 * r.inner * Math.sin(half) >= 1.15 * r.fontSize - 1e-9, `span ${span}: the text runs into the slice's edges`);
      assert.ok(r.inner >= 22, `span ${span} reaches into the hub`);
      assert.ok(r.length > 0, `span ${span} has no room to write in`);
      // …and a bigger slice is never given smaller type than a smaller one.
      if (span >= 5) {
        assert.ok(r.fontSize >= last, `span ${span} got smaller type than the slice before it`);
        last = r.fontSize;
      }
    }
    assert.ok(labelled, "some slice must be labelled");
    assert.equal(room(2), null, "a 2° sliver has nowhere to put a word");
    // The room this buys is the reason for reading outwards rather than round
    // the arc: a crowded wheel still carries a readable label.
    const crowded = room(360 / 48 - 0.4);
    assert.ok(crowded, "48 slices should still be labelled");
    assert.ok(chars(crowded) >= 9, `a 48-slice wheel carries only ${chars(crowded)} characters`);
    const span32 = 360 / 32 - 0.4;
    const r32 = room(span32);
    assert.ok(r32);
    const alongTheArc = Math.max(3, Math.floor(span32 / 3.2));
    assert.ok(chars(r32) >= 4 * alongTheArc - 1, `${chars(r32)} characters, where an arc label gave ${alongTheArc}`);
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
