import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { FORMAT_VERSION, fileNameFor, parseFile, serialize, slugify, wrap } from "../../src/model/file.ts";
import { emptyRandomizer, makeItem, type ListRandomizer } from "../../src/model/randomizer.ts";
import { ValidationError } from "../../src/model/validate.ts";

/** A randomizer using every optional field a saved file can carry. */
function sample(): ListRandomizer {
  return {
    id: "5f1c0000-0000-4000-8000-000000000001",
    type: "list",
    name: "Forest Encounters",
    description: "Daytime, levels 1–4",
    view: "wheel",
    slices: "both",
    feel: { wheel: { turns: 3, settleDegrees: 20 } },
    created: "2026-09-08T18:00:00.000Z",
    modified: "2026-09-08T18:20:00.000Z",
    items: [
      { id: "a1", label: "Goblin patrol", weight: 50 },
      { id: "a2", label: "Merchant", weight: 20, description: "Friendly, overpriced" },
      { id: "a3", label: "Wolf pack", weight: 20, disabled: true, reaction: "wince" },
      { id: "a4", label: "Dragon", weight: 1, color: "#a33a30", reaction: "cheer" },
    ],
  } as ListRandomizer;
}

/** A saved file taken apart, so a test can break one field of it. */
type Doc = { version: number; randomizer: { items: Record<string, unknown>[]; feel?: unknown; slices?: unknown }; [key: string]: unknown };

const doctored = (change: (doc: Doc) => void): string => {
  const doc = JSON.parse(serialize(wrap(sample()))) as Doc;
  change(doc);
  return JSON.stringify(doc);
};

describe("the file format", () => {
  test("a randomizer round-trips through save and load unchanged", async () => {
    const text = serialize(wrap(sample()));
    assert.equal(serialize(parseFile(text).file), text, "the sample did not come back byte for byte");
    const parsed = parseFile(text).file.randomizer as ListRandomizer;
    // The fields most easily lost on the way: a disabled outcome keeps the
    // weight it will have again when it is switched back on, and the tags,
    // colours and feel settings all survive.
    const wolf = parsed.items.find((i) => i.label === "Wolf pack")!;
    assert.equal(wolf.disabled, true);
    assert.equal(wolf.weight, 20);
    assert.equal(wolf.reaction, "wince");
    assert.equal(parsed.items[3].color, "#a33a30");
    assert.equal(parsed.items[0].reaction, undefined);
    assert.equal(parsed.slices, "both");
    assert.deepEqual((parsed as { feel?: unknown }).feel, { wheel: { turns: 3, settleDegrees: 20 } });
    assert.equal(parsed.palette, undefined, "a wheel with the theme's colours carries none of its own");
    const painted = serialize(wrap({ ...sample(), palette: ["#111111", "#eeeeee", "#3d7c8a", "#6b8e4e"] } as ListRandomizer));
    assert.equal(serialize(parseFile(painted).file), painted, "a wheel's own colours did not come back byte for byte");
    assert.deepEqual((parseFile(painted).file.randomizer as ListRandomizer).palette, ["#111111", "#eeeeee", "#3d7c8a", "#6b8e4e"]);

    for (const type of ["list", "dice", "coin", "number"] as const) {
      const empty = serialize(wrap(emptyRandomizer(type, `A ${type}`)));
      assert.equal(serialize(parseFile(empty).file), empty, `for ${type}`);
    }
    const coin = { ...emptyRandomizer("coin", "Fate"), faces: ["Yes", "No"] as [string, string], faceReactions: [null, "wince"] as [null, "wince"] };
    assert.deepEqual((parseFile(serialize(wrap(coin))).file.randomizer as typeof coin).faceReactions, [null, "wince"]);
  });

  test("is two-space indented, LF terminated, with keys in a stable order", () => {
    // Files sit in the user's own folders, often under version control, so a
    // save that reorders keys would show up as a diff nobody asked for.
    const text = serialize(wrap(sample()));
    assert.ok(text.endsWith("}\n"));
    assert.ok(!text.includes("\r"));
    assert.ok(text.includes('\n  "version": 1,'));
    const keys = [...text.matchAll(/^ {4}"(\w+)":/gm)].map((m) => m[1]);
    assert.deepEqual(keys.slice(0, 5), ["id", "type", "name", "description", "view"]);
    assert.ok(keys.indexOf("feel") < keys.indexOf("created"), "feel is written before the timestamps");
    const items = text.slice(text.indexOf('"items"'));
    const itemKeys = [...items.matchAll(/^ {8}"(\w+)":/gm)].map((m) => m[1]);
    assert.deepEqual(itemKeys.slice(0, 3), ["id", "label", "weight"]);
    const dragon = text.slice(text.indexOf('"Dragon"'));
    assert.ok(dragon.indexOf('"color"') < dragon.indexOf('"reaction": "cheer"'), "reaction follows colour");
  });

  test("a malformed file is refused, and the message names what is wrong with it", () => {
    const cases: [string, string, RegExp][] = [
      ["not JSON at all", "{nope", /not valid JSON/],
      ["a negative weight", doctored((d) => (d.randomizer.items[3].weight = -2)), /randomizer\.items\[3\]\.weight/],
      ["an outcome with no label", doctored((d) => (d.randomizer.items[1].label = "")), /randomizer\.items\[1\]\.label/],
      ["a tag that is neither cheer nor wince", doctored((d) => (d.randomizer.items[0].reaction = "dance")), /items\[0\]\.reaction/],
      ["a list with nothing in it", doctored((d) => (d.randomizer.items = [])), /items/],
      ["slices that show something unheard of", doctored((d) => (d.randomizer.slices = "sideways")), /randomizer\.slices/],
      ["an offer of one, which is no choice", doctored((d) => (d.randomizer.offer = 1)), /randomizer\.offer/],
      ["a palette of two colours", doctored((d) => (d.randomizer.palette = ["#111111", "#222222"])), /randomizer\.palette/],
      ["a palette colour that is not one", doctored((d) => (d.randomizer.palette = ["#111111", "#222222", "teal"])), /randomizer\.palette\[2\]/],
      ["feel that is not an object", doctored((d) => (d.randomizer.feel = "fast")), /feel/],
      ["one face reaction for a two-faced coin", serialize(wrap({ ...emptyRandomizer("coin", "Fate"), faceReactions: ["cheer"] } as never)), /faceReactions/],
    ];
    for (const [what, text, message] of cases) {
      assert.throws(() => parseFile(text), (e: unknown) => {
        assert.ok(e instanceof ValidationError, `${what}: threw ${e}`);
        assert.match(e.message, message, `for ${what}`);
        return true;
      }, `${what} should have been refused`);
    }
  });

  test("a file from another version of Orangey still opens, and keeps what it knows", () => {
    // A bare randomizer object is what people paste out of older files and
    // out of other tools; unknown keys belong to a version we have not been
    // written for yet, and throwing them away would quietly damage the file.
    assert.equal(parseFile(JSON.stringify(sample())).file.randomizer.name, "Forest Encounters");

    const withExtras = parseFile(doctored((d) => (d.futureThing = { a: 1 })));
    assert.deepEqual(withExtras.file.unknown, { futureThing: { a: 1 } });
    assert.ok(serialize(withExtras.file).includes("futureThing"));

    const newer = parseFile(doctored((d) => (d.version = FORMAT_VERSION + 1)));
    assert.equal(newer.readOnly, true, "a newer file must not be saved back over");
    assert.match(newer.warnings[0], /newer Orangey/);
  });

  test("file names are slugged and de-duplicated", () => {
    assert.equal(slugify("Forest Encounters"), "forest-encounters");
    assert.equal(slugify("D&D 5e — Treasure!"), "d-d-5e-treasure");
    assert.equal(slugify("   "), "untitled");
    assert.equal(fileNameFor("Forest Encounters"), "forest-encounters.orangey.json");
    assert.equal(
      fileNameFor("Forest Encounters", ["forest-encounters.orangey.json"]),
      "forest-encounters-2.orangey.json",
    );
    // Some file systems do not tell case apart, so neither may we.
    assert.equal(
      fileNameFor("Forest Encounters", ["FOREST-ENCOUNTERS.orangey.json", "forest-encounters-2.orangey.json"]),
      "forest-encounters-3.orangey.json",
    );
  });

  test("makeItem gives every outcome its own id", () => {
    assert.notEqual(makeItem("x").id, makeItem("x").id);
  });
});
