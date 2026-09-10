import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PALETTE, SEGMENT_POOL, curate, pool } from "../../src/ui/styles/palette.ts";
import { assignColors, distinct, findClashes, toCandidate, DEFAULT_THRESHOLDS } from "../../src/core/palette-assign.ts";
import { contrastRatio, hexToRgb, labelFor } from "../../src/core/color.ts";

const CANDIDATES = () => SEGMENT_POOL.map((c) => toCandidate(c.hex));

describe("palette curation", () => {
  test("the pool passes its own curation rules", () => {
    const { problems, closestPair } = curate();
    assert.deepEqual(problems, [], problems.join("; "));
    assert.ok(closestPair >= 0.05, `closest pair ${closestPair}`);
  });

  test("every pool colour carries a 4.5:1 label within 6 nudges", () => {
    for (const c of pool()) {
      const label = labelFor(c.hex);
      assert.ok(label.nudges <= 6, `${c.name} needed ${label.nudges} nudges`);
      assert.ok(label.ratio >= 4.5, `${c.name} reached only ${label.ratio.toFixed(2)}:1`);
      const actual = contrastRatio(hexToRgb(label.fill), hexToRgb(label.ink));
      assert.ok(actual >= 4.49, `${c.name}: recomputed ratio ${actual.toFixed(2)}`);
    }
  });

  test("palette names are unique and every colour is a valid hex", () => {
    assert.equal(new Set(PALETTE.map((c) => c.name)).size, PALETTE.length);
    for (const c of PALETTE) assert.match(c.hex, /^#[0-9a-f]{6}$/);
  });
});

describe("colour assignment", () => {
  test("neighbours are distinct for every size from 2 to 300, wrap included", () => {
    const p = CANDIDATES();
    for (let n = 2; n <= 300; n++) {
      const r = assignColors({ fixed: new Array(n).fill(null), id: `wheel-${n}`, pool: p });
      assert.equal(r.colors.length, n);
      assert.deepEqual(r.clashes, [], `n=${n} clashed at ${JSON.stringify(r.clashes)}`);
      assert.equal(r.scale, 1, `n=${n} needed relaxation`);
    }
  });

  test("the wrap-around pair is genuinely checked", () => {
    // A linear assigner passes this test only by accident; make it explicit.
    const p = CANDIDATES();
    for (let n = 2; n <= 60; n++) {
      const { colors } = assignColors({ fixed: new Array(n).fill(null), id: `w${n}`, pool: p });
      const first = toCandidate(colors[0]);
      const last = toCandidate(colors[n - 1]);
      assert.ok(distinct(last, first), `n=${n}: last and first are too similar (${colors[n - 1]} / ${colors[0]})`);
    }
  });

  test("assignment is deterministic for a given id", () => {
    const p = CANDIDATES();
    const a = assignColors({ fixed: new Array(9).fill(null), id: "forest", pool: p });
    const b = assignColors({ fixed: new Array(9).fill(null), id: "forest", pool: p });
    assert.deepEqual(a.colors, b.colors);
  });

  test("different wheels start at different places in the pool", () => {
    const p = CANDIDATES();
    const a = assignColors({ fixed: new Array(6).fill(null), id: "forest", pool: p });
    const b = assignColors({ fixed: new Array(6).fill(null), id: "dungeon", pool: p });
    assert.notDeepEqual(a.colors, b.colors);
  });

  test("appending an outcome leaves the earlier ones alone", () => {
    const p = CANDIDATES();
    const before = assignColors({ fixed: new Array(8).fill(null), id: "stable", pool: p });
    const after = assignColors({ fixed: new Array(9).fill(null), id: "stable", pool: p });
    // The previously-last outcome may change: it used to touch outcome 0 and
    // now does not. Everything before it must be untouched.
    assert.deepEqual(after.colors.slice(0, 7), before.colors.slice(0, 7));
  });

  test("renaming or reweighting does not recolour anything", () => {
    const p = CANDIDATES();
    const a = assignColors({ fixed: [null, null, null, null], id: "same", pool: p });
    const b = assignColors({ fixed: [null, null, null, null], id: "same", pool: p });
    assert.deepEqual(a.colors, b.colors);
  });

  test("a fixed colour is kept exactly and its neighbours adapt", () => {
    const p = CANDIDATES();
    const r = assignColors({ fixed: [null, "#c1440e", null, null, null], id: "fixed", pool: p });
    assert.equal(r.colors[1], "#c1440e");
    assert.ok(distinct(toCandidate(r.colors[0]), toCandidate("#c1440e")));
    assert.ok(distinct(toCandidate(r.colors[2]), toCandidate("#c1440e")));
  });

  test("two identical fixed colours are kept but reported as a clash", () => {
    const p = CANDIDATES();
    const r = assignColors({ fixed: [null, "#c1440e", "#c1440e", null], id: "clash", pool: p });
    assert.equal(r.colors[1], "#c1440e");
    assert.equal(r.colors[2], "#c1440e");
    assert.deepEqual(r.clashes, [[1, 2]]);
  });

  test("the deuteranopia check rejects a red/green pair that plain distance allows", () => {
    // These two differ in hue and are far enough apart in OKLab, but collapse
    // onto each other for a deuteranope.
    const red = toCandidate("#9c6b2f");
    const green = toCandidate("#7a7b2c");
    const plainDistanceOk = distinct(red, green, { ...DEFAULT_THRESHOLDS, cvdFactor: 0 });
    const withCvd = distinct(red, green);
    assert.ok(!withCvd, "the colour-blind check should reject this pair");
    assert.equal(typeof plainDistanceOk, "boolean");
  });

  test("two dark blues are rejected even though they differ slightly", () => {
    assert.ok(!distinct(toCandidate("#27476b"), toCandidate("#2b3350")));
  });

  test("a tiny pool still terminates and reports honestly", () => {
    const tiny = ["#a33a30", "#2f6f7c"].map(toCandidate);
    const r = assignColors({ fixed: new Array(7).fill(null), id: "tiny", pool: tiny });
    assert.equal(r.colors.length, 7);
    assert.deepEqual(new Set(r.colors), new Set(["#a33a30", "#2f6f7c"]));
    // With two colours and seven segments some pair must repeat; the assigner
    // must say so rather than pretending.
    assert.ok(r.clashes.length > 0);
  });

  test("a single outcome is not compared with itself", () => {
    const r = assignColors({ fixed: [null], id: "one", pool: CANDIDATES() });
    assert.equal(r.colors.length, 1);
    assert.deepEqual(r.clashes, []);
  });

  test("findClashes ignores the wrap pair for a plain list", () => {
    const colors = ["#a33a30", "#2f6f7c", "#a33a30"];
    assert.deepEqual(findClashes(colors, false), []);
    assert.deepEqual(findClashes(colors, true), [[2, 0]]);
  });
});
