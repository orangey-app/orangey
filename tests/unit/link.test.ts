import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  LINK_HARD_LIMIT,
  LINK_SOFT_LIMIT,
  decodeRandomizer,
  encodeRandomizer,
  packRandomizer,
} from "../../src/model/link.ts";
import { parseRoute, wheelLink } from "../../src/ui/router.ts";
import { emptyRandomizer, makeItem, type ListRandomizer, type Randomizer } from "../../src/model/randomizer.ts";
import { rollRandomizer } from "../../src/ui/roll.ts";
import { SeededSource } from "../../src/core/rng.ts";
import { ValidationError } from "../../src/model/validate.ts";

const wheel = (): ListRandomizer => ({
  ...(emptyRandomizer("list", "Forest Encounters") as ListRandomizer),
  description: "Daytime, levels 1–4",
  view: "wheel",
  items: [
    makeItem("Goblin patrol", 50),
    makeItem("Merchant", 20, { description: "Friendly, overpriced" }),
    makeItem("Wolf pack", 20, { reaction: "wince", disabled: true }),
    makeItem("Dragon", 1, { color: "#a33a30", reaction: "cheer" }),
  ],
  feel: { wheel: { durationMs: 5200, turns: 9 } },
});

describe("a randomizer inside a link", () => {
  test("every kind of randomizer arrives on the other side unchanged", async () => {
    const before = wheel();
    const after = (await decodeRandomizer(await encodeRandomizer(before))) as ListRandomizer;
    assert.equal(after.name, before.name);
    assert.equal(after.description, before.description);
    assert.equal(after.id, before.id, "the identity travels, so saving it can keep it");
    assert.equal(after.view, "wheel");
    assert.deepEqual(after.feel, before.feel, "the author's spin travels with the wheel");
    const offering = (await decodeRandomizer(await encodeRandomizer({ ...before, offer: 3 }))) as ListRandomizer;
    assert.equal(offering.offer, 3, "a wheel that offers a choice still offers it at the other end");
    const painted = (await decodeRandomizer(await encodeRandomizer({ ...before, palette: ["#111111", "#eeeeee", "#3d7c8a"] }))) as ListRandomizer;
    assert.deepEqual(painted.palette, ["#111111", "#eeeeee", "#3d7c8a"], "a wheel's own colours are part of its look, so the link carries them");
    assert.equal(after.palette, undefined, "a wheel without its own colours does not gain any");
    assert.deepEqual(
      after.items.map((i) => [i.label, i.weight, i.color ?? null, i.reaction ?? null, i.disabled ?? false]),
      before.items.map((i) => [i.label, i.weight, i.color ?? null, i.reaction ?? null, i.disabled ?? false]),
    );

    const cases: [string, Randomizer][] = [
      ["a dice roller", { ...emptyRandomizer("dice", "Attack"), expression: "4d6kh3+2" } as Randomizer],
      ["a coin with a tagged face", { ...emptyRandomizer("coin", "Omen"), faces: ["Good", "Ill"], faceReactions: [null, "wince"] } as Randomizer],
      ["a number draw", { ...emptyRandomizer("number", "Roll under"), min: -5, max: 1000, integer: true, count: 3, unique: true } as Randomizer],
    ];
    for (const [what, original] of cases) {
      const back = await decodeRandomizer(await encodeRandomizer(original));
      assert.deepEqual({ ...back, created: "", modified: "" }, { ...original, created: "", modified: "" }, what);
    }

    // The point of all of the above: the person who opens the link rolls the
    // same randomizer, not one that merely looks like it.
    for (let i = 0; i < 200; i++) {
      const seed = `link${i}`;
      assert.equal(rollRandomizer(after, new SeededSource(seed)).text, rollRandomizer(before, new SeededSource(seed)).text);
    }
  });

  test("outcome ids are library bookkeeping: dropped on the way out, fresh and unique on the way in", async () => {
    const before = wheel();
    const packed = packRandomizer(before) as { items: { id?: string }[]; created?: string; modified?: string };
    assert.ok(packed.items.every((i) => i.id === undefined), "ids should not travel");
    assert.equal(packed.created, undefined);
    assert.equal(packed.modified, undefined);
    const after = (await decodeRandomizer(await encodeRandomizer(before))) as ListRandomizer;
    const ids = after.items.map((i) => i.id);
    assert.equal(new Set(ids).size, 4, "every outcome needs its own id");
    assert.ok(ids.every((id) => typeof id === "string" && id.length > 0));
    assert.notDeepEqual(ids, before.items.map((i) => i.id));
    assert.ok(after.created && after.modified, "it becomes a randomizer of its own on arrival");
  });

  test("a twenty-row encounter table fits comfortably in a link", async () => {
    const long: Randomizer = {
      ...(emptyRandomizer("list", "Twelve encounters") as ListRandomizer),
      items: Array.from({ length: 20 }, (_, i) => makeItem(`Encounter number ${i + 1} on the forest road`, i + 1)),
    } as Randomizer;
    const link = wheelLink("https://orangey-app.github.io/orangey/", await encodeRandomizer(long), { roll: true, present: true });
    assert.ok(link.length < LINK_SOFT_LIMIT, `${link.length} characters is longer than the soft limit`);
    assert.ok(link.length < LINK_HARD_LIMIT);
  });

  test("nothing in the payload has to be escaped, so a deck cannot mangle it", async () => {
    for (const name of ["Ünicode ✦ names", "commas, and & ampersands", "a/slash?and#hash"]) {
      const r = { ...(emptyRandomizer("list", name) as ListRandomizer), items: [makeItem("x", 1)] } as Randomizer;
      const payload = await encodeRandomizer(r);
      assert.match(payload, /^[01][A-Za-z0-9_-]+$/, `payload needs escaping: ${payload.slice(0, 20)}`);
      assert.equal((await decodeRandomizer(payload)).name, name);
    }
    // …and the link the dialog builds is the link the router reads back.
    const payload = await encodeRandomizer(wheel());
    const link = wheelLink("https://orangey-app.github.io/orangey/#/r/x", payload, { roll: true, present: false });
    const route = parseRoute(link.slice(link.indexOf("#")));
    assert.equal(route.name, "linked");
    assert.equal(route.name === "linked" ? route.payload : "", payload);
    assert.deepEqual(route.params, { roll: true, present: false });
    assert.equal((await decodeRandomizer(route.name === "linked" ? route.payload : "")).name, "Forest Encounters");
  });

  test("a link that did not survive says what is wrong with it", async () => {
    const refuse = async (what: string, payload: string, re: RegExp) => {
      await assert.rejects(() => decodeRandomizer(payload), (e: unknown) => {
        assert.ok(e instanceof ValidationError, `${what}: not a ValidationError: ${e}`);
        assert.match(e.message, re, what);
        return true;
      });
    };
    const good = await encodeRandomizer(wheel());
    const empty = { ...(emptyRandomizer("list", "Empty") as ListRandomizer), items: [] } as Randomizer;
    await refuse("nothing after w=", "", /nothing after w=/);
    await refuse("a marker from a newer Orangey", "9abcdef", /newer Orangey/);
    await refuse("a link a chat app cut in half", good.slice(0, Math.floor(good.length / 2)), /damaged/);
    await refuse("json that is not a randomizer", `0${Buffer.from('{"nope":1}').toString("base64url")}`, /link\.type|link\.id|link\.name/);
    await refuse("not json at all", `0${Buffer.from("not json at all").toString("base64url")}`, /damaged/);
    // An empty wheel would open as a dead end rather than a randomizer.
    await refuse("a wheel with no outcomes", await encodeRandomizer(empty), /items/);
  });
});
