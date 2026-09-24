import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ParseError, diceNotation, parse, tryParse } from "../../src/core/dice/grammar.ts";
import { evaluate, expressionBounds, rollDice } from "../../src/core/dice/evaluate.ts";
import { formatResult, speakResult } from "../../src/core/dice/format.ts";
import { longestOutcome, rollRandomizer } from "../../src/ui/roll.ts";
import { emptyRandomizer, makeItem, type ListRandomizer } from "../../src/model/randomizer.ts";
import { SeededSource, type RandomSource } from "../../src/core/rng.ts";

describe("dice notation", () => {
  test("canonical forms", () => {
    const cases: [string, string][] = [
      ["d20", "d20"],
      ["2d6+3", "2d6 + 3"],
      ["4d6kh3", "4d6kh3"],
      ["2d20kh1", "2d20kh1"],
      ["2d20kl1", "2d20kl1"],
      ["3d8dl1", "3d8dl1"],
      ["4d6dh1", "4d6dh1"],
      ["d%", "d100"],
      ["1d20 + 5 - 2", "d20 + 5 - 2"],
      ["  2D6  +  3 ", "2d6 + 3"],
      ["-d4+10", "-d4 + 10"],
      // Space before keep/drop is how people write it, and DICE.md says so.
      ["4d6 kh3", "4d6kh3"],
      ["2d20  kl1", "2d20kl1"],
      // 0.4 notation.
      ["2d6!", "2d6!"],
      ["2d6r1", "2d6r1"],
      ["2d6r=1", "2d6r1"],
      ["2d6ro<3", "2d6ro<3"],
      ["5d10>=8", "5d10>=8"],
      ["4dF", "4dF"],
      ["4DF", "4dF"],
      ["3d6 ! r1 kh2 >= 5", "3d6!r1kh2>=5"],
      // adv and dis are sugar, and normalise to what they stand for.
      ["adv", "2d20kh1"],
      ["ADV", "2d20kh1"],
      ["dis", "2d20kl1"],
    ];
    for (const [input, expected] of cases) {
      assert.equal(parse(input).normalized, expected, `for ${input}`);
    }
    // A picker's search box also takes notation, so a word or a bare number
    // being searched for must not read as a roll.
    assert.equal(diceNotation("  2D6+3 "), "2d6 + 3");
    assert.equal(diceNotation("adv"), "2d20kh1");
    assert.equal(diceNotation("3"), null);
    assert.equal(diceNotation("10 + 2"), null);
    assert.equal(diceNotation("wolves"), null);
    assert.equal(diceNotation(""), null);
  });

  test("dice written into an outcome are rolled with it", () => {
    const list = {
      ...emptyRandomizer("list", "Wolves"),
      items: [makeItem("{2d4} wolves", 1, { description: "{nonsense} and {1d6} more" })],
    } as ListRandomizer;

    const outcome = rollRandomizer(list, new SeededSource("inline"));
    const n = Number.parseInt(outcome.text, 10);
    assert.ok(Number.isInteger(n) && n >= 2 && n <= 8, `"${outcome.text}" is not 2d4`);
    assert.match(outcome.text, /^\d+ wolves$/);
    assert.match(outcome.detail ?? "", /2d4 \[/, outcome.detail);
    // Braces around something that is not dice are left exactly as typed.
    assert.match(outcome.detail ?? "", /\{nonsense\}/, outcome.detail);
    assert.doesNotMatch(outcome.detail ?? "", /\{1d6\}/, "the description's dice were not rolled");

    // The reserved width uses the largest each expression can reach.
    assert.equal(longestOutcome(list), "8 wolves");
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
      // 0.4 notation.
      ["4dF!", 3, /Fate dice cannot explode/],
      ["d6r<7", 2, /reroll every face/],
      ["2d6kh1!", 6, /the order is/],
      ["2d6>=3r1", 6, /the order is/],
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

  /**
   * A source that hands out the values a test asks for, in order.
   *
   * Seeds are fine for "does this stay the same", but useless for "what
   * happens when a 6 explodes into a 6": you end up hunting for a seed that
   * happens to do it. This states the dice instead.
   */
  function scripted(values: number[]): RandomSource {
    let at = 0;
    return {
      int: () => {
        if (at >= values.length) throw new Error(`the script ran out after ${values.length} draws`);
        return values[at++];
      },
      float: () => 0,
    };
  }

  test("exploding dice and rerolls", () => {
    // 2d6!: a 6 adds a die, and that die can add another.
    const boom = evaluate(parse("2d6!"), scripted([6, 3, 6, 2]));
    assert.deepEqual(boom.terms[0].dice?.map((d) => [d.value, d.kept, d.exploded === true]),
      [[6, true, false], [3, true, false], [6, true, true], [2, true, true]]);
    assert.equal(boom.total, 17);
    assert.equal(boom.openEnded, true);
    assert.match(formatResult(boom), /6!/);

    // 2d6r1: a 1 is thrown away and shown, like a dropped die.
    const rr = evaluate(parse("2d6r1"), scripted([1, 4, 5]));
    assert.deepEqual(rr.terms[0].dice?.map((d) => [d.value, d.kept, d.rerolled === true]),
      [[1, false, true], [5, true, false], [4, true, false]]);
    assert.equal(rr.total, 9);
    assert.equal(rr.openEnded, false);
    // An unlimited reroll takes those faces out of the range entirely.
    assert.deepEqual(expressionBounds("2d6r1"), { min: 4, max: 12, openEnded: false });

    // ro rerolls once and takes the replacement even when it matches again.
    const once = evaluate(parse("2d6ro1"), scripted([1, 3, 1]));
    assert.deepEqual(once.terms[0].dice?.map((d) => [d.value, d.kept, d.rerolled === true]),
      [[1, false, true], [1, true, false], [3, true, false]]);
    assert.equal(once.total, 4);
  });

  test("success pools count dice rather than adding them up", () => {
    const pool = evaluate(parse("5d10>=8"), scripted([9, 3, 8, 10, 1]));
    assert.equal(pool.total, 3);
    assert.match(formatResult(pool), /= 3 successes$/);
    assert.match(speakResult(pool), /3 successes/);
    assert.deepEqual(expressionBounds("5d10>=8"), { min: 0, max: 5, openEnded: false });

    // One success reads as one, not "1 successes".
    const single = evaluate(parse("5d10>=8"), scripted([9, 3, 2, 4, 1]));
    assert.match(formatResult(single), /= 1 success$/);

    // An exploded die counts towards the pool like any other.
    const boom = evaluate(parse("3d10!>=8"), scripted([10, 2, 3, 9]));
    assert.equal(boom.total, 2, formatResult(boom));
  });

  test("Fate dice run minus one to plus one", () => {
    const fate = evaluate(parse("4dF"), scripted([3, 1, 2, 3]));
    assert.deepEqual(fate.terms[0].dice?.map((d) => d.value), [1, -1, 0, 1]);
    assert.equal(fate.total, 1);
    assert.deepEqual(expressionBounds("4dF"), { min: -4, max: 4, openEnded: false });
    assert.match(formatResult(fate), /\[\+1, -1, 0, \+1\]/);

    // All four at the top is a maximum; one at the top on its own is not a
    // minimum, which the old "value === 1" rule would have called it.
    const best = evaluate(parse("4dF"), scripted([3, 3, 3, 3]));
    assert.equal(best.isMaximum, true);
    assert.equal(best.isMinimum, false);
    const one = evaluate(parse("dF"), scripted([3]));
    assert.equal(one.isMinimum, false, "+1 was read as a minimum");
    assert.equal(one.isMaximum, true);
    const worst = evaluate(parse("4dF"), scripted([1, 1, 1, 1]));
    assert.equal(worst.isMinimum, true);
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
    // The spoken form names the dice that were left out, so a screen reader
    // hears why the total is not the sum of what it just read.
    assert.equal(speakResult(rollDice("4d6kh3", new SeededSource("test"))), "4d6kh3: 5, 2, 5, dropping 1. Total 12.");
    assert.equal(rollDice("d6", new SeededSource("abc")).seed, "abc", "the seed travels with the result");
  });

  test("keep and drop take the right dice, and the bounds account for them", () => {
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
    // A bound counts only the dice that survive the keep or drop.
    for (const [expr, min, max] of [["4d6kh3", 3, 18], ["3d8dl1", 2, 16]] as const) {
      const r = rollDice(expr, rng);
      assert.equal(r.min, min, `${expr} lower bound`);
      assert.equal(r.max, max, `${expr} upper bound`);
    }
    for (const expr of ["d20", "2d6+3", "4d6kh3", "3d8dl1", "d100", "10d10", "d20-5", "-2d6+20"]) {
      for (let i = 0; i < 300; i++) {
        const r = rollDice(expr, rng);
        assert.ok(r.total >= r.min && r.total <= r.max, `${expr}: ${r.total} outside ${r.min}..${r.max}`);
      }
    }
  });

  test("an extreme means every kept die showed its face, not that the total is unusual", () => {
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
    // The rule is per die, not per total: a 1 and a 20 on 2d20 totals 21,
    // halfway up the range, and is neither a maximum nor a minimum. Cheering
    // it would mean cheering an ordinary roll.
    let sawSplit = false;
    for (let i = 0; i < 4000; i++) {
      const r = rollDice("2d20", rng);
      const values = r.terms[0].dice!.map((d) => d.value);
      assert.equal(r.isMaximum, values.every((v) => v === 20), `2d20 showing ${values}`);
      assert.equal(r.isMinimum, values.every((v) => v === 1), `2d20 showing ${values}`);
      if (values.includes(1) && values.includes(20)) sawSplit = true;
    }
    assert.ok(sawSplit, "expected a 1 beside a 20 in 4000 rolls of 2d20");
  });
});
