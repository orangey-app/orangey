import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PALETTE, SEGMENT_POOL, pool } from "../../src/ui/styles/palette.ts";
import { assignColors, distinct, findClashes, toCandidate } from "../../src/core/palette-assign.ts";

const CANDIDATES = () => SEGMENT_POOL.map((c) => toCandidate(c.hex));

describe("the palette", () => {
  // The curation rules themselves — lightness band, chroma, contrast, the
  // distance between any two colours — are run by `npm run check`, which calls
  // curate() directly. All that is left to check here is that the pool exists
  // and that nothing is in it twice.
  test("the segment pool is not empty, and no colour or name appears twice", () => {
    assert.ok(pool().length >= 8, `only ${pool().length} colours to draw a wheel from`);
    assert.equal(new Set(PALETTE.map((c) => c.name)).size, PALETTE.length, "two colours share a name");
    assert.equal(new Set(PALETTE.map((c) => c.hex)).size, PALETTE.length, "two colours are the same hex");
    for (const c of PALETTE) assert.match(c.hex, /^#[0-9a-f]{6}$/);
  });
});

describe("colour assignment", () => {
  test("neighbours are distinct for every wheel from 2 to 300 outcomes, wrap included", () => {
    const p = CANDIDATES();
    for (let n = 2; n <= 300; n++) {
      const r = assignColors({ fixed: new Array(n).fill(null), id: `wheel-${n}`, pool: p });
      assert.equal(r.colors.length, n);
      assert.deepEqual(r.clashes, [], `n=${n} clashed at ${JSON.stringify(r.clashes)}`);
      assert.equal(r.scale, 1, `n=${n} needed relaxation`);
      // A linear assigner passes the clash check by accident, because it never
      // compares the last segment with the first. Say so explicitly.
      assert.ok(distinct(toCandidate(r.colors[n - 1]), toCandidate(r.colors[0])), `n=${n}: the wheel closes on a repeat`);
    }
    // The same wheel is coloured the same way every time, and two wheels are
    // not: renaming or reweighting an outcome must not recolour the wheel.
    const again = assignColors({ fixed: new Array(9).fill(null), id: "wheel-9", pool: p });
    assert.deepEqual(again.colors, assignColors({ fixed: new Array(9).fill(null), id: "wheel-9", pool: p }).colors);
    assert.notDeepEqual(again.colors, assignColors({ fixed: new Array(9).fill(null), id: "dungeon", pool: p }).colors);

    // "Distinct" is stricter than plain distance: these two differ in hue and
    // sit far enough apart in OKLab, but collapse onto each other for a
    // deuteranope, and two dark blues are too close whatever the maths says.
    assert.ok(!distinct(toCandidate("#9c6b2f"), toCandidate("#7a7b2c")), "a red/green pair passed the colour-blind check");
    assert.ok(!distinct(toCandidate("#27476b"), toCandidate("#2b3350")));
  });

  test("a colour the user chose is kept exactly, and any clash is reported rather than hidden", () => {
    const p = CANDIDATES();
    const fixed = assignColors({ fixed: [null, "#c1440e", null, null, null], id: "fixed", pool: p });
    assert.equal(fixed.colors[1], "#c1440e");
    assert.ok(distinct(toCandidate(fixed.colors[0]), toCandidate("#c1440e")), "a neighbour did not move out of the way");
    assert.ok(distinct(toCandidate(fixed.colors[2]), toCandidate("#c1440e")));

    const clashing = assignColors({ fixed: [null, "#c1440e", "#c1440e", null], id: "clash", pool: p });
    assert.deepEqual(clashing.colors.slice(1, 3), ["#c1440e", "#c1440e"], "the user's choice was overruled");
    assert.deepEqual(clashing.clashes, [[1, 2]]);

    // With two colours and seven segments some pair must repeat; the assigner
    // must terminate and say so rather than pretend.
    const tiny = assignColors({ fixed: new Array(7).fill(null), id: "tiny", pool: ["#a33a30", "#2f6f7c"].map(toCandidate) });
    assert.equal(tiny.colors.length, 7);
    assert.ok(tiny.clashes.length > 0);

    // A wheel wraps round, a plain list does not, so only the wheel counts the
    // last-and-first pair as a clash. And one outcome is never its own clash.
    assert.deepEqual(findClashes(["#a33a30", "#2f6f7c", "#a33a30"], false), []);
    assert.deepEqual(findClashes(["#a33a30", "#2f6f7c", "#a33a30"], true), [[2, 0]]);
    assert.deepEqual(assignColors({ fixed: [null], id: "one", pool: p }).clashes, []);
  });
});
