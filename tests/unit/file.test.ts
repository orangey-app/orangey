import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { FORMAT_VERSION, fileNameFor, parseFile, serialize, slugify, wrap } from "../../src/model/file.ts";
import { emptyRandomizer, makeItem, type ListRandomizer } from "../../src/model/randomizer.ts";
import { ValidationError } from "../../src/model/validate.ts";

function sample(): ListRandomizer {
  return {
    id: "5f1c0000-0000-4000-8000-000000000001",
    type: "list",
    name: "Forest Encounters",
    description: "Daytime, levels 1–4",
    view: "wheel",
    created: "2026-09-08T18:00:00.000Z",
    modified: "2026-09-08T18:20:00.000Z",
    items: [
      { id: "a1", label: "Goblin patrol", weight: 50 },
      { id: "a2", label: "Merchant", weight: 20, description: "Friendly, overpriced" },
      { id: "a3", label: "Wolf pack", weight: 20, disabled: true },
      { id: "a4", label: "Dragon", weight: 1, color: "#a33a30" },
    ],
  };
}

describe("file format", () => {
  test("round-trips byte for byte", () => {
    const text = serialize(wrap(sample()));
    const again = serialize(parseFile(text).file);
    assert.equal(again, text);
  });

  test("is two-space indented, LF terminated, with keys in a stable order", () => {
    const text = serialize(wrap(sample()));
    assert.ok(text.endsWith("}\n"));
    assert.ok(!text.includes("\r"));
    assert.ok(text.includes('\n  "version": 1,'));
    const keys = [...text.matchAll(/^ {4}"(\w+)":/gm)].map((m) => m[1]);
    assert.deepEqual(keys.slice(0, 6), ["id", "type", "name", "description", "view", "created"]);
    const itemKeys = [...text.matchAll(/^ {8}"(\w+)":/gm)].map((m) => m[1]);
    assert.equal(itemKeys[0], "id");
    assert.equal(itemKeys[1], "label");
    assert.equal(itemKeys[2], "weight");
  });

  test("disabled outcomes keep their weight in the file", () => {
    const parsed = parseFile(serialize(wrap(sample()))).file.randomizer as ListRandomizer;
    const wolf = parsed.items.find((i) => i.label === "Wolf pack")!;
    assert.equal(wolf.disabled, true);
    assert.equal(wolf.weight, 20);
  });

  test("an outcome's Orangey tag is saved after its colour and round-trips", () => {
    const r = sample();
    r.items[3] = { ...r.items[3], reaction: "cheer" };
    r.items[2] = { ...r.items[2], reaction: "wince" };
    const text = serialize(wrap(r));
    const dragon = text.slice(text.indexOf('"Dragon"'));
    assert.ok(dragon.indexOf('"color"') < dragon.indexOf('"reaction": "cheer"'), "reaction follows colour");
    const parsed = parseFile(text).file.randomizer as ListRandomizer;
    assert.equal(parsed.items[3].reaction, "cheer");
    assert.equal(parsed.items[2].reaction, "wince");
    assert.equal(parsed.items[0].reaction, undefined);
    assert.equal(serialize(parseFile(text).file), text);
  });

  test("a tag that is not cheer or wince is refused, with the path", () => {
    const doc = JSON.parse(serialize(wrap(sample())));
    doc.randomizer.items[0].reaction = "dance";
    assert.throws(() => parseFile(JSON.stringify(doc)), (e: unknown) => {
      assert.ok(e instanceof ValidationError);
      assert.match(String(e.message), /items\[0\]\.reaction/);
      return true;
    });
  });

  test("a coin's faceReactions are one entry per face, null for none", () => {
    const coin = { ...emptyRandomizer("coin", "Fate"), faces: ["Yes", "No"] as [string, string], faceReactions: [null, "wince"] as [null, "wince"] };
    const text = serialize(wrap(coin));
    assert.ok(text.indexOf('"faces"') < text.indexOf('"faceReactions"'));
    const parsed = parseFile(text).file.randomizer;
    assert.deepEqual((parsed as typeof coin).faceReactions, [null, "wince"]);
    const doc = JSON.parse(text);
    doc.randomizer.faceReactions = ["cheer"];
    assert.throws(() => parseFile(JSON.stringify(doc)), /faceReactions/);
    doc.randomizer.faceReactions = ["cheer", "sulk"];
    assert.throws(() => parseFile(JSON.stringify(doc)), /faceReactions\[1\]/);
  });

  test("unknown keys survive a round trip", () => {
    const doc = JSON.parse(serialize(wrap(sample())));
    doc.futureThing = { a: 1 };
    const out = parseFile(JSON.stringify(doc));
    assert.deepEqual(out.file.unknown, { futureThing: { a: 1 } });
    assert.ok(serialize(out.file).includes("futureThing"));
  });

  test("a newer format version opens read-only with an explanation", () => {
    const doc = JSON.parse(serialize(wrap(sample())));
    doc.version = FORMAT_VERSION + 1;
    const out = parseFile(JSON.stringify(doc));
    assert.equal(out.readOnly, true);
    assert.match(out.warnings[0], /newer Orangey/);
  });

  test("validation messages name the failing path", () => {
    const doc = JSON.parse(serialize(wrap(sample())));
    doc.randomizer.items[3].weight = -2;
    doc.randomizer.items[1].label = "";
    try {
      parseFile(JSON.stringify(doc));
      assert.fail("expected a ValidationError");
    } catch (e) {
      assert.ok(e instanceof ValidationError);
      const paths = e.issues.map((i) => i.path);
      assert.ok(paths.includes("randomizer.items[3].weight"), paths.join(", "));
      assert.ok(paths.includes("randomizer.items[1].label"), paths.join(", "));
    }
  });

  test("a bare randomizer object is accepted", () => {
    const out = parseFile(JSON.stringify(sample()));
    assert.equal(out.file.randomizer.name, "Forest Encounters");
  });

  test("broken JSON fails with a readable message", () => {
    assert.throws(() => parseFile("{nope"), (e: unknown) => e instanceof ValidationError && /not valid JSON/.test(e.message));
  });

  test("a randomizer's own feel settings round-trip in a stable position", () => {
    const r = { ...sample(), feel: { wheel: { turns: 3, settleDegrees: 20 } } };
    const text = serialize(wrap(r));
    assert.equal(serialize(parseFile(text).file), text);
    const keys = [...text.matchAll(/^ {4}"(\w+)":/gm)].map((m) => m[1]);
    assert.ok(keys.indexOf("feel") < keys.indexOf("created"), "feel is written before the timestamps");
    assert.deepEqual((parseFile(text).file.randomizer as { feel?: unknown }).feel, { wheel: { turns: 3, settleDegrees: 20 } });
  });

  test("a feel field that is not an object is rejected", () => {
    const doc = JSON.parse(serialize(wrap(sample())));
    doc.randomizer.feel = "fast";
    assert.throws(() => parseFile(JSON.stringify(doc)), ValidationError);
  });

  test("every randomizer type round-trips", () => {
    for (const type of ["list", "dice", "coin", "number"] as const) {
      const r = emptyRandomizer(type, `A ${type}`);
      const text = serialize(wrap(r));
      assert.equal(serialize(parseFile(text).file), text, `for ${type}`);
    }
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
    assert.equal(
      fileNameFor("Forest Encounters", ["FOREST-ENCOUNTERS.orangey.json", "forest-encounters-2.orangey.json"]),
      "forest-encounters-3.orangey.json",
    );
  });

  test("a list must have at least one outcome", () => {
    const doc = JSON.parse(serialize(wrap(sample())));
    doc.randomizer.items = [];
    assert.throws(() => parseFile(JSON.stringify(doc)), ValidationError);
  });

  test("makeItem gives every outcome its own id", () => {
    const a = makeItem("x");
    const b = makeItem("x");
    assert.notEqual(a.id, b.id);
  });
});
