import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ParseError, parse, tryParse } from "../../src/core/dice/grammar.ts";
import { rollDice } from "../../src/core/dice/evaluate.ts";
import { formatResult, speakResult } from "../../src/core/dice/format.ts";
import { SeededSource } from "../../src/core/rng.ts";

describe("dice notation", () => {
  test("canonical forms", () => {
    const cases: [string, string][] = [
      ["d20", "d20"],
      ["2d6+3", "2d6 + 3"],
      ["4d6kh3", "4d6kh3"],
      ["2d20kh1", "2d20kh1"],
      ["2d20kl1", "2d20kl1"],
      ["d%", "d100"],
      ["1d20 + 5 - 2", "d20 + 5 - 2"],
      ["3d8dl1", "3d8dl1"],
      ["  2D6  +  3 ", "2d6 + 3"],
      ["-d4+10", "-d4 + 10"],
    ];
    for (const [input, expected] of cases) {
      assert.equal(parse(input).normalized, expected, `for ${input}`);
    }
  });

  test("parse errors point at the offending character", () => {
    const cases: [string, number, RegExp][] = [
      ["", 0, /type an expression/],
      ["2d", 2, /number of sides/],
      ["d1", 0, /2 to 1000 sides/],
      ["x", 0, /number or a die/],
      ["2d6 + ", 6, /number or a die/],
      ["101d6", 0, /1 to 100 dice/],
      ["4d6kh5", 3, /cannot keep 5 of 4/],
      ["4d6dl4", 3, /cannot drop 4 of 4/],
      ["2d6 3", 4, /expected \+ or -/],
    ];
    for (const [input, position, message] of cases) {
      const r = tryParse(input);
      assert.equal(r.ok, false, `${input} should not parse`);
      if (!r.ok) {
        assert.match(r.error.message, message, `for ${input}`);
        assert.equal(r.error.position, position, `position for ${input}`);
        assert.ok(r.error instanceof ParseError);
        assert.ok(r.error.caret().includes("^"));
      }
    }
  });

  test("recorded fixtures for a shared seed", () => {
    const rng = new SeededSource("test");
    const lines = ["4d6kh3", "2d20kl1", "2d6+3", "d20+5-2", "3d8dl1"].map((e) => formatResult(rollDice(e, rng)));
    assert.deepEqual(lines, [
      "4d6kh3 [5, (1), 2, 5] = 12",
      "2d20kl1 [(11), 3] = 3",
      "2d6 [6, 1] + 3 = 10",
      "d20 [8] + 5 - 2 = 11",
      "3d8dl1 [7, 4, (3)] = 11",
    ]);
  });

  test("keep and drop select the right dice", () => {
    const rng = new SeededSource("keepdrop");
    for (let i = 0; i < 500; i++) {
      const r = rollDice("4d6kh3", rng);
      const dice = r.terms[0].dice!;
      const kept = dice.filter((d) => d.kept).map((d) => d.value);
      const dropped = dice.filter((d) => !d.kept).map((d) => d.value);
      assert.equal(kept.length, 3);
      assert.equal(dropped.length, 1);
      assert.ok(Math.min(...kept) >= Math.max(...dropped), `kept ${kept} vs dropped ${dropped}`);
      assert.equal(r.total, kept.reduce((a, b) => a + b, 0));
    }
  });

  test("totals always lie within the theoretical bounds", () => {
    const rng = new SeededSource("bounds");
    for (const expr of ["d20", "2d6+3", "4d6kh3", "3d8dl1", "d100", "10d10", "d20-5", "-2d6+20"]) {
      for (let i = 0; i < 300; i++) {
        const r = rollDice(expr, rng);
        assert.ok(r.total >= r.min && r.total <= r.max, `${expr}: ${r.total} outside ${r.min}..${r.max}`);
      }
    }
  });

  test("bounds account for keep and drop", () => {
    const rng = new SeededSource("b2");
    const r = rollDice("4d6kh3", rng);
    assert.equal(r.min, 3);
    assert.equal(r.max, 18);
    const d = rollDice("3d8dl1", rng);
    assert.equal(d.min, 2);
    assert.equal(d.max, 16);
  });

  test("maximum and minimum flags only fire on the extremes", () => {
    const rng = new SeededSource("crit");
    let sawMax = false;
    let sawMin = false;
    for (let i = 0; i < 2000; i++) {
      const r = rollDice("d20", rng);
      if (r.total === 20) {
        assert.ok(r.isMaximum);
        sawMax = true;
      }
      if (r.total === 1) {
        assert.ok(r.isMinimum);
        sawMin = true;
      }
      if (r.total > 1 && r.total < 20) {
        assert.ok(!r.isMaximum && !r.isMinimum);
      }
    }
    assert.ok(sawMax && sawMin, "expected to see both extremes in 2000 d20 rolls");
  });

  test("spoken form names dropped dice", () => {
    const r = rollDice("4d6kh3", new SeededSource("test"));
    assert.equal(speakResult(r), "4d6kh3: 5, 2, 5, dropping 1. Total 12.");
  });

  test("the seed travels with the result", () => {
    assert.equal(rollDice("d6", new SeededSource("abc")).seed, "abc");
  });
});
