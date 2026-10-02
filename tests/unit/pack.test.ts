import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { LibraryService, LockedError } from "../../src/storage/library.ts";
import { MemoryBackend } from "../../src/storage/memory.ts";
import { emptyRandomizer, type BoardRandomizer, type ListRandomizer } from "../../src/model/randomizer.ts";
import { parseLibrary, planExport, serializeLibrary } from "../../src/storage/libraryfile.ts";
import { serialize, wrap } from "../../src/model/file.ts";
import {
  parsePackList, serializePackList,
  compareVersions, creditLine, nextVersion, PACK_FILE, parseManifestFile, readManifest, serializeManifest, snapshotsAllowed, type PackManifest,
} from "../../src/model/pack.ts";

function list(id: string, name: string, items: { label: string; goesTo?: string }[]): ListRandomizer {
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

const DELVE: PackManifest = { id: "pack-delve", title: "Delve Oracles", author: "A. Writer", version: "1.0", licence: "CC BY 4.0", homepage: "https://example.org/delve" };

/** A pack file as an author would publish it, from randomizers at paths inside the pack. */
function packText(pack: PackManifest, entries: { path: string; randomizer: ListRandomizer | BoardRandomizer }[], folders: string[] = []): string {
  return serializeLibrary(pack.title, "2026-10-02T00:00:00.000Z", folders, entries, pack);
}

const V1 = packText(DELVE, [
  { path: "Themes/theme.orangey.json", randomizer: list("theme", "Theme", [{ label: "Ancient", goesTo: "feature" }, { label: "Hallowed" }]) },
  { path: "feature.orangey.json", randomizer: list("feature", "Feature", [{ label: "Altar" }]) },
  { path: "old.orangey.json", randomizer: list("old", "Old Table", [{ label: "Gone soon" }]) },
  { path: "delve.orangey.json", randomizer: board("delve", "Delve", ["theme", "feature"]) },
], ["Themes"]);

describe("pack details", () => {
  test("are checked: who, what and which version are needed; the rest is optional", () => {
    assert.deepEqual(readManifest({ ...DELVE, extra: 1 }), DELVE);
    assert.throws(() => readManifest({ ...DELVE, author: "" }), /pack\.author: is needed/);
    assert.throws(() => readManifest({ ...DELVE, version: "v1" }), /numbers with dots/);
    assert.throws(() => readManifest({ ...DELVE, homepage: "javascript:alert(1)" }), /https:/);
    assert.equal(readManifest({ ...DELVE, allowSnapshots: false }).allowSnapshots, false);
    assert.equal(readManifest({ ...DELVE, allowSnapshots: true }).allowSnapshots, undefined, "the default is not written out");
  });

  test("versions compare number by number", () => {
    assert.equal(compareVersions("1.10", "1.9"), 1);
    assert.equal(compareVersions("1.2", "1.2.0"), 0);
    assert.equal(compareVersions("0.9", "1"), -1);
    assert.equal(nextVersion("1.9"), "1.10");
    assert.equal(nextVersion("rubbish"), "1.0");
  });

  test("give one line of credit, and say whether apps may keep a copy", () => {
    assert.equal(creditLine(DELVE), "Delve Oracles by A. Writer · v1.0 · CC BY 4.0");
    assert.equal(snapshotsAllowed(DELVE), true);
    assert.equal(snapshotsAllowed({ ...DELVE, allowSnapshots: false }), false);
  });

  test("travel in a library file, and an install's own notes never do", () => {
    const text = serializeLibrary("x", "now", [], [], { ...DELVE, installed: "2026-01-01", source: "https://x", ids: { a: "b" } } as PackManifest);
    assert.deepEqual(parseLibrary(text).pack, DELVE);
    assert.throws(() => parseLibrary(text.replace('"author": "A. Writer"', '"author": 3')), /library\.pack\.author/);
    assert.equal(parseLibrary(serializeLibrary("x", "now", [], [])).pack, undefined);
  });

  test("round-trip through orangey-pack.json", () => {
    assert.deepEqual(parseManifestFile(serializeManifest({ ...DELVE, installed: "2026-10-02" })), { ...DELVE, installed: "2026-10-02" });
    assert.throws(() => parseManifestFile("{}"), /orangey-pack/);
  });
});

describe("installing a pack", () => {
  test("lands in its own folder, keeps the ids and links, and is locked", async () => {
    const library = await setup();
    const { folder, added } = await library.installPack(parseLibrary(V1), { source: "https://example.org/delve.orangey-library.json" });
    assert.equal(folder, "Delve Oracles");
    assert.equal(added, 4);
    assert.equal(library.findById("theme")!.path, "Delve Oracles/Themes/theme.orangey.json");
    assert.equal((library.findById("theme")!.randomizer as ListRandomizer).items[0].goesTo, "feature");
    const found = library.packOf("Delve Oracles/Themes/theme.orangey.json")!;
    assert.equal(found.folder.path, "Delve Oracles");
    assert.equal(found.pack.source, "https://example.org/delve.orangey-library.json");
    assert.ok(found.pack.installed);
    assert.equal(library.findPack("pack-delve")!.path, "Delve Oracles");
    assert.equal(library.isLocked("Delve Oracles/feature.orangey.json"), true);
    assert.equal(library.isLocked("elsewhere"), false);
    // The details file is not a randomizer.
    assert.equal(library.files().length, 4);
  });

  test("nothing inside it can be changed by hand; the folder itself can be moved or removed", async () => {
    const library = await setup();
    await library.installPack(parseLibrary(V1));
    const p = "Delve Oracles/feature.orangey.json";
    assert.throws(() => library.save(p, list("feature", "Feature", [{ label: "Mine" }])), LockedError);
    await assert.rejects(library.rename(p, "Mine"), LockedError);
    await assert.rejects(library.move(p, ""), LockedError);
    await assert.rejects(library.duplicate(p), LockedError);
    await assert.rejects(library.remove(p), LockedError);
    await assert.rejects(library.create("Delve Oracles", list("x", "X", [])), LockedError);
    await assert.rejects(library.createFolder("Delve Oracles/Themes", "Mine"), LockedError);
    const mine = await library.create("", list("mine", "Mine", []));
    await assert.rejects(library.move(mine, "Delve Oracles"), LockedError);
    const moved = await library.rename("Delve Oracles", "Delve");
    assert.equal(library.findPack("pack-delve")!.path, moved);
    await library.remove(moved);
    assert.equal(library.findPack("pack-delve"), null);
  });

  test("an id already taken here gets a new one, and its links follow", async () => {
    const library = await setup();
    await library.create("", list("feature", "My own Feature", [{ label: "Mine" }]));
    await library.installPack(parseLibrary(V1));
    const pack = library.findPack("pack-delve")!.pack!;
    const local = pack.ids!.feature;
    assert.ok(local && local !== "feature");
    assert.equal(library.findById(local)!.path, "Delve Oracles/feature.orangey.json");
    assert.equal((library.findById("theme")!.randomizer as ListRandomizer).items[0].goesTo, local);
    assert.deepEqual((library.findById("delve")!.randomizer as BoardRandomizer).entries.map((e) => e.id), ["theme", local]);
    assert.equal(library.findById("feature")!.randomizer!.name, "My own Feature", "the user's own was touched");
  });

  test("installed twice under one title, the second gets a folder of its own", async () => {
    const library = await setup();
    await library.createFolder("", "Delve Oracles");
    const { folder } = await library.installPack(parseLibrary(V1));
    assert.equal(folder, "Delve Oracles 2");
  });
});

describe("updating a pack", () => {
  const V2 = packText({ ...DELVE, version: "1.1" }, [
    { path: "Themes/theme.orangey.json", randomizer: list("theme", "Theme", [{ label: "Ancient", goesTo: "feature" }, { label: "Hallowed" }, { label: "Wild" }]) },
    { path: "feature.orangey.json", randomizer: list("feature", "Feature", [{ label: "Altar" }, { label: "Pit" }]) },
    { path: "danger.orangey.json", randomizer: list("danger", "Danger", [{ label: "Trap" }]) },
  ], ["Themes"]);

  test("replaces the randomizers, keeps the ids they had here, and drops what the new version dropped", async () => {
    const library = await setup();
    await library.create("", list("feature", "My own Feature", []));
    await library.installPack(parseLibrary(V1), { source: "https://example.org/d.json" });
    const local = library.findPack("pack-delve")!.pack!.ids!.feature;
    const result = await library.updatePack("Delve Oracles", parseLibrary(V2));
    assert.deepEqual(result, { added: 1, removed: 2, kept: 2 });
    const pack = library.findPack("pack-delve")!.pack!;
    assert.equal(pack.version, "1.1");
    assert.equal(pack.source, "https://example.org/d.json", "the address to update from was forgotten");
    assert.equal(pack.ids!.feature, local, "the feature table moved to another id");
    assert.equal((library.findById(local)!.randomizer as ListRandomizer).items.length, 2);
    assert.equal((library.findById("theme")!.randomizer as ListRandomizer).items[0].goesTo, local);
    assert.equal(library.findById("old"), null);
    assert.equal(library.findById("delve"), null);
    assert.ok(library.findById("danger"));
  });

  test("refuses another pack, or a folder that was not installed", async () => {
    const library = await setup();
    await library.installPack(parseLibrary(V1));
    const other = parseLibrary(packText({ ...DELVE, id: "other" }, []));
    await assert.rejects(library.updatePack("Delve Oracles", other), /different pack/);
    await library.createFolder("", "Mine");
    await assert.rejects(library.updatePack("Mine", parseLibrary(V2)), /not an installed pack/);
  });
});

describe("an author's own pack folder", () => {
  test("keeps its details for the next version, and stays editable", async () => {
    const library = await setup();
    const folder = await library.createFolder("", "Delve");
    const theme = await library.create(folder, list("t", "Theme", [{ label: "Ancient" }]));
    await library.setPackDetails(folder, DELVE);
    assert.deepEqual(library.packOf(theme)!.pack, DELVE);
    assert.equal(library.isLocked(theme), false);
    await library.rename(theme, "Theme 2");
    // What goes in the pack file: the folder's contents, relative to it.
    const plan = planExport(library.files().map((n) => ({ path: n.path, randomizer: n.randomizer ?? undefined })), library.files(library.find(folder)!).map((n) => n.path), folder);
    assert.deepEqual(plan.entries.map((e) => e.path), ["theme-2.orangey.json"]);
    await assert.rejects(library.setPackDetails("", DELVE), /whole library/);
  });
});

describe("an editable copy of a pack", () => {
  test("has new ids with the links following, no pack details, and no lock", async () => {
    const library = await setup();
    await library.installPack(parseLibrary(V1));
    const copy = await library.copyPack("Delve Oracles");
    assert.equal(copy, "Delve Oracles (copy)");
    assert.equal(library.find(copy)!.pack, undefined);
    assert.equal(library.isLocked(`${copy}/feature.orangey.json`), false);
    const theme = library.find(`${copy}/Themes/theme.orangey.json`)!.randomizer as ListRandomizer;
    const feature = library.find(`${copy}/feature.orangey.json`)!.randomizer!;
    assert.notEqual(theme.id, "theme");
    assert.notEqual(feature.id, "feature");
    assert.equal(theme.items[0].goesTo, feature.id);
    assert.equal(library.files().length, 8);
    // The original is untouched.
    assert.equal(library.findById("theme")!.path, "Delve Oracles/Themes/theme.orangey.json");
    assert.equal(library.find(`Delve Oracles/${PACK_FILE}`), null, "the details file showed up as a randomizer");
  });
});

describe("exports leave installed packs out", () => {
  test("an export plan counts what it left out by pack, and keeps the links to it", async () => {
    const library = await setup();
    await library.installPack(parseLibrary(V1));
    const mine = await library.create("", list("mine", "Mine", [{ label: "Into the delve", goesTo: "theme" }]));
    const sources = library.files().map((n) => ({ path: n.path, randomizer: n.randomizer ?? undefined }));
    const plan = planExport(sources, [mine], "", (p) => (library.isLocked(p) ? library.packOf(p)!.pack.id : null));
    assert.deepEqual(plan.entries.map((e) => e.path), ["mine.orangey.json"]);
    assert.equal((plan.entries[0].randomizer as ListRandomizer).items[0].goesTo, "theme", "the link into the pack was dropped");
    // theme, then feature through theme's own link: both left out, counted once each.
    assert.deepEqual([...plan.leftOut], [["pack-delve", 1]]);
  });

  test("a library file names the packs it needs, and a bad entry in that list is dropped", () => {
    const needs = [{ ...DELVE, source: "https://example.org/delve.json" }];
    const text = serializeLibrary("x", "now", [], [], undefined, needs);
    assert.deepEqual(parseLibrary(text).needs, needs);
    const doc = JSON.parse(text);
    doc.needs.push({ title: "no id" }, { ...DELVE, id: "other", source: "javascript:alert(1)" });
    assert.deepEqual(parseLibrary(JSON.stringify(doc)).needs, [...needs, { ...DELVE, id: "other" }]);
    assert.deepEqual(parsePackList(serializePackList(needs)), needs);
    assert.deepEqual(parsePackList("not json"), []);
  });

  test("an old backup that still holds a pack's tables restores everything else, and leaves the pack alone", async () => {
    const library = await setup();
    await library.installPack(parseLibrary(V1));
    const at = "2026-10-02T00:00:00.000Z";
    const file = (r: ListRandomizer) => serialize(wrap({ ...r, created: at, modified: at }));
    const result = await library.importArchive([
      { path: "Delve Oracles/feature.orangey.json", text: file(list("feature", "Feature", [{ label: "Changed by hand" }])) },
      { path: "Delve Oracles/Themes/theme.orangey.json", text: file(list("theme", "Theme", [{ label: "Old" }])) },
      { path: "mine.orangey.json", text: file(list("mine", "Mine", [{ label: "Into the delve", goesTo: "feature" }])) },
    ], async () => "replace");
    assert.deepEqual(result, { added: 1, replaced: 0, skipped: 0, failed: 0, inPacks: 2 });
    assert.equal((library.findById("feature")!.randomizer as ListRandomizer).items[0].label, "Altar", "the pack was changed");
    assert.equal((library.findById("mine")!.randomizer as ListRandomizer).items[0].goesTo, "feature");
  });
});
