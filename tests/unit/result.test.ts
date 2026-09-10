import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { longestOutcome } from "../../src/ui/roll.ts";
import { RESULT_SMALL_AT, RESULT_TWO_LINES_AT, resultIsSmall, resultLines } from "../../src/ui/components/result.ts";
import { emptyRandomizer, makeItem, type Randomizer } from "../../src/model/randomizer.ts";
import { rollRandomizer } from "../../src/ui/roll.ts";
import { SeededSource } from "../../src/core/rng.ts";

const list = (labels: string[]): Randomizer =>
  ({ ...emptyRandomizer("list", "L"), items: labels.map((l) => makeItem(l, 1)) }) as Randomizer;

describe("the longest outcome a randomizer can produce", () => {
  test("a list reports its longest label, disabled ones included", () => {
    const r = list(["Wolf", "A wandering merchant with a cart", "7"]);
    assert.equal(longestOutcome(r), "A wandering merchant with a cart");
    // an outcome that is off today can be switched on tomorrow, and the panel
    // must not resize when it is
    const withDisabled = { ...r, items: r.items.map((i, n) => (n === 1 ? { ...i, disabled: true } : i)) } as Randomizer;
    assert.equal(longestOutcome(withDisabled), "A wandering merchant with a cart");
  });

  test("a coin reports its longer face", () => {
    const coin = { ...emptyRandomizer("coin", "C"), faces: ["Yes", "Absolutely not"] } as Randomizer;
    assert.equal(longestOutcome(coin), "Absolutely not");
  });

  test("a number draw reports a full row of its widest value", () => {
    const one = { ...emptyRandomizer("number", "N"), min: 1, max: 1000, integer: true, count: 1 } as Randomizer;
    assert.equal(longestOutcome(one), "1000");
    const three = { ...one, count: 3 } as Randomizer;
    assert.equal(longestOutcome(three), "1000, 1000, 1000");
    const negative = { ...one, min: -1000, max: 5 } as Randomizer;
    assert.equal(longestOutcome(negative), "-1000");
  });

  test("dice report the wider of their two bounds, without touching the app's sequence", () => {
    const d = (expression: string) => ({ ...emptyRandomizer("dice", expression), expression }) as Randomizer;
    assert.equal(longestOutcome(d("d20")), "20");
    assert.equal(longestOutcome(d("4d6kh3+2")), "20");
    assert.equal(longestOutcome(d("10d100")), "1000");
    // a bound can be negative, and that is the wider string
    assert.equal(longestOutcome(d("d4-10")), "-9");
  });

  test("an expression that cannot be parsed falls back to itself rather than throwing", () => {
    const broken = { ...emptyRandomizer("dice", "nonsense"), expression: "what" } as Randomizer;
    assert.equal(longestOutcome(broken), "what");
  });

  test("it really is an upper bound: no roll is longer than what it promises", () => {
    const cases: Randomizer[] = [
      list(["Wolf", "A wandering merchant with a cart", "7"]),
      { ...emptyRandomizer("coin", "C"), faces: ["Yes", "Absolutely not"] } as Randomizer,
      { ...emptyRandomizer("number", "N"), min: -50, max: 1000, integer: true, count: 4 } as Randomizer,
      { ...emptyRandomizer("dice", "3d20"), expression: "3d20" } as Randomizer,
      { ...emptyRandomizer("dice", "2d6-8"), expression: "2d6-8" } as Randomizer,
    ];
    for (const r of cases) {
      const bound = longestOutcome(r).length;
      for (let i = 0; i < 400; i++) {
        const text = rollRandomizer(r, new SeededSource(`u${i}`)).text;
        assert.ok(text.length <= bound, `${r.type}: "${text}" (${text.length}) exceeds the reserved ${bound}`);
      }
    }
  });
});

describe("what the panel reserves", () => {
  test("short outcomes keep one line and the large type", () => {
    assert.equal(resultLines("7"), 1);
    assert.equal(resultLines("Goblin"), 1);
    assert.equal(resultIsSmall("Goblin"), false);
  });

  test("a longer outcome keeps two lines, and a longer one again drops to the smaller type", () => {
    const twoLines = "x".repeat(RESULT_TWO_LINES_AT + 1);
    assert.equal(resultLines(twoLines), 2);
    assert.equal(resultIsSmall(twoLines), false);
    const small = "x".repeat(RESULT_SMALL_AT + 1);
    assert.equal(resultLines(small), 2);
    assert.equal(resultIsSmall(small), true);
  });

  test("the reservation never exceeds two lines, however long the outcome", () => {
    assert.equal(resultLines("x".repeat(4000)), 2);
  });
});
