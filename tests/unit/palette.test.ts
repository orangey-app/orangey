import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PALETTE } from "../../src/ui/styles/palette.ts";
import { labelFor } from "../../src/core/color.ts";
import { WHEEL_COLOURS, WHEEL_SPARE, assignWheelColours, distinct, findClashes, toCandidate } from "../../src/core/palette-assign.ts";

describe("the palette", () => {
  test("the editor's palette has no colour or name twice, and every wheel colour carries a readable label", () => {
    assert.ok(PALETTE.length >= 8, `only ${PALETTE.length} colours to choose from`);
    assert.equal(new Set(PALETTE.map((c) => c.name)).size, PALETTE.length, "two colours share a name");
    assert.equal(new Set(PALETTE.map((c) => c.hex)).size, PALETTE.length, "two colours are the same hex");
    for (const c of PALETTE) assert.match(c.hex, /^#[0-9a-f]{6}$/);
    // The wheel's own colours stand in for the curation the old pool had: each
    // takes black or white text at 4.5:1 without being nudged lighter or darker.
    for (const hex of [...WHEEL_COLOURS, WHEEL_SPARE]) {
      const label = labelFor(hex);
      assert.ok(label.ratio >= 4.5 && label.nudges === 0, `${hex} carries a ${label.ratio.toFixed(1)}:1 label after ${label.nudges} nudges`);
    }
  });
});

describe("colour assignment", () => {
  const [RED, YELLOW, BLUE] = WHEEL_COLOURS;

  test("a wheel is red, yellow and blue in turn, and neighbours never look alike, wrap included", () => {
    assert.deepEqual(assignWheelColours([null, null, null, null, null, null]).colors, [RED, YELLOW, BLUE, RED, YELLOW, BLUE]);
    // Four, seven, ten…: the last slice would be red beside the first red one,
    // so it takes the spare.
    assert.deepEqual(assignWheelColours([null, null, null, null]).colors, [RED, YELLOW, BLUE, WHEEL_SPARE]);
    assert.equal(assignWheelColours(new Array(7).fill(null)).colors[6], WHEEL_SPARE);
    for (let n = 1; n <= 300; n++) {
      const r = assignWheelColours(new Array(n).fill(null));
      assert.equal(r.colors.length, n);
      assert.deepEqual(r.clashes, [], `n=${n} clashed at ${JSON.stringify(r.clashes)}`);
      // A linear check passes by accident, because it never compares the last
      // segment with the first. Say so explicitly.
      if (n > 2) assert.ok(distinct(toCandidate(r.colors[n - 1]), toCandidate(r.colors[0])), `n=${n}: the wheel closes on a repeat`);
    }
    // Adding an outcome at the end recolours at most the last slice.
    const eight = assignWheelColours(new Array(8).fill(null)).colors;
    assert.deepEqual(assignWheelColours(new Array(9).fill(null)).colors.slice(0, 7), eight.slice(0, 7));

    // "Distinct" is stricter than plain distance: these two differ in hue and
    // sit far enough apart in OKLab, but collapse onto each other for a
    // deuteranope, and two dark blues are too close whatever the maths says.
    assert.ok(!distinct(toCandidate("#9c6b2f"), toCandidate("#7a7b2c")), "a red/green pair passed the colour-blind check");
    assert.ok(!distinct(toCandidate("#27476b"), toCandidate("#2b3350")));
  });

  test("a colour the user chose is kept exactly, and any clash is reported rather than hidden", () => {
    // A red the user chose in the second slot: the slices either side move off red.
    const fixed = assignWheelColours([null, "#c1440e", null, null, null]);
    assert.equal(fixed.colors[1], "#c1440e");
    assert.ok(distinct(toCandidate(fixed.colors[0]), toCandidate("#c1440e")), "a neighbour did not move out of the way");
    assert.ok(distinct(toCandidate(fixed.colors[2]), toCandidate("#c1440e")));
    assert.deepEqual(fixed.clashes, []);

    const clashing = assignWheelColours([null, "#c1440e", "#c1440e", null]);
    assert.deepEqual(clashing.colors.slice(1, 3), ["#c1440e", "#c1440e"], "the user's choice was overruled");
    assert.deepEqual(clashing.clashes, [[1, 2]]);

    // A wheel wraps round, a plain list does not, so only the wheel counts the
    // last-and-first pair as a clash. And one outcome is never its own clash.
    assert.deepEqual(findClashes(["#a33a30", "#2f6f7c", "#a33a30"], false), []);
    assert.deepEqual(findClashes(["#a33a30", "#2f6f7c", "#a33a30"], true), [[2, 0]]);
    assert.deepEqual(assignWheelColours([null]).clashes, []);
  });
});
