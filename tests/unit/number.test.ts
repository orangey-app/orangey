import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { drawNumbers, extremesOf, type NumberSpec } from "../../src/core/number.ts";
import { SeededSource } from "../../src/core/rng.ts";

const spec = (over: Partial<NumberSpec> = {}): NumberSpec => ({
  min: 1, max: 6, integer: true, inclusiveMax: true, count: 1, unique: false, ...over,
});

describe("number extremes", () => {
  test("a whole-number draw at the top of its range is a maximum, at the bottom a minimum", () => {
    assert.deepEqual(extremesOf([6], spec()), { isMaximum: true, isMinimum: false });
    assert.deepEqual(extremesOf([1], spec()), { isMaximum: false, isMinimum: true });
    assert.deepEqual(extremesOf([3], spec()), { isMaximum: false, isMinimum: false });
  });

  test("with several numbers, every one must sit on the bound", () => {
    assert.deepEqual(extremesOf([6, 6, 6], spec({ count: 3 })), { isMaximum: true, isMinimum: false });
    assert.deepEqual(extremesOf([6, 6, 5], spec({ count: 3 })), { isMaximum: false, isMinimum: false });
    assert.deepEqual(extremesOf([1, 1], spec({ count: 2 })), { isMaximum: false, isMinimum: true });
  });

  test("a one-number range is both at once, which is honest", () => {
    assert.deepEqual(extremesOf([4], spec({ min: 4, max: 4 })), { isMaximum: true, isMinimum: true });
  });

  test("decimal draws never report an extreme", () => {
    assert.deepEqual(extremesOf([6], spec({ integer: false })), { isMaximum: false, isMinimum: false });
    assert.deepEqual(extremesOf([1], spec({ integer: false })), { isMaximum: false, isMinimum: false });
  });

  test("drawNumbers carries the flags, and they agree with the values for 2000 seeded draws", () => {
    for (let i = 0; i < 2000; i++) {
      const r = drawNumbers(spec({ min: 1, max: 4 }), new SeededSource(`n${i}`));
      assert.equal(r.isMaximum, r.values[0] === 4);
      assert.equal(r.isMinimum, r.values[0] === 1);
    }
  });
});
