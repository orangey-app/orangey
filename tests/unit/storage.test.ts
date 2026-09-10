import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { LibraryService, type LibraryBackend } from "../../src/storage/library.ts";
import { MemoryBackend } from "../../src/storage/memory.ts";
import { emptyRandomizer, makeItem, type ListRandomizer } from "../../src/model/randomizer.ts";
import { parseFile, serialize, wrap } from "../../src/model/file.ts";
import { basename, isInside, join, naturalCompare, parent, sanitizeName, segments } from "../../src/storage/paths.ts";
import { createZip, crc32, readZip } from "../../src/storage/zip.ts";

/** The shared backend suite. Every backend must pass this. */
function backendSuite(name: string, make: () => LibraryBackend): void {
  describe(`${name} backend`, () => {
    test("writes, reads, lists and removes", async () => {
      const b = make();
      await b.mkdir("D&D/Encounters");
      await b.write("D&D/Encounters/forest.orangey.json", "hello");
      assert.equal(await b.read("D&D/Encounters/forest.orangey.json"), "hello");
      assert.deepEqual(await b.list(""), [{ name: "D&D", kind: "folder" }]);
      assert.deepEqual(await b.list("D&D/Encounters"), [{ name: "forest.orangey.json", kind: "file" }]);
      await b.remove("D&D/Encounters/forest.orangey.json");
      assert.deepEqual(await b.list("D&D/Encounters"), []);
    });

    test("writing creates the folders it needs", async () => {
      const b = make();
      await b.write("a/b/c/file.txt", "x");
      assert.equal(await b.read("a/b/c/file.txt"), "x");
    });

    test("moves files and whole folders", async () => {
      const b = make();
      await b.write("one/file.txt", "x");
      await b.move("one/file.txt", "two/file.txt");
      assert.equal(await b.read("two/file.txt"), "x");
      await b.write("two/deeper/other.txt", "y");
      await b.move("two", "three");
      assert.equal(await b.read("three/file.txt"), "x");
      assert.equal(await b.read("three/deeper/other.txt"), "y");
      await assert.rejects(() => b.read("two/file.txt"));
    });

    test("removing a folder removes what is inside it", async () => {
      const b = make();
      await b.write("gone/a.txt", "a");
      await b.write("gone/deeper/b.txt", "b");
      await b.remove("gone");
      assert.deepEqual(await b.list(""), []);
    });

    test("reading something that is not there fails clearly", async () => {
      await assert.rejects(() => make().read("nope.txt"), /nope/);
    });
  });
}

backendSuite("memory", () => new MemoryBackend());

describe("paths", () => {
  test("join, parent, basename and segments agree with each other", () => {
    assert.equal(join("a", "b", "c"), "a/b/c");
    assert.equal(join("", "b"), "b");
    assert.equal(parent("a/b/c"), "a/b");
    assert.equal(parent("a"), "");
    assert.equal(basename("a/b/c"), "c");
    assert.deepEqual(segments("a/b"), ["a", "b"]);
    assert.deepEqual(segments(""), []);
  });

  test("isInside is true for a folder and everything under it", () => {
    assert.ok(isInside("a/b/c", "a"));
    assert.ok(isInside("a", ""));
    assert.ok(!isInside("ab/c", "a"));
  });

  test("names are cleaned of characters that break on some systems", () => {
    assert.equal(sanitizeName('a/b\\c:d*e?f"g<h>i|j'), "a-b-c-d-e-f-g-h-i-j");
    assert.equal(sanitizeName("  spaced  out  "), "spaced out");
    assert.equal(sanitizeName("trailing."), "trailing");
  });

  test("sorting is natural, so Chapter 2 comes before Chapter 10", () => {
    const names = ["Chapter 10", "Chapter 2", "Chapter 1"];
    assert.deepEqual([...names].sort(naturalCompare), ["Chapter 1", "Chapter 2", "Chapter 10"]);
  });
});

describe("library service", () => {
  const setup = async () => {
    const backend = new MemoryBackend();
    const library = new LibraryService(backend, 20);
    await library.refresh();
    return { backend, library };
  };

  test("creates, finds, renames, moves, duplicates and removes", async () => {
    const { library } = await setup();
    const folder = await library.createFolder("", "D&D");
    const path = await library.create(folder, emptyRandomizer("list", "Forest Encounters"));
    assert.equal(path, "D&D/forest-encounters.orangey.json");
    assert.ok(library.find(path));

    const renamed = await library.rename(path, "Dungeon Encounters");
    assert.equal(renamed, "D&D/dungeon-encounters.orangey.json");
    assert.equal(library.find(renamed)?.randomizer?.name, "Dungeon Encounters");

    const copy = await library.duplicate(renamed);
    assert.match(copy, /dungeon-encounters-copy/);
    assert.notEqual(library.find(copy)?.randomizer?.id, library.find(renamed)?.randomizer?.id);
    assert.equal(library.find(copy)?.randomizer?.name, "Dungeon Encounters (copy)");

    const moved = await library.move(copy, "");
    assert.equal(moved, "dungeon-encounters-copy.orangey.json");

    await library.remove(moved);
    assert.equal(library.find(moved), null);
    assert.equal(library.files().length, 1);
  });

  test("duplicating gives every outcome a fresh id", async () => {
    const { library } = await setup();
    const path = await library.create("", emptyRandomizer("list", "Copy me"));
    const copy = await library.duplicate(path);
    const before = (library.find(path)!.randomizer as ListRandomizer).items.map((i) => i.id);
    const after = (library.find(copy)!.randomizer as ListRandomizer).items.map((i) => i.id);
    assert.equal(before.length, after.length);
    for (const id of after) assert.ok(!before.includes(id));
  });

  test("saves are debounced into as few writes as possible", async () => {
    const { backend, library } = await setup();
    const path = await library.create("", emptyRandomizer("list", "Busy"));
    let writes = 0;
    const original = backend.write.bind(backend);
    backend.write = async (p, c) => {
      writes++;
      await original(p, c);
    };
    const node = library.find(path)!;
    for (let i = 0; i < 20; i++) {
      library.save(path, { ...node.randomizer!, name: `Busy ${i}` });
    }
    await library.flush();
    assert.ok(writes <= 2, `${writes} writes for 20 rapid saves`);
    const text = await backend.read(path);
    assert.match(text, /"name": "Busy 19"/);
  });

  test("search looks inside outcome labels, tags and descriptions", async () => {
    const { library } = await setup();
    const base = emptyRandomizer("list", "Forest Encounters") as ListRandomizer;
    await library.create("", {
      ...base,
      tags: ["outdoors"],
      description: "For low levels",
      items: [makeItem("Wolf pack", 2), makeItem("Merchant", 1)],
    });
    assert.equal(library.search("forest")[0].reason, "name");
    assert.equal(library.search("wolf")[0].reason, "outcome");
    assert.equal(library.search("outdoors")[0].reason, "tag");
    assert.equal(library.search("low levels")[0].reason, "description");
    assert.deepEqual(library.search("nothing here"), []);
    assert.deepEqual(library.search("   "), []);
  });

  test("a damaged file is reported, not fatal", async () => {
    const { backend, library } = await setup();
    await backend.write("broken.orangey.json", "{ not json");
    await library.refresh();
    const node = library.find("broken.orangey.json")!;
    assert.equal(node.randomizer, null);
    assert.match(node.error!, /not valid JSON/);
    assert.equal(library.files().length, 1);
  });

  test("files sort naturally by their randomizer's name", async () => {
    const { library } = await setup();
    for (const name of ["Table 10", "Table 2", "Table 1"]) {
      await library.create("", emptyRandomizer("list", name));
    }
    assert.deepEqual(library.files().map((f) => f.randomizer!.name), ["Table 1", "Table 2", "Table 10"]);
  });

  test("a name collision does not overwrite an existing file", async () => {
    const { library } = await setup();
    const a = await library.create("", emptyRandomizer("list", "Same name"));
    const b = await library.create("", emptyRandomizer("list", "Same name"));
    assert.notEqual(a, b);
    assert.equal(library.files().length, 2);
  });
});

describe("importing an archive", () => {
  const setup = async () => {
    const backend = new MemoryBackend();
    const library = new LibraryService(backend, 20);
    await library.refresh();
    return { backend, library };
  };
  const entry = (path: string, name: string) => ({ path, text: serialize(wrap(emptyRandomizer("list", name))) });

  test("new files are added with their folders", async () => {
    const { library } = await setup();
    const result = await library.importArchive([entry("D&D/Encounters/forest.orangey.json", "Forest"), entry("top.orangey.json", "Top")], async () => "skip");
    assert.deepEqual(result, { added: 2, replaced: 0, skipped: 0, failed: 0 });
    assert.deepEqual(library.files().map((f) => f.path).sort(), ["D&D/Encounters/forest.orangey.json", "top.orangey.json"]);
  });

  test("collisions are decided per file: replace, keep both, or skip", async () => {
    const { library } = await setup();
    await library.importArchive([entry("a.orangey.json", "Old A"), entry("b.orangey.json", "Old B"), entry("c.orangey.json", "Old C")], async () => "skip");
    const answers: Record<string, "replace" | "keep-both" | "skip"> = { "a.orangey.json": "replace", "b.orangey.json": "keep-both", "c.orangey.json": "skip" };
    const result = await library.importArchive([entry("a.orangey.json", "New A"), entry("b.orangey.json", "New B"), entry("c.orangey.json", "New C")], async (p) => answers[p]);
    assert.deepEqual(result, { added: 1, replaced: 1, skipped: 1, failed: 0 });
    const names = library.files().map((f) => f.randomizer!.name).sort();
    assert.deepEqual(names, ["New A", "New B", "Old B", "Old C"]);
  });

  test("unreadable entries are counted, not fatal", async () => {
    const { library } = await setup();
    const result = await library.importArchive([{ path: "bad.orangey.json", text: "{nope" }, entry("ok.orangey.json", "OK"), { path: "notes.txt", text: "ignored" }], async () => "skip");
    assert.deepEqual(result, { added: 1, replaced: 0, skipped: 0, failed: 1 });
  });

  test("the folder list is depth-annotated and starts at the root", async () => {
    const { library } = await setup();
    await library.createFolder("", "A");
    await library.createFolder("A", "B");
    assert.deepEqual(library.folderList(), [
      { path: "", name: "Library", depth: 0 },
      { path: "A", name: "A", depth: 1 },
      { path: "A/B", name: "B", depth: 2 },
    ]);
  });
});

describe("starters", () => {
  test("are valid randomizers that round-trip through the file format", async () => {
    const { starters } = await import("../../src/model/starters.ts");
    const all = starters();
    assert.ok(all.length >= 5);
    for (const s of all) {
      const text = serialize(wrap(s.randomizer));
      assert.equal(serialize(parseFile(text).file), text, s.randomizer.name);
    }
    assert.ok(all.some((s) => s.randomizer.type === "list") && all.some((s) => s.randomizer.type === "dice"));
  });
});

describe("zip", () => {
  test("round-trips a folder tree", async () => {
    const entries = [
      { path: "D&D/Encounters/forest.orangey.json", text: serialize(wrap(emptyRandomizer("list", "Forest"))) },
      { path: "D&D/Treasure/coins.orangey.json", text: serialize(wrap(emptyRandomizer("dice", "Coins"))) },
      { path: "top.orangey.json", text: serialize(wrap(emptyRandomizer("coin", "Top"))) },
    ];
    const bytes = await createZip(entries);
    const back = await readZip(bytes);
    assert.deepEqual(back, entries);
    for (const entry of back) assert.ok(parseFile(entry.text).file.randomizer.name);
  });

  test("compresses repetitive content", async () => {
    const text = "x".repeat(20000);
    const bytes = await createZip([{ path: "a.txt", text }]);
    assert.ok(bytes.length < 2000, `${bytes.length} bytes for 20 kB of "x"`);
    assert.equal((await readZip(bytes))[0].text, text);
  });

  test("rejects something that is not a ZIP", async () => {
    await assert.rejects(() => readZip(new TextEncoder().encode("hello")), /does not look like a ZIP/);
  });

  test("CRC32 matches the known value for a standard string", () => {
    assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  });
});
