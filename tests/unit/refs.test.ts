import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SeededSource } from "../../src/core/rng.ts";
import { emptyRandomizer, type ListRandomizer, type Randomizer } from "../../src/model/randomizer.ts";
import { offerFromList, rollListMany, rollRandomizer } from "../../src/model/roll.ts";
import {
  fillRefIds, keepRefs, MAX_REF_DEPTH, refIdsOf, refsIn, remapRefs, renameRefs, resolverFor, showRefs,
} from "../../src/model/refs.ts";
import { LibraryService } from "../../src/storage/library.ts";
import { MemoryBackend } from "../../src/storage/memory.ts";
import { parseLibrary, planExport, serializeLibrary } from "../../src/storage/libraryfile.ts";

function list(id: string, name: string, labels: string[]): ListRandomizer {
  return { ...(emptyRandomizer("list", name) as ListRandomizer), id, items: labels.map((label, n) => ({ id: `${id}-${n}`, label, weight: 1 })) };
}
const rng = (seed = "refs") => new SeededSource(seed);

const weather = list("w1", "Weather", ["fog", "rain"]);
const beast = list("b1", "Beast", ["wolf", "bear"]);
const morning = list("m1", "Morning", ["A {@Weather|w1} morning"]);
const refs = resolverFor([weather, beast, morning]);

describe("references in text", () => {
  test("are found, with or without an id, and the editor sees only names", () => {
    assert.deepEqual(refsIn("a {@Weather|w1} and {@ Beast } and {2d6}"), [{ name: "Weather", id: "w1" }, { name: "Beast" }]);
    assert.equal(showRefs("A {@Weather|w1} morning"), "A {@Weather} morning");
    assert.deepEqual(refIdsOf(morning), ["w1"]);
  });

  test("keep their id through an edit, take the one table's id when typed new, and stay names when unsure", () => {
    const byName = (name: string) => [weather, beast, list("b2", "Beast", [])].filter((r) => r.name.toLowerCase() === name.toLowerCase());
    assert.equal(keepRefs("A {@Weather} cold morning", "A {@Weather|w1} morning", byName), "A {@Weather|w1} cold morning");
    // Two tables called Beast: no guessing.
    assert.equal(keepRefs("{@Beast} and {@weather}", "", byName), "{@Beast} and {@weather|w1}");
    // An old name keeps its id even if the table has been renamed since.
    assert.equal(keepRefs("{@Old name}", "{@Old name|w1}", () => []), "{@Old name|w1}");
  });

  test("follow a new id, a new name, and get ids filled in", () => {
    assert.equal(remapRefs("{@Weather|w1} {@Beast|b1}", new Map([["w1", "w9"]])), "{@Weather|w9} {@Beast|b1}");
    assert.equal(renameRefs("{@Weather|w1} {@Weather|zz}", "w1", "Sky"), "{@Sky|w1} {@Weather|zz}");
    assert.equal(fillRefIds("{@weather} {@Nobody}", refs), "{@weather|w1} {@Nobody}");
  });
});

describe("rolling a reference", () => {
  test("rolls the table and puts its answer in, and says which table gave what", () => {
    const o = rollRandomizer(morning, rng(), refs);
    assert.match(o.text, /^A (fog|rain) morning$/);
    assert.deepEqual(o.parts?.map((p) => [p.id, p.name]), [["w1", "Weather"]]);
    assert.match(o.detail ?? "", /Weather: (fog|rain)/);
  });

  test("is the same for the same seed, and dice and tables draw in reading order", () => {
    const mixed = list("x", "Mixed", ["{2d6} {@Weather|w1} {1d4}"]);
    const a = rollRandomizer(mixed, rng("s"), refs).text;
    const b = rollRandomizer(mixed, rng("s"), refs).text;
    assert.equal(a, b);
    assert.match(a, /^\d+ (fog|rain) [1-4]$/);
    // A text without references draws exactly as before they existed.
    const plain = list("p", "Plain", ["{2d6} and {1d4}"]);
    assert.equal(rollRandomizer(plain, rng("s"), refs).text, rollRandomizer(plain, rng("s")).text);
  });

  test("without a library, by a missing id and name, or into a board, it reads as the name", () => {
    assert.equal(rollRandomizer(morning, rng()).text, "A Weather morning");
    const lost = list("l", "Lost", ["{@Gone|nope} here"]);
    assert.equal(rollRandomizer(lost, rng(), refs).text, "Gone here");
    // A reference by name works when its id is gone but one table has the name.
    const renamed = list("r", "R", ["{@Weather|old-id}"]);
    assert.match(rollRandomizer(renamed, rng(), refs).text, /^(fog|rain)$/);
  });

  test("goes several tables deep, but never round in a circle or past the limit", () => {
    const a = list("a", "A", ["a>{@B|b}"]);
    const b = list("b", "B", ["b>{@A|a}"]);
    const circle = resolverFor([a, b]);
    assert.equal(rollRandomizer(a, rng(), circle).text, "a>b>A");
    const chain: Randomizer[] = Array.from({ length: MAX_REF_DEPTH + 3 }, (_, i) => list(`c${i}`, `C${i}`, [`${i}{@C${i + 1}|c${i + 1}}`]));
    const deep = rollRandomizer(chain[0], rng(), resolverFor(chain)).text;
    assert.equal(deep, `${Array.from({ length: MAX_REF_DEPTH + 1 }, (_, i) => i).join("")}C${MAX_REF_DEPTH + 1}`);
  });

  test("works in a several-at-once roll and in an offer", () => {
    assert.ok(!rollListMany(morning, 3, rng(), undefined, refs).text.includes("{@"));
    const offer = offerFromList(list("o", "O", ["{@Beast|b1}", "{@Weather|w1}"]), 2, rng(), refs);
    assert.ok(offer.every((o) => !o.text.includes("{@") && o.parts?.length === 1));
  });
});

describe("references in the library", () => {
  const setup = async () => {
    const library = new LibraryService(new MemoryBackend(), 5);
    await library.refresh();
    return library;
  };

  test("an exported file brings the tables referred to; an import with a clash sends the reference to the new id", async () => {
    const plan = planExport([{ path: "m.orangey.json", randomizer: morning }, { path: "Sky/w.orangey.json", randomizer: weather }], ["m.orangey.json"]);
    assert.deepEqual(plan.entries.map((e) => e.path), ["m.orangey.json", "Sky/w.orangey.json"]);
    const library = await setup();
    await library.create("", list("w1", "Mine", ["x"]));
    const text = serializeLibrary("x", "now", ["Sky"], plan.entries);
    await library.importLibrary(parseLibrary(text).entries, ["Sky"], "", async () => "keep-both");
    const newWeather = library.find("Sky/w.orangey.json")!.randomizer!;
    assert.notEqual(newWeather.id, "w1");
    assert.equal((library.find("m.orangey.json")!.randomizer as ListRandomizer).items[0].label, `A {@Weather|${newWeather.id}} morning`);
  });

  test("a hand-written {@Name} gets its id on import", async () => {
    const library = await setup();
    const handMade = list("h", "Hand", ["A {@weather} day"]);
    const text = serializeLibrary("x", "now", [], [{ path: "w.orangey.json", randomizer: weather }, { path: "h.orangey.json", randomizer: handMade }]);
    await library.importLibrary(parseLibrary(text).entries, [], "", async () => "keep-both");
    assert.equal((library.findById("h")!.randomizer as ListRandomizer).items[0].label, "A {@weather|w1} day");
  });

  test("renaming a table, from the menu or in the editor, renames the references to it", async () => {
    const library = await setup();
    const wp = await library.create("", weather);
    await library.create("", morning);
    await library.rename(wp, "Sky");
    assert.equal((library.findById("m1")!.randomizer as ListRandomizer).items[0].label, "A {@Sky|w1} morning");
    library.save(library.findById("w1")!.path, { ...library.findById("w1")!.randomizer!, name: "Heavens" } as Randomizer);
    await library.flush();
    assert.equal((library.findById("m1")!.randomizer as ListRandomizer).items[0].label, "A {@Heavens|w1} morning");
    await library.refresh();
    assert.equal((library.findById("m1")!.randomizer as ListRandomizer).items[0].label, "A {@Heavens|w1} morning", "the rename was not written");
  });

  test("the library answers references by id and by name", async () => {
    const library = await setup();
    await library.create("", weather);
    assert.equal(library.refs.byId("w1")!.name, "Weather");
    assert.equal(library.refs.byName("WEATHER").length, 1);
  });
});
