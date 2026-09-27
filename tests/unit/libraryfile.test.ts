import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { LibraryService } from "../../src/storage/library.ts";
import { MemoryBackend } from "../../src/storage/memory.ts";
import { emptyRandomizer, type BoardRandomizer, type ListRandomizer, type Randomizer } from "../../src/model/randomizer.ts";
import {
  isLibraryText, parseLibrary, planExport, safeFilePath, safeFolder, serializeLibrary,
} from "../../src/storage/libraryfile.ts";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

function list(id: string, name: string, items: { label: string; goesTo?: string; image?: string; imageData?: string }[]): ListRandomizer {
  return { ...(emptyRandomizer("list", name) as ListRandomizer), id, items: items.map((i, n) => ({ id: `${id}-${n}`, weight: 1, ...i })) };
}

function board(id: string, name: string, ids: string[]): BoardRandomizer {
  return { ...(emptyRandomizer("board", name) as BoardRandomizer), id, entries: ids.map((e) => ({ id: e, name: e })) };
}

const setup = async () => {
  const library = new LibraryService(new MemoryBackend(), 20);
  await library.refresh();
  return library;
};

describe("a library file", () => {
  test("carries paths, folders and links, and leaves the pictures out", () => {
    const hoard = list("hoard", "Hoard", [{ label: "Gold", image: "img1" }]);
    const encounters = list("enc", "Encounters", [{ label: "Dragon", goesTo: "hoard", imageData: PNG }, { label: "Nothing" }]);
    const plan = planExport(
      [{ path: "D&D/Forest/encounters.orangey.json", randomizer: encounters }, { path: "D&D/Treasure/hoard.orangey.json", randomizer: hoard }],
      ["D&D/Forest/encounters.orangey.json"],
      "D&D",
    );
    // What the wheel links to comes along, at its own place in the library.
    assert.deepEqual(plan.entries.map((e) => e.path), ["Forest/encounters.orangey.json", "D&D/Treasure/hoard.orangey.json"]);
    assert.equal(plan.linked, 1);
    assert.equal(plan.pictures, 2);

    const text = serializeLibrary("Forest", "2026-09-27T12:00:00.000Z", ["Forest", "Forest/Empty"], plan.entries);
    assert.ok(!text.includes("image"), "no picture, by id or inline, reaches the file");
    assert.ok(text.includes('"goesTo": "hoard"'), "the link travels as the id it names");
    assert.ok(isLibraryText(text));
    assert.ok(!isLibraryText('{"format": "orangey", "version": 1}'), "one randomizer is not a library");
    assert.ok(!isLibraryText("Goblins, 3\nWolves, 1"));

    const read = parseLibrary(text);
    assert.equal(read.name, "Forest");
    assert.deepEqual(read.folders, ["Forest", "Forest/Empty"]);
    assert.deepEqual(read.entries.map((e) => [e.path, e.file.randomizer.id]), [
      ["Forest/encounters.orangey.json", "enc"],
      ["D&D/Treasure/hoard.orangey.json", "hoard"],
    ]);
    assert.deepEqual(read.failed, []);
  });

  test("keeps a path from someone else's file inside the folder it is imported into", () => {
    assert.equal(safeFolder("../../etc"), "etc");
    assert.equal(safeFolder("C:\\Users\\x"), "C-/Users/x");
    assert.equal(safeFolder("/abs//path/"), "abs/path");
    assert.equal(safeFilePath("../secret/../../x.orangey.json", "X"), "secret/x.orangey.json");
    assert.equal(safeFilePath("Tables/run.sh", "Weather"), "Tables/weather.orangey.json", "anything but a randomizer file is renamed as one");
    assert.equal(safeFilePath("", "Weather"), "weather.orangey.json");
  });

  test("reads what it can: one bad randomizer is reported, not fatal, and duplicates are renamed", () => {
    const text = JSON.stringify({
      format: "orangey-library", version: 1, name: "Mixed",
      randomizers: [
        { path: "a.orangey.json", randomizer: list("a", "A", [{ label: "One" }]) },
        { path: "b.orangey.json", randomizer: { type: "list", name: "Broken" } },
        { path: "a.orangey.json", randomizer: list("c", "A", [{ label: "Two" }]) },
      ],
    });
    const read = parseLibrary(text);
    assert.deepEqual(read.entries.map((e) => e.path), ["a.orangey.json", "a-2.orangey.json"]);
    assert.equal(read.failed.length, 1);
    assert.equal(read.failed[0].path, "b.orangey.json");
  });

  test("refuses what is not one, and one from a newer Orangey", () => {
    assert.throws(() => parseLibrary("not json"), /not valid JSON/);
    assert.throws(() => parseLibrary('{"format": "orangey", "version": 1, "randomizer": {}}'), /orangey-library/);
    assert.throws(() => parseLibrary('{"format": "orangey-library", "version": 2, "randomizers": []}'), /newer Orangey/);
  });
});

describe("importing a library file", () => {
  const exported = (entries: { path: string; randomizer: Randomizer }[], folders: string[] = []) =>
    parseLibrary(serializeLibrary("Shared", "2026-09-27T12:00:00.000Z", folders, entries));

  test("builds the tree it describes, empty folders included, under the folder chosen", async () => {
    const library = await setup();
    const file = exported([
      { path: "Forest/encounters.orangey.json", randomizer: list("enc", "Encounters", [{ label: "Dragon", goesTo: "hoard" }]) },
      { path: "Treasure/hoard.orangey.json", randomizer: list("hoard", "Hoard", [{ label: "Gold" }]) },
    ], ["Forest", "Treasure", "Later"]);
    const result = await library.importLibrary(file.entries, file.folders, "Shared", async () => "skip");
    assert.deepEqual(result, { added: 2, replaced: 0, skipped: 0 });
    assert.deepEqual(library.folders().map((f) => f.path).sort(), ["", "Shared", "Shared/Forest", "Shared/Later", "Shared/Treasure"]);
    const enc = library.find("Shared/Forest/encounters.orangey.json")!.randomizer as ListRandomizer;
    assert.equal(enc.items[0].goesTo, "hoard");
    assert.equal(library.findById("hoard")!.path, "Shared/Treasure/hoard.orangey.json");
  });

  test("an id already here is changed, and the links in the file follow it", async () => {
    const library = await setup();
    await library.create("", list("hoard", "Someone else's hoard", [{ label: "Copper" }]));
    const file = exported([
      { path: "encounters.orangey.json", randomizer: list("enc", "Encounters", [{ label: "Dragon", goesTo: "hoard" }]) },
      { path: "night.orangey.json", randomizer: board("night", "Night", ["enc", "hoard"]) },
      { path: "Treasure/hoard.orangey.json", randomizer: list("hoard", "Hoard", [{ label: "Gold" }]) },
    ]);
    await library.importLibrary(file.entries, file.folders, "", async () => "skip");
    const arrived = library.find("Treasure/hoard.orangey.json")!.randomizer!;
    assert.notEqual(arrived.id, "hoard", "the arrival cannot share an id with what is here");
    const enc = library.find("encounters.orangey.json")!.randomizer as ListRandomizer;
    assert.equal(enc.items[0].goesTo, arrived.id, "the wheel still reaches the hoard it came with");
    const night = library.find("night.orangey.json")!.randomizer as BoardRandomizer;
    assert.deepEqual(night.entries.map((e) => e.id), ["enc", arrived.id]);
    assert.equal(library.findById("hoard")!.randomizer!.name, "Someone else's hoard", "and what was here is untouched");
  });

  test("Skip keeps what is here, Replace keeps its id, Keep both makes a copy the links follow", async () => {
    for (const [answer, expect] of [
      ["skip", { name: "Old hoard", linkTo: "old-id", files: 2 }],
      ["replace", { name: "Hoard", linkTo: "old-id", files: 2 }],
      ["keep-both", { name: "Old hoard", linkTo: "copy", files: 3 }],
    ] as const) {
      const library = await setup();
      await library.create("", list("old-id", "Old hoard", [{ label: "Copper" }]));
      assert.equal(library.findById("old-id")!.path, "old-hoard.orangey.json");
      const file = exported([
        { path: "old-hoard.orangey.json", randomizer: list("hoard", "Hoard", [{ label: "Gold" }]) },
        { path: "encounters.orangey.json", randomizer: list("enc", "Encounters", [{ label: "Dragon", goesTo: "hoard" }]) },
      ]);
      const asked: string[] = [];
      await library.importLibrary(file.entries, file.folders, "", async (path) => {
        asked.push(path);
        return answer;
      });
      assert.deepEqual(asked, ["old-hoard.orangey.json"]);
      assert.equal(library.find("old-hoard.orangey.json")!.randomizer!.name, expect.name, answer);
      assert.equal(library.files().length, expect.files, answer);
      const goesTo = (library.find("encounters.orangey.json")!.randomizer as ListRandomizer).items[0].goesTo!;
      if (expect.linkTo === "copy") {
        const copy = library.findById(goesTo)!;
        assert.notEqual(copy.path, "old-hoard.orangey.json", "keep both: the link reaches the copy");
        assert.equal(copy.randomizer!.name, "Hoard");
      } else {
        assert.equal(goesTo, expect.linkTo, answer);
      }
    }
  });

  test("a folder named like the picture store is moved aside, not mixed into it", async () => {
    const library = await setup();
    const file = exported([{ path: "images/cats.orangey.json", randomizer: list("cats", "Cats", [{ label: "Tabby" }]) }]);
    await library.importLibrary(file.entries, file.folders, "", async () => "skip");
    assert.equal(library.findById("cats")!.path, "images folder/cats.orangey.json");
  });
});
