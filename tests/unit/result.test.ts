import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { longestOutcome, rollRandomizer } from "../../src/ui/roll.ts";
import { RESULT_SMALL_AT, RESULT_TWO_LINES_AT, resultIsSmall, resultLines } from "../../src/ui/components/result.ts";
import { emptyRandomizer, makeItem, type Randomizer } from "../../src/model/randomizer.ts";
import { SeededSource } from "../../src/core/rng.ts";

const list = (labels: string[]): Randomizer =>
  ({ ...emptyRandomizer("list", "L"), items: labels.map((l) => makeItem(l, 1)) }) as Randomizer;
const coin = (faces: string[]): Randomizer => ({ ...emptyRandomizer("coin", "C"), faces }) as Randomizer;
const numbers = (over: Partial<Randomizer>): Randomizer =>
  ({ ...emptyRandomizer("number", "N"), min: 1, max: 1000, integer: true, count: 1, ...over }) as Randomizer;
const dice = (expression: string): Randomizer => ({ ...emptyRandomizer("dice", expression), expression }) as Randomizer;

describe("the longest outcome a randomizer can produce", () => {
  test("every kind of randomizer reports the widest string it could show", () => {
    const cases: [string, Randomizer, string][] = [
      ["a list reports its longest label", list(["Wolf", "A wandering merchant with a cart", "7"]), "A wandering merchant with a cart"],
      ["a coin reports its longer face", coin(["Yes", "Absolutely not"]), "Absolutely not"],
      ["a single number draw", numbers({}), "1000"],
      ["a row of number draws, separators and all", numbers({ count: 3 }), "1000, 1000, 1000"],
      // a minus sign is a character too, and a negative bound can be the wider string
      ["a number range that goes negative", numbers({ min: -1000, max: 5 }), "-1000"],
      ["a die reports its upper bound", dice("d20"), "20"],
      ["keep-highest and a modifier are accounted for", dice("4d6kh3+2"), "20"],
      ["many dice of many sides", dice("10d100"), "1000"],
      ["a die whose lower bound is the wider string", dice("d4-10"), "-9"],
      // the panel must still get a width rather than an exception
      ["an expression that cannot be parsed falls back to itself", dice("what"), "what"],
    ];
    for (const [what, r, expected] of cases) assert.equal(longestOutcome(r), expected, what);
  });

  test("an outcome that is switched off still counts, so the panel does not resize when it comes back", () => {
    const r = list(["Wolf", "A wandering merchant with a cart", "7"]);
    const withDisabled = { ...r, items: r.items.map((i, n) => (n === 1 ? { ...i, disabled: true } : i)) } as Randomizer;
    assert.equal(longestOutcome(withDisabled), "A wandering merchant with a cart");
  });

  test("it really is an upper bound: no roll is longer than what it promises", () => {
    const cases: Randomizer[] = [
      list(["Wolf", "A wandering merchant with a cart", "7"]),
      coin(["Yes", "Absolutely not"]),
      numbers({ min: -50, max: 1000, count: 4 }),
      dice("3d20"),
      dice("2d6-8"),
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
  test("the panel grows to two lines and then shrinks its type, and never more than that", () => {
    const cases: [string, string, number, boolean][] = [
      ["a short number", "7", 1, false],
      ["a single word", "Goblin", 1, false],
      ["just past the one-line limit", "x".repeat(RESULT_TWO_LINES_AT + 1), 2, false],
      ["just past the large-type limit", "x".repeat(RESULT_SMALL_AT + 1), 2, true],
      // whatever arrives, the panel's reservation stops at two lines: a
      // taller one would push the roll button off a phone screen
      ["an absurdly long outcome", "x".repeat(4000), 2, true],
    ];
    for (const [what, text, lines, small] of cases) {
      assert.equal(resultLines(text), lines, what);
      assert.equal(resultIsSmall(text), small, what);
    }
  });
});
