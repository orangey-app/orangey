import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { drawNumbers, extremesOf, type NumberSpec } from "../../src/core/number.ts";
import { SeededSource } from "../../src/core/rng.ts";

const spec = (over: Partial<NumberSpec> = {}): NumberSpec => ({
  min: 1, max: 6, integer: true, inclusiveMax: true, count: 1, unique: false, ...over,
});

describe("number extremes", () => {
  test("a draw is an extreme only when every whole number sits on a bound", () => {
    const cases: [string, number[], Partial<NumberSpec>, { isMaximum: boolean; isMinimum: boolean }][] = [
      ["the top of the range", [6], {}, { isMaximum: true, isMinimum: false }],
      ["the bottom of the range", [1], {}, { isMaximum: false, isMinimum: true }],
      ["somewhere in between", [3], {}, { isMaximum: false, isMinimum: false }],
      ["every number on the top bound", [6, 6, 6], { count: 3 }, { isMaximum: true, isMinimum: false }],
      ["all but one on the top bound", [6, 6, 5], { count: 3 }, { isMaximum: false, isMinimum: false }],
      ["every number on the bottom bound", [1, 1], { count: 2 }, { isMaximum: false, isMinimum: true }],
      // a range of one value is both at once, which is honest
      ["a range of a single value", [4], { min: 4, max: 4 }, { isMaximum: true, isMinimum: true }],
      // a decimal draw lands exactly on its bound with probability zero, so
      // announcing one as a maximum would mean nothing
      ["a decimal draw at the top", [6], { integer: false }, { isMaximum: false, isMinimum: false }],
      ["a decimal draw at the bottom", [1], { integer: false }, { isMaximum: false, isMinimum: false }],
    ];
    for (const [what, values, over, expected] of cases) {
      assert.deepEqual(extremesOf(values, spec(over)), expected, what);
    }
  });

  test("drawNumbers carries the flags, and they agree with the values it drew", () => {
    for (let i = 0; i < 2000; i++) {
      const r = drawNumbers(spec({ min: 1, max: 4 }), new SeededSource(`n${i}`));
      assert.equal(r.isMaximum, r.values[0] === 4);
      assert.equal(r.isMinimum, r.values[0] === 1);
    }
  });
});
