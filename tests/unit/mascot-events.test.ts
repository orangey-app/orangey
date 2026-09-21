import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { emitMascotEvent, onMascotEvent, summarize, type MascotEvent } from "../../src/ui/mascot/events.ts";
import { rollRandomizer } from "../../src/ui/roll.ts";
import { emptyRandomizer, makeItem, type Randomizer } from "../../src/model/randomizer.ts";
import { SeededSource } from "../../src/core/rng.ts";

const dice = (expression: string): Randomizer => {
  const r = emptyRandomizer("dice", expression) as Randomizer & { expression: string };
  r.expression = expression;
  return r;
};
const numbers = (): Randomizer => ({ ...emptyRandomizer("number", "N"), min: 1, max: 3, integer: true }) as Randomizer;

/** Roll with seeds until the predicate holds; the fixtures are not hand-tuned. */
function rollUntil(r: Randomizer, pred: (o: ReturnType<typeof rollRandomizer>) => boolean, limit = 20000) {
  for (let i = 0; i < limit; i++) {
    const o = rollRandomizer(r, new SeededSource(`s${i}`));
    if (pred(o)) return o;
  }
  throw new Error("no seed produced the wanted outcome");
}

describe("roll summary", () => {
  test("an extreme is reported only where a roll can really be at its limit", () => {
    const cases: [string, Randomizer, string, "max" | "min" | null][] = [
      ["a d20 showing 20", dice("d20"), "20", "max"],
      ["a d20 showing 1", dice("d20"), "1", "min"],
      ["a d20 showing anything else", dice("d20"), "11", null],
      // The modifier moves the number but not what counts as the top.
      ["2d6+3 at its ceiling", dice("2d6+3"), "15", "max"],
      ["2d6+3 at its floor", dice("2d6+3"), "5", "min"],
      // Only when the three kept dice are all sixes, not when the total happens to be high.
      ["4d6kh3 with three sixes", dice("4d6kh3"), "18", "max"],
      ["4d6kh3 one short of it", dice("4d6kh3"), "17", null],
      ["a whole-number draw at the top of its range", numbers(), "3", "max"],
      ["a whole-number draw at the bottom", numbers(), "1", "min"],
    ];
    for (const [what, r, text, extreme] of cases) {
      assert.equal(summarize(rollUntil(r, (o) => o.text === text)).extreme, extreme, what);
    }
    // A coin and a wheel have no order to be at the end of, so neither ever
    // reports one, however it lands.
    const coin = emptyRandomizer("coin", "Coin") as Randomizer;
    const list = { ...emptyRandomizer("list", "L"), items: [makeItem("a", 1), makeItem("b", 9)] } as Randomizer;
    for (let i = 0; i < 300; i++) {
      assert.equal(summarize(rollRandomizer(coin, new SeededSource(`c${i}`))).extreme, null, "a coin");
      assert.equal(summarize(rollRandomizer(list, new SeededSource(`l${i}`))).extreme, null, "a wheel");
    }
  });

  test("a mood comes from the outcome that landed, and only where an author tagged one", () => {
    const list = {
      ...emptyRandomizer("list", "L"),
      items: [makeItem("crit", 1, { reaction: "cheer" }), makeItem("fumble", 1, { reaction: "wince" }), makeItem("meh", 1)],
    } as Randomizer;
    const coin = { ...emptyRandomizer("coin", "C"), faces: ["Heads", "Tails"], faceReactions: [null, "wince"] } as Randomizer;
    const cases: [string, Randomizer, string, "cheer" | "wince" | null][] = [
      ["a wheel outcome tagged to cheer", list, "crit", "cheer"],
      ["a wheel outcome tagged to wince", list, "fumble", "wince"],
      ["an untagged wheel outcome", list, "meh", null],
      // faceReactions follow the order of `faces`, not the order they land in.
      ["the untagged face of a coin", coin, "Heads", null],
      ["the tagged face of a coin", coin, "Tails", "wince"],
      // Dice and numbers have extremes instead; a mood there would double up.
      ["a maximum die roll", dice("d20"), "20", null],
      ["a whole-number draw at the top", numbers(), "3", null],
    ];
    for (const [what, r, text, mood] of cases) {
      assert.equal(summarize(rollUntil(r, (o) => o.text === text)).mood, mood, what);
    }
    const plain = emptyRandomizer("coin", "P") as Randomizer;
    for (let i = 0; i < 50; i++) assert.equal(summarize(rollRandomizer(plain, new SeededSource(`p${i}`))).mood, null);
  });

  test("the summary carries the panel's own text, and the bus delivers it once", () => {
    const o = rollRandomizer(dice("2d6"), new SeededSource("x"));
    assert.equal(summarize(o).text, o.text, "the mascot reacts to what the table can see");
    assert.equal(summarize(o).kind, "dice");

    const target = new EventTarget();
    const seen: MascotEvent[] = [];
    const off = onMascotEvent(target, (e) => seen.push(e));
    emitMascotEvent(target, { type: "link:fail", id: "abc" });
    off();
    emitMascotEvent(target, { type: "link:fail", id: "def" });
    assert.deepEqual(seen, [{ type: "link:fail", id: "abc" }], "nothing arrives after unsubscribing");
  });
});
