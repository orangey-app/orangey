import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { LibraryService, type LibraryBackend } from "../../src/storage/library.ts";
import { MemoryBackend } from "../../src/storage/memory.ts";
import { DirectoryBackend } from "../../src/storage/fsdir.ts";
import { emptyRandomizer, makeItem, type ListRandomizer } from "../../src/model/randomizer.ts";
import { parseFile, serialize, wrap } from "../../src/model/file.ts";
import { basename, isInside, join, naturalCompare, parent, sanitizeName, segments } from "../../src/storage/paths.ts";
import { createZip, readZip } from "../../src/storage/zip.ts";

const setup = async () => {
  const backend = new MemoryBackend();
  const library = new LibraryService(backend, 20);
  await library.refresh();
  return { backend, library };
};

describe("a storage backend", () => {
  test("writes, reads, lists, moves and removes, making the folders it needs on the way", async () => {
    const b = new MemoryBackend();
    await b.write("D&D/Encounters/forest.orangey.json", "hello");
    assert.equal(await b.read("D&D/Encounters/forest.orangey.json"), "hello");
    assert.deepEqual(await b.list(""), [{ name: "D&D", kind: "folder" }]);
    assert.deepEqual(await b.list("D&D/Encounters"), [{ name: "forest.orangey.json", kind: "file" }]);

    // Moving a folder takes everything under it along.
    await b.write("D&D/Treasure/coins.orangey.json", "gold");
    await b.move("D&D", "Campaign");
    assert.equal(await b.read("Campaign/Encounters/forest.orangey.json"), "hello");
    assert.equal(await b.read("Campaign/Treasure/coins.orangey.json"), "gold");
    await assert.rejects(() => b.read("D&D/Encounters/forest.orangey.json"));

    // As does removing it.
    await b.remove("Campaign");
    assert.deepEqual(await b.list(""), []);
    await assert.rejects(() => b.read("nope.txt"), /nope/);
  });
});

/**
 * Just enough of a FileSystemDirectoryHandle to run the folder backend here.
 * It holds bytes, so what the backend writes is what a person would find in
 * the folder.
 */
class FakeDirectory {
  readonly kind = "directory";
  name: string;
  #files = new Map<string, Uint8Array>();
  #dirs = new Map<string, FakeDirectory>();

  constructor(name = "") {
    this.name = name;
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDirectory> {
    let dir = this.#dirs.get(name);
    if (!dir) {
      if (!options?.create) throw new Error(`no folder ${name}`);
      dir = new FakeDirectory(name);
      this.#dirs.set(name, dir);
    }
    return dir;
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    const files = this.#files;
    if (!files.has(name)) {
      if (!options?.create) throw new Error(`no file ${name}`);
      files.set(name, new Uint8Array());
    }
    return {
      kind: "file" as const,
      name,
      async getFile() {
        return new Blob([files.get(name)!]);
      },
      async createWritable() {
        const chunks: BlobPart[] = [];
        return {
          async write(chunk: string | Uint8Array) {
            chunks.push(chunk);
          },
          async close() {
            files.set(name, new Uint8Array(await new Blob(chunks).arrayBuffer()));
          },
        };
      },
    };
  }

  async removeEntry(name: string): Promise<void> {
    this.#files.delete(name);
    this.#dirs.delete(name);
  }

  async *entries(): AsyncGenerator<[string, { kind: string }]> {
    for (const name of this.#files.keys()) yield [name, { kind: "file" }];
    for (const [name, dir] of this.#dirs) yield [name, dir];
  }
}

describe("bytes in a backend", () => {
  test("a picture arrives as the bytes it was given, in every backend that has one", async () => {
    // 0xff is not valid UTF-8, so a backend that put this through text on the
    // way in or out would hand back something else: the assertion is the test.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x80, 0x01]);
    const backends: [string, LibraryBackend][] = [
      ["memory", new MemoryBackend()],
      ["a folder", new DirectoryBackend(new FakeDirectory() as unknown as FileSystemDirectoryHandle, "fsa", "Pictures")],
    ];

    for (const [what, backend] of backends) {
      await backend.writeBytes("images/a.png", png);
      assert.deepEqual(await backend.readBytes("images/a.png"), png, what);
      assert.deepEqual(await backend.list("images"), [{ name: "a.png", kind: "file" }], what);

      // Text and bytes are the same two doors onto the same file.
      await backend.write("notes.txt", "hello");
      assert.deepEqual(await backend.readBytes("notes.txt"), new TextEncoder().encode("hello"), what);
      await backend.writeBytes("again.txt", new TextEncoder().encode("hello"));
      assert.equal(await backend.read("again.txt"), "hello", what);

      await backend.remove("images/a.png");
      await assert.rejects(() => backend.readBytes("images/a.png"), what);
    }
  });
});

describe("paths", () => {
  test("join, parent, basename, segments and isInside agree with each other", () => {
    assert.equal(join("a", "b", "c"), "a/b/c");
    assert.equal(join("", "b"), "b");
    assert.equal(parent("a/b/c"), "a/b");
    assert.equal(parent("a"), "");
    assert.equal(basename("a/b/c"), "c");
    assert.deepEqual(segments("a/b"), ["a", "b"]);
    assert.deepEqual(segments(""), []);
    assert.ok(isInside("a/b/c", "a"));
    assert.ok(isInside("a", ""));
    assert.ok(!isInside("ab/c", "a"), "a prefix of a name is not a parent folder");
    // Names sort naturally, so Chapter 2 comes before Chapter 10 (decision D11).
    assert.deepEqual(["Chapter 10", "Chapter 2", "Chapter 1"].sort(naturalCompare), ["Chapter 1", "Chapter 2", "Chapter 10"]);
  });

  test("a name cannot carry a separator, a dot-dot or anything that breaks on some systems", () => {
    // Everything the user types passes through here, so this is what stops a
    // name reaching outside its folder or landing on a path no OS will open.
    assert.equal(sanitizeName('a/b\\c:d*e?f"g<h>i|j'), "a-b-c-d-e-f-g-h-i-j");
    assert.equal(sanitizeName("  spaced  out  "), "spaced out");
    assert.equal(sanitizeName("trailing."), "trailing");
    assert.equal(sanitizeName(".."), "", "a bare dot-dot leaves nothing behind");
    for (const name of ["../../etc/passwd", "..\\..\\windows", "a/../b"]) {
      const clean = sanitizeName(name);
      assert.ok(!clean.includes("/") && !clean.includes("\\"), `${name} kept a separator: ${clean}`);
      assert.ok(!segments(clean).includes(".."), `${name} kept a dot-dot: ${clean}`);
    }
  });
});

describe("the library", () => {
  test("a file survives being created, renamed, moved, duplicated and removed", async () => {
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
    assert.equal(library.find(copy)?.randomizer?.name, "Dungeon Encounters (copy)");
    // A copy is a new randomizer, not a second name for the same one: the
    // file's id and every outcome's id must be fresh, or edits to one would
    // follow the other around.
    assert.notEqual(library.find(copy)?.randomizer?.id, library.find(renamed)?.randomizer?.id);
    const before = (library.find(renamed)!.randomizer as ListRandomizer).items.map((i) => i.id);
    const after = (library.find(copy)!.randomizer as ListRandomizer).items.map((i) => i.id);
    assert.equal(after.length, before.length);
    for (const id of after) assert.ok(!before.includes(id), "an outcome id was shared with the original");

    const moved = await library.move(copy, "");
    assert.equal(moved, "dungeon-encounters-copy.orangey.json");
    assert.equal(library.find(moved)?.randomizer?.name, "Dungeon Encounters (copy)");

    await library.remove(moved);
    assert.equal(library.find(moved), null);
    assert.equal(library.files().length, 1);
  });

  test("two files with the same name live side by side, and a traversing name stays put", async () => {
    const { library } = await setup();
    const a = await library.create("", emptyRandomizer("list", "Same name"));
    const b = await library.create("", emptyRandomizer("list", "Same name"));
    assert.notEqual(a, b, "the second file overwrote the first");
    assert.equal(library.files().length, 2);
    // A name that looks like a path must still produce one file, in this folder.
    const sneaky = await library.create("", emptyRandomizer("list", "../../etc/passwd"));
    assert.equal(segments(sneaky).length, 1, `escaped to ${sneaky}`);
    assert.ok(library.find(sneaky));
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
    assert.match(await backend.read(path), /"name": "Busy 19"/);
  });

  test("a failed write keeps the change and never puts a stale one back", async () => {
    const { backend, library } = await setup();
    const path = await library.create("", emptyRandomizer("list", "Fragile"));
    const node = library.find(path)!;
    const named = (name: string) => ({ ...node.randomizer!, name });
    const original = backend.write.bind(backend);
    const errors: unknown[] = [];
    library.onError((e) => errors.push(e));

    // One write throws. The change must survive, saving must keep working,
    // and a later flush must put it on disk.
    let failOnce = true;
    backend.write = async (p, c) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("the disk is full");
      }
      await original(p, c);
    };
    library.save(path, named("One"));
    await assert.rejects(library.flush(), /the disk is full/);
    assert.equal(errors.length, 1, "the error listener should have run once");
    assert.ok(library.hasUnsavedChanges, "the failed change was dropped on the floor");
    await library.flush();
    assert.match(await backend.read(path), /"name": "One"/);
    assert.ok(!library.hasUnsavedChanges);

    // A slow write that fails while a second flush is already queued. The
    // failed text is older than what is waiting, so it must not go back into
    // the queue on top of it and be written afterwards.
    let releaseWrite = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let gateNext = true;
    backend.write = async (p, c) => {
      if (gateNext) {
        gateNext = false;
        await gate;
        throw new Error("the disk went away");
      }
      await original(p, c);
    };

    library.save(path, named("v1"));
    const a = library.flush().then(() => null, (e: unknown) => e);
    // Let A take its snapshot and park on the gate before v2 is typed.
    await new Promise((resolve) => setTimeout(resolve, 0));
    library.save(path, named("v2"));
    const b = library.flush().then(() => null, (e: unknown) => e);
    releaseWrite();
    assert.match(String(await a), /the disk went away/);
    assert.equal(await b, null, "the flush behind a failed one must still run");

    await library.flush();
    assert.match(await backend.read(path), /"name": "v2"/, "a stale write overwrote a newer one");
    assert.ok(!library.hasUnsavedChanges, "something stale is still queued");
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
    assert.equal(library.files().length, 1, "one bad file must not hide the rest of the library");
  });
});

describe("archives", () => {
  const entry = (path: string, name: string) => ({ path, text: serialize(wrap(emptyRandomizer("list", name))) });

  test("an archive written by the app reads back with the same files in the same folders", async () => {
    const entries = [
      { path: "D&D/Encounters/forest.orangey.json", text: serialize(wrap(emptyRandomizer("list", "Forest"))) },
      { path: "D&D/Treasure/coins.orangey.json", text: serialize(wrap(emptyRandomizer("dice", "Coins"))) },
      { path: "top.orangey.json", text: serialize(wrap(emptyRandomizer("coin", "Top"))) },
    ];
    const back = await readZip(await createZip(entries));
    assert.deepEqual(back, entries);
    for (const e of back) assert.ok(parseFile(e.text).file.randomizer.name, `${e.path} did not survive`);
    await assert.rejects(() => readZip(new TextEncoder().encode("hello")), /does not look like a ZIP/);
  });

  test("importing decides each colliding file on its own: replace, keep both, or skip", async () => {
    const { library } = await setup();
    const first = await library.importArchive(
      [entry("a.orangey.json", "Old A"), entry("b.orangey.json", "Old B"), entry("c.orangey.json", "Old C")],
      async () => "skip",
    );
    assert.deepEqual(first, { added: 3, replaced: 0, skipped: 0, failed: 0 });

    const answers: Record<string, "replace" | "keep-both" | "skip"> = {
      "a.orangey.json": "replace",
      "b.orangey.json": "keep-both",
      "c.orangey.json": "skip",
    };
    const again = await library.importArchive(
      [entry("a.orangey.json", "New A"), entry("b.orangey.json", "New B"), entry("c.orangey.json", "New C")],
      async (p) => answers[p],
    );
    assert.deepEqual(again, { added: 1, replaced: 1, skipped: 1, failed: 0 });
    assert.deepEqual(library.files().map((f) => f.randomizer!.name).sort(), ["New A", "New B", "Old B", "Old C"]);
  });

  test("an unreadable entry is counted, and the rest of the archive still arrives", async () => {
    const { library } = await setup();
    const result = await library.importArchive(
      [
        { path: "bad.orangey.json", text: "{nope" },
        entry("D&D/Encounters/forest.orangey.json", "Forest"),
        { path: "notes.txt", text: "ignored" },
      ],
      async () => "skip",
    );
    assert.deepEqual(result, { added: 1, replaced: 0, skipped: 0, failed: 1 });
    assert.deepEqual(library.files().map((f) => f.path), ["D&D/Encounters/forest.orangey.json"]);
  });
});
