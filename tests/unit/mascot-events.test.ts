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

/** Roll with seeds until the predicate holds; the fixtures are not hand-tuned. */
function rollUntil(r: Randomizer, pred: (o: ReturnType<typeof rollRandomizer>) => boolean, limit = 20000) {
  for (let i = 0; i < limit; i++) {
    const o = rollRandomizer(r, new SeededSource(`s${i}`));
    if (pred(o)) return o;
  }
  throw new Error("no seed produced the wanted outcome");
}

describe("roll summary", () => {
  test("a d20 showing 20 is a max, 1 a min, anything else neither", () => {
    const r = dice("d20");
    assert.equal(summarize(rollUntil(r, (o) => o.text === "20")).extreme, "max");
    assert.equal(summarize(rollUntil(r, (o) => o.text === "1")).extreme, "min");
    assert.equal(summarize(rollUntil(r, (o) => o.text === "11")).extreme, null);
  });

  test("4d6kh3 is a max only when the three kept dice are all sixes", () => {
    const r = dice("4d6kh3");
    const top = rollUntil(r, (o) => o.text === "18");
    assert.equal(summarize(top).extreme, "max");
    const near = rollUntil(r, (o) => o.text === "17");
    assert.equal(summarize(near).extreme, null);
  });

  test("a modifier does not change what counts as the top: 2d6+3 at 15", () => {
    const r = dice("2d6+3");
    assert.equal(summarize(rollUntil(r, (o) => o.text === "15")).extreme, "max");
    assert.equal(summarize(rollUntil(r, (o) => o.text === "5")).extreme, "min");
  });

  test("a whole-number draw reports its bounds; a coin and a wheel never do", () => {
    const n = { ...emptyRandomizer("number", "N"), min: 1, max: 3, integer: true } as Randomizer;
    assert.equal(summarize(rollUntil(n, (o) => o.text === "3")).extreme, "max");
    assert.equal(summarize(rollUntil(n, (o) => o.text === "1")).extreme, "min");
    const coin = emptyRandomizer("coin", "Coin") as Randomizer;
    const list = { ...emptyRandomizer("list", "L"), items: [makeItem("a", 1), makeItem("b", 9)] } as Randomizer;
    for (let i = 0; i < 300; i++) {
      assert.equal(summarize(rollRandomizer(coin, new SeededSource(`c${i}`))).extreme, null);
      assert.equal(summarize(rollRandomizer(list, new SeededSource(`l${i}`))).extreme, null);
    }
  });

  test("a tagged wheel item lands with its mood; untagged ones with none", () => {
    const list = {
      ...emptyRandomizer("list", "L"),
      items: [makeItem("crit", 1, { reaction: "cheer" }), makeItem("fumble", 1, { reaction: "wince" }), makeItem("meh", 1)],
    } as Randomizer;
    assert.equal(summarize(rollUntil(list, (o) => o.text === "crit")).mood, "cheer");
    assert.equal(summarize(rollUntil(list, (o) => o.text === "fumble")).mood, "wince");
    assert.equal(summarize(rollUntil(list, (o) => o.text === "meh")).mood, null);
    // a wheel still never reports an extreme, tagged or not
    for (let i = 0; i < 100; i++) assert.equal(summarize(rollRandomizer(list, new SeededSource(`t${i}`))).extreme, null);
  });

  test("a coin's faceReactions follow the face that lands, in the order of `faces`", () => {
    const coin = { ...emptyRandomizer("coin", "C"), faces: ["Heads", "Tails"], faceReactions: [null, "wince"] } as Randomizer;
    assert.equal(summarize(rollUntil(coin, (o) => o.text === "Heads")).mood, null);
    assert.equal(summarize(rollUntil(coin, (o) => o.text === "Tails")).mood, "wince");
    const plain = emptyRandomizer("coin", "P") as Randomizer;
    for (let i = 0; i < 50; i++) assert.equal(summarize(rollRandomizer(plain, new SeededSource(`p${i}`))).mood, null);
  });

  test("dice and numbers never carry a mood: the extremes are theirs", () => {
    assert.equal(summarize(rollUntil(dice("d20"), (o) => o.text === "20")).mood, null);
    const n = { ...emptyRandomizer("number", "N"), min: 1, max: 3, integer: true } as Randomizer;
    assert.equal(summarize(rollUntil(n, (o) => o.text === "3")).mood, null);
  });

  test("the summary text is the result panel's text", () => {
    const o = rollRandomizer(dice("2d6"), new SeededSource("x"));
    assert.equal(summarize(o).text, o.text);
    assert.equal(summarize(o).kind, "dice");
  });

  test("the bus delivers the event to a listener and unsubscribes cleanly", () => {
    const target = new EventTarget();
    const seen: MascotEvent[] = [];
    const off = onMascotEvent(target, (e) => seen.push(e));
    emitMascotEvent(target, { type: "link:fail", id: "abc" });
    off();
    emitMascotEvent(target, { type: "link:fail", id: "def" });
    assert.deepEqual(seen, [{ type: "link:fail", id: "abc" }]);
  });
});
