import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { BOARD_LIMIT, canRoll, emptyRandomizer, isBoard, type BoardRandomizer } from "../../src/model/randomizer.ts";
import { parseFile, serialize, wrap } from "../../src/model/file.ts";
import { Check } from "../../src/model/validate.ts";
import { validateRandomizer } from "../../src/model/randomizer.ts";
import { rollRandomizer, whyCannotRoll } from "../../src/model/roll.ts";
import { SeededSource } from "../../src/core/rng.ts";
import { LibraryService } from "../../src/storage/library.ts";
import { MemoryBackend } from "../../src/storage/memory.ts";
import { boardBundle, missingOnBoards } from "../../src/ui/storage-actions.ts";
import { emptyRandomizer as anyRandomizer } from "../../src/model/randomizer.ts";
import { parseLibrary, serializeLibrary } from "../../src/storage/libraryfile.ts";

const board = (entries: { id: string; name: string }[]): BoardRandomizer => ({
  ...(emptyRandomizer("board", "Tonight's table") as BoardRandomizer),
  entries,
});

describe("a board", () => {
  test("is a file like any other, and survives a round trip", () => {
    const before = board([{ id: "enc", name: "Forest Encounters" }, { id: "d20", name: "Attack roll" }]);
    const after = parseFile(serialize(wrap(before))).file.randomizer;
    assert.deepEqual(after, before);
    assert.ok(isBoard(after));
  });

  test("refuses what would make it meaningless", () => {
    const cases: [string, unknown, string][] = [
      ["the same randomizer twice", board([{ id: "a", name: "A" }, { id: "a", name: "A" }]), "entries[1].id"],
      ["more than it can show", board(Array.from({ length: BOARD_LIMIT + 1 }, (_, i) => ({ id: `r${i}`, name: `R${i}` }))), "entries"],
      ["an entry with no id", { ...board([]), entries: [{ name: "No id" }] }, "entries[0].id"],
      ["entries that are not a list", { ...board([]), entries: "two" }, "entries"],
    ];
    for (const [what, value, path] of cases) {
      const check = new Check();
      validateRandomizer(value, check);
      assert.ok(!check.ok, `${what}: should have been refused`);
      assert.ok(check.issues.some((i) => i.path.endsWith(path)), `${what}: ${check.issues.map((i) => i.path).join(", ")}`);
    }
  });

  test("has nothing of its own to roll", () => {
    // The board screen rolls each randomizer on it separately, so each records its
    // own history row under its own name.
    assert.equal(canRoll(board([])), false);
    assert.equal(whyCannotRoll(board([])), "This board has nothing on it yet.");
    assert.equal(canRoll(board([{ id: "a", name: "A" }])), true);
    assert.equal(whyCannotRoll(board([{ id: "a", name: "A" }])), null);
    assert.throws(() => rollRandomizer(board([{ id: "a", name: "A" }]), new SeededSource("x")), /one randomizer at a time/);
  });
});

describe("sharing a board", () => {
  /** A library holding two randomizers and a board that points at both. */
  async function libraryWithBoard(): Promise<{ library: LibraryService; board: BoardRandomizer }> {
    const library = new LibraryService(new MemoryBackend(), 0);
    await library.refresh();
    const wheel = { ...anyRandomizer("list", "Encounters"), id: "enc" };
    const dice = { ...anyRandomizer("dice", "Attack roll"), id: "atk" };
    await library.create("", wheel);
    await library.create("Dice", dice);
    const board = { ...board2(), entries: [{ id: "enc", name: "Encounters" }, { id: "atk", name: "Attack roll" }] };
    await library.create("", board);
    await library.refresh();
    return { library, board };
  }
  const board2 = () => emptyRandomizer("board", "Tonight's table") as BoardRandomizer;

  test("packs itself and everything it points at, and names what it cannot find", async () => {
    const { library, board } = await libraryWithBoard();
    const packed = boardBundle(library, board);
    assert.equal(packed.missing.length, 0);
    assert.deepEqual(packed.entries.map((e) => e.path).sort(), [
      "Dice/attack-roll.orangey.json",
      "encounters.orangey.json",
      "tonight-s-table.orangey.json",
    ]);
    for (const entry of packed.entries) assert.equal(parseFile(entry.text).file.randomizer.name.length > 0, true);

    // A randomizer that has been deleted is reported rather than packed.
    await library.remove("Dice/attack-roll.orangey.json");
    const after = boardBundle(library, board);
    assert.deepEqual(after.missing, ["Attack roll"]);
    assert.equal(after.entries.length, 2);
    assert.deepEqual(missingOnBoards(library), [{ name: "Tonight's table", missing: ["Attack roll"] }]);
  });
});

describe("a board's bundle and installed packs", () => {
  test("leaves a pack's tables out and names the pack", async () => {
    const at = "2026-10-02T00:00:00.000Z";
    const list = (id: string, name: string, labels: string[]) => ({
      id, type: "list" as const, name, view: "wheel" as const, created: at, modified: at,
      items: labels.map((label, i) => ({ id: `${id}${i}`, label, weight: 1 })),
    });
    const library = new LibraryService(new MemoryBackend(), 5);
    await library.refresh();
    const text = serializeLibrary("Delve", at, [], [{ path: "theme.orangey.json", randomizer: list("theme", "Theme", ["Ancient"]) }],
      { id: "pack-delve", title: "Delve", author: "A. Writer", version: "1.0" });
    await library.installPack(parseLibrary(text), { source: "https://example.org/d.json" });
    await library.create("", list("mine", "Mine", ["x"]));
    const b = board([{ id: "mine", name: "Mine" }, { id: "theme", name: "Theme" }]);
    await library.create("", b);
    const bundle = boardBundle(library, b);
    assert.equal(bundle.entries.length, 2, "the board and Mine");
    assert.ok(!bundle.entries.some((e) => e.path.startsWith("Delve/")), "a pack table went into the bundle");
    assert.deepEqual(bundle.packs.map((p) => [p.id, p.source]), [["pack-delve", "https://example.org/d.json"]]);
    assert.deepEqual(library.installedPacks().map((p) => p.folder.path), ["Delve"]);
  });
});
