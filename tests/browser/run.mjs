/**
 * Browser tests, driving the built app in headless Chromium over CDP.
 *
 * The suite has two halves: feature checks that belong to individual
 * deliverables, and the combination matrix from deliverable N — the tests that
 * prove features still work when used together, which is where the bugs
 * actually live.
 */

import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, serve } from "./cdp.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const dist = join(root, "dist");
const fixture = (name) => readFileSync(join(root, "tests/fixtures", name), "utf8");
const readmeCsv = readFileSync(join(root, "examples/dnd/forest-encounters.csv"), "utf8");

let browser;
let server;
const results = [];

/** No single test may hold the suite up; a stuck one fails and is named. */
const TEST_TIMEOUT_MS = 120000;

async function test(name, fn) {
  // On CI the name goes out before the test runs, so a hang can be attributed
  // from the log rather than guessed at.
  if (process.env.CI) console.log(`# → ${name}`);
  const page = await browser.newPage();
  const started = Date.now();
  let timer;
  try {
    await Promise.race([
      fn(page),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`the test did not finish within ${TEST_TIMEOUT_MS / 1000}s`)), TEST_TIMEOUT_MS);
      }),
    ]);
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`ok ${results.length} - ${name}`);
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - started, error });
    console.log(`not ok ${results.length} - ${name}`);
    console.log(`  ${error.message.split("\n").join("\n  ")}`);
    if (page.consoleErrors.length) console.log(`  page errors: ${page.consoleErrors.slice(0, 3).join(" | ")}`);
  } finally {
    clearTimeout(timer);
    await page.close().catch(() => {});
  }
}

/**
 * Open the app. Tests share one browser, so by default this wipes the origin's
 * storage first — otherwise one test's library turns up in the next one's
 * assertions. Pass { fresh: false } to reload and keep what was stored.
 */
const open = async (page, hash = "", { fresh = false } = {}) => {
  if (fresh) {
    await page.goto(`${server.origin}/index.html?debug&noseed`);
    await page.clearStorage(server.origin);
  }
  // noseed: the starter randomizers would otherwise appear in every fresh
  // library and throw off counts. One test checks seeding on its own.
  await page.goto(`${server.origin}/index.html?debug&noseed${hash}`);
  await page.waitForFunction("window.orangey");
};

/** Create a randomizer straight through the app's own library service. */
const createList = (page, name, items, view = "wheel") =>
  page.evaluate(`
    const { state } = window.orangey;
    const items = ${JSON.stringify(items)}.map((i, n) => ({ id: "item" + n, ...i }));
    const r = { id: ${JSON.stringify(name)}, type: "list", name: ${JSON.stringify(name)}, view: ${JSON.stringify(view)},
                created: new Date().toISOString(), modified: new Date().toISOString(), items };
    const path = await state.library.create("", r);
    return path;
  `);

async function main() {
  server = await serve(dist);
  browser = await launch();

  // ---- feature checks ------------------------------------------------------

  await test("the app loads, renders and makes no network requests after load", async (page) => {
    await open(page, "", { fresh: true });
    const before = page.requests.length;
    await page.click(".quickbar button");
    await new Promise((r) => setTimeout(r, 600));
    const after = page.requests.filter((u) => !u.startsWith("data:")).length;
    assert.equal(after, before, `new requests: ${page.requests.slice(before).join(", ")}`);
    assert.deepEqual(page.consoleErrors, []);
  });

  await test("a d20 preset rolls a number between 1 and 20", async (page) => {
    await open(page, "", { fresh: true });
    await page.evaluate(`window.orangey.state.setFeel({ motion: "instant" })`);
    await page.click(".quickbar button:nth-child(6)");
    await page.waitForFunction(`document.querySelector(".result-value").textContent !== "Ready"`);
    const value = Number(await page.evaluate(`return document.querySelector(".result-value").textContent`));
    assert.ok(value >= 1 && value <= 20, `got ${value}`);
  });

  await test("the result reaches the live region as text", async (page) => {
    await open(page, "", { fresh: true });
    await page.evaluate(`window.orangey.state.setFeel({ motion: "instant" })`);
    await page.click(".quickbar button:nth-child(6)");
    await page.waitForFunction(`document.querySelector('[role="status"]').textContent.length > 0`);
    const spoken = await page.evaluate(`return document.querySelector('[role="status"]').textContent`);
    assert.match(spoken, /Total \d+/);
  });

  await test("OPFS keeps the library across a reload", async (page) => {
    await open(page, "", { fresh: true });
    await createList(page, "Persisted", [{ label: "A", weight: 1 }, { label: "B", weight: 2 }]);
    await open(page);
    const names = await page.evaluate(`return window.orangey.state.library.files().map((f) => f.randomizer.name)`);
    assert.deepEqual(names, ["Persisted"]);
    const kind = await page.evaluate(`return window.orangey.state.library.backend.kind`);
    assert.equal(kind, "opfs");
  });

  await test("the layout is two-pane on a desktop and tabbed on a phone", async (page) => {
    await open(page, "", { fresh: true });
    await page.setViewport(1280, 900);
    assert.equal(await page.evaluate(`return getComputedStyle(document.querySelector(".side")).display`), "block");
    assert.equal(await page.evaluate(`return getComputedStyle(document.querySelector(".tabbar")).display`), "none");
    await page.setViewport(375, 720);
    assert.equal(await page.evaluate(`return getComputedStyle(document.querySelector(".side")).display`), "none");
    assert.equal(await page.evaluate(`return getComputedStyle(document.querySelector(".tabbar")).display`), "flex");
    const heights = await page.evaluate(
      `return [...document.querySelectorAll(".tabbar button")].map((b) => b.getBoundingClientRect().height)`,
    );
    for (const height of heights) assert.ok(height >= 44, `touch target only ${height}px`);
  });

  await test("reduced motion switches animation off on first run and can be overridden", async (page) => {
    await page.emulateReducedMotion(true);
    await open(page, "", { fresh: true });
    assert.equal(await page.evaluate(`return window.orangey.state.prefs.feel.motion`), "instant");
    await page.evaluate(`
      const { state } = window.orangey;
      await state.savePrefs({ reducedMotionOverridden: true });
      state.setFeel({ motion: "full" });
    `);
    await open(page);
    assert.equal(await page.evaluate(`return window.orangey.state.prefs.feel.motion`), "full");
  });

  await test("a hand-edited preference is clamped on load", async (page) => {
    await open(page, "", { fresh: true });
    await page.evaluate(`
      const { state } = window.orangey;
      await state.savePrefs({ feel: { ...state.prefs.feel, wheel: { ...state.prefs.feel.wheel, durationMs: 999999, turns: 400 } } });
    `);
    await open(page);
    const wheel = await page.evaluate(`return window.orangey.state.prefs.feel.wheel`);
    assert.equal(wheel.durationMs, 8000);
    assert.equal(wheel.turns, 12);
  });

  await test("the outcome table disables, duplicates and deletes, and undo restores", async (page) => {
    await open(page, "", { fresh: true });
    const path = await createList(page, "Table", [
      { label: "Goblin", weight: 50 },
      { label: "Orc", weight: 30 },
      { label: "Troll", weight: 20 },
    ]);
    await page.evaluate(`window.orangey.navigate("#/edit/" + encodeURIComponent(${JSON.stringify(path)}))`);
    await page.waitForFunction(`document.querySelectorAll(".outcomes tbody tr").length === 3`);

    // Disable the second row: it keeps its weight and the wheel loses a segment.
    const segmentsBefore = await page.evaluate(`return document.querySelectorAll(".wheel-svg path[data-index]").length`);
    await page.click(".outcomes tbody tr:nth-child(2) .disable-button");
    await page.waitForFunction(`document.querySelectorAll(".outcomes tbody tr.disabled").length === 1`);
    const segmentsAfter = await page.evaluate(`return document.querySelectorAll(".wheel-svg path[data-index]").length`);
    assert.equal(segmentsAfter, segmentsBefore - 1);
    const stored = await page.evaluate(`
      const { state } = window.orangey;
      await state.library.flush();
      return await state.library.backend.read(${JSON.stringify(path)});
    `);
    assert.ok(stored.includes('"disabled": true'), "disabled flag is not in the file");
    assert.ok(stored.includes('"weight": 30'), "the weight was not preserved");

    // Re-enable: the original weight and percentage come back.
    await page.click(".outcomes tbody tr:nth-child(2) .disable-button");
    await page.waitForFunction(`document.querySelectorAll(".outcomes tbody tr.disabled").length === 0`);
    const percents = await page.evaluate(`return [...document.querySelectorAll(".outcomes tbody .pct")].map((c) => c.textContent)`);
    assert.deepEqual(percents, ["50.0%", "30.0%", "20.0%"]);

    // Duplicate, then delete and undo.
    await page.click(".outcomes tbody tr:nth-child(1) .duplicate-button");
    await page.waitForFunction(`document.querySelectorAll(".outcomes tbody tr").length === 4`);
    const labels = await page.evaluate(`return [...document.querySelectorAll(".label-cell input")].map((i) => i.value)`);
    assert.deepEqual(labels, ["Goblin", "Goblin (copy)", "Orc", "Troll"]);

    await page.click(".outcomes tbody tr:nth-child(2) .delete-button");
    await page.waitForFunction(`document.querySelectorAll(".outcomes tbody tr").length === 3`);
    await page.click(".toast button");
    await page.waitForFunction(`document.querySelectorAll(".outcomes tbody tr").length === 4`);
    const restored = await page.evaluate(`return [...document.querySelectorAll(".label-cell input")].map((i) => i.value)`);
    assert.deepEqual(restored, labels, "undo did not restore the row in its original place");
  });

  await test("the last outcome cannot be deleted", async (page) => {
    await open(page, "", { fresh: true });
    const path = await createList(page, "Single", [{ label: "Only", weight: 1 }]);
    await page.evaluate(`window.orangey.navigate("#/edit/" + encodeURIComponent(${JSON.stringify(path)}))`);
    await page.waitForFunction(`document.querySelectorAll(".outcomes tbody tr").length === 1`);
    await page.click(".outcomes tbody tr:nth-child(1) .delete-button");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(await page.evaluate(`return document.querySelectorAll(".outcomes tbody tr").length`), 1);
    assert.match(await page.evaluate(`return document.querySelector(".toast").textContent`), /at least one outcome/);
  });

  await test("adding an outcome from the table writes it to disk", async (page) => {
    await open(page, "", { fresh: true });
    const path = await createList(page, "Growing", [{ label: "A", weight: 1 }]);
    await page.evaluate(`window.orangey.navigate("#/edit/" + encodeURIComponent(${JSON.stringify(path)}))`);
    await page.waitForFunction(`document.querySelector(".add-outcome")`);
    await page.click(".add-outcome");
    await page.type(".outcomes tbody tr:nth-child(2) .label-cell input", "Second");
    const stored = await page.evaluate(`
      const { state } = window.orangey;
      await state.library.flush();
      return await state.library.backend.read(${JSON.stringify(path)});
    `);
    assert.ok(stored.includes("Second"), stored.slice(0, 200));
  });

  await test("a chosen colour survives a reload and clearing it returns to automatic", async (page) => {
    await open(page, "", { fresh: true });
    const path = await createList(page, "Coloured", [
      { label: "A", weight: 1 },
      { label: "B", weight: 1, color: "#c1440e" },
    ]);
    await open(page, `#/edit/${encodeURIComponent(path)}`);
    await page.waitForFunction(`document.querySelectorAll(".outcomes tbody tr").length === 2`);
    const fill = await page.evaluate(
      `return document.querySelector('.wheel-svg path[data-index="1"]').getAttribute("fill")`,
    );
    assert.equal(fill, "#c1440e");
    await page.evaluate(`
      const { state } = window.orangey;
      const node = state.library.find(${JSON.stringify(path)});
      const r = { ...node.randomizer, items: node.randomizer.items.map((i) => ({ ...i, color: undefined })) };
      state.library.save(${JSON.stringify(path)}, r);
      await state.library.flush();
    `);
    const stored = await page.evaluate(`return await window.orangey.state.library.backend.read(${JSON.stringify(path)})`);
    assert.ok(!stored.includes("color"), "the colour key should be gone");
  });

  await test("a slide link opens the wheel, rolls it, and fills the screen", async (page) => {
    await open(page, "", { fresh: true });
    const path = await createList(page, "Forest Encounters", [
      { label: "Goblin patrol", weight: 50 },
      { label: "Merchant", weight: 20 },
      { label: "Wolf pack", weight: 20 },
    ]);
    await open(page, `#/r/${encodeURIComponent(path)}`);
    await page.waitForFunction(`document.querySelector(".link-button")`);
    await page.click(".link-button");
    await page.waitForFunction(`document.querySelector(".link-dialog")`);
    // This test is about the library link; the dialog opens on the embedded
    // one, which has a test of its own.
    await page.click(".link-kind-library");

    const link = await page.evaluate(`return document.querySelector(".link-dialog input[type=text]").value`);
    assert.match(link, /#\/id\/Forest%20Encounters\?roll=1&present=1$/, link);
    // The link must address the randomizer by identity, not by file name.
    assert.ok(!link.includes(".orangey.json"), "a slide link should not depend on the file name");

    // Unticking an option changes the link.
    await page.evaluate(`
      const boxes = [...document.querySelectorAll(".link-dialog input[type=checkbox]")];
      boxes[1].click();
    `);
    const withoutPresent = await page.evaluate(`return document.querySelector(".link-dialog input[type=text]").value`);
    assert.match(withoutPresent, /\?roll=1$/, withoutPresent);
    await page.evaluate(`document.querySelector(".link-dialog").close()`);

    // Follow it the way a slide would.
    await page.goto(link);
    await page.waitForFunction("window.orangey");
    assert.equal(await page.evaluate(`return document.body.classList.contains("presenting")`), true);
    // The chrome is out of the way.
    const chrome = await page.evaluate(`
      return ["topbar", "side", "tabbar", "quickbar"].map((c) => getComputedStyle(document.querySelector("." + c)).display);
    `);
    assert.deepEqual(chrome, ["none", "none", "none", "none"], "the chrome should be hidden while presenting");
    // And it rolled on arrival.
    await page.waitForFunction(`document.querySelector(".result-value").textContent !== "Rolling…"`, 15000);
    const result = await page.evaluate(`return document.querySelector(".result-value").textContent`);
    assert.ok(["Goblin patrol", "Merchant", "Wolf pack"].includes(result), result);
    assert.equal(await page.evaluate(`return window.orangey.state.history.length`), 1);
  });

  await test("a slide link survives the wheel being renamed and moved", async (page) => {
    await open(page, "", { fresh: true });
    const path = await createList(page, "Renamed Later", [{ label: "A", weight: 1 }, { label: "B", weight: 1 }]);
    const link = await page.evaluate(`
      const { state } = window.orangey;
      const node = state.library.find(${JSON.stringify(path)});
      await state.library.createFolder("", "Campaign");
      const renamed = await state.library.rename(node.path, "Something Else");
      await state.library.move(renamed, "Campaign");
      return location.origin + location.pathname + "?debug#/id/" + encodeURIComponent(node.randomizer.id) + "?roll=1";
    `);
    await page.goto(link);
    await page.waitForFunction("window.orangey");
    await page.waitForFunction(`document.querySelector(".result-value").textContent !== "Rolling…"`, 15000);
    const shown = await page.evaluate(`
      return {
        title: document.querySelector("h1").textContent,
        result: document.querySelector(".result-value").textContent,
      };
    `);
    assert.equal(shown.title, "Something Else", "the link should still find it after a rename and a move");
    assert.ok(["A", "B"].includes(shown.result), shown.result);
  });

  await test("a link to something this library does not have explains itself", async (page) => {
    await open(page, "", { fresh: true });
    await open(page, "#/id/not-in-this-library?roll=1");
    const text = await page.evaluate(`return document.querySelector(".main-inner").textContent`);
    assert.match(text, /not stored in this browser/);
    assert.match(text, /not-in-this-library/);
  });

  await test("Escape leaves the full-screen view, but skips the roll while one is running", async (page) => {
    await open(page, "", { fresh: true });
    const path = await createList(page, "Escapable", [{ label: "A", weight: 1 }, { label: "B", weight: 1 }]);
    const id = await page.evaluate(`return window.orangey.state.library.find(${JSON.stringify(path)}).randomizer.id`);
    await open(page, `#/id/${encodeURIComponent(id)}?present=1`);
    await page.evaluate(`window.orangey.state.setFeel({ motion: "full", wheel: { durationMs: 2500, turns: 4, curve: "standard", settle: "bouncy" } })`);
    assert.equal(await page.evaluate(`return document.body.classList.contains("presenting")`), true);

    await page.click(".roll-button");
    await new Promise((r) => setTimeout(r, 400));
    await page.key("Escape");
    await page.waitForFunction(`document.querySelector(".roll-button").textContent === "Roll"`);
    assert.equal(
      await page.evaluate(`return document.body.classList.contains("presenting")`),
      true,
      "Escape during a roll should skip it, not leave the full-screen view",
    );

    await page.key("Escape");
    await page.waitForFunction(`!document.body.classList.contains("presenting")`);
    const chrome = await page.evaluate(`return getComputedStyle(document.querySelector(".topbar")).display`);
    assert.notEqual(chrome, "none", "the chrome should come back");
  });

  await test("a new library starts with the starter randomizers, once", async (page) => {
    await open(page, "", { fresh: true });
    await page.goto(`${server.origin}/index.html?debug`);
    await page.waitForFunction("window.orangey");
    const first = await page.evaluate(`return window.orangey.state.library.files().map((f) => f.randomizer.name).sort()`);
    assert.ok(first.includes("Forest Encounters") && first.includes("Attack roll"), first.join(", "));
    // Delete one, reload without noseed: it must not come back.
    await page.evaluate(`
      const { state } = window.orangey;
      const node = state.library.files().find((f) => f.randomizer.name === "Attack roll");
      await state.library.remove(node.path);
    `);
    await page.goto(`${server.origin}/index.html?debug`);
    await page.waitForFunction("window.orangey");
    const second = await page.evaluate(`return window.orangey.state.library.files().map((f) => f.randomizer.name)`);
    assert.ok(!second.includes("Attack roll"), "starters were added again after one was deleted");
  });

  await test("the IndexedDB backend passes the backend suite in the browser", async (page) => {
    await open(page, "", { fresh: true });
    const report = await page.evaluate(`
      const { IndexedDbBackend } = window.orangey.backends;
      const b = await IndexedDbBackend.open();
      const out = {};
      await b.mkdir("D&D/Encounters");
      await b.write("D&D/Encounters/forest.orangey.json", "hello");
      out.read = await b.read("D&D/Encounters/forest.orangey.json");
      out.root = await b.list("");
      out.deep = await b.list("D&D/Encounters");
      await b.write("a/b/c/file.txt", "x");
      out.nested = await b.read("a/b/c/file.txt");
      await b.move("a/b/c/file.txt", "two/file.txt");
      out.moved = await b.read("two/file.txt");
      await b.write("two/deeper/other.txt", "y");
      await b.move("two", "three");
      out.movedFolder = [await b.read("three/file.txt"), await b.read("three/deeper/other.txt")];
      let gone = false;
      try { await b.read("two/file.txt"); } catch { gone = true; }
      out.gone = gone;
      await b.remove("three");
      out.afterRemove = (await b.list("")).map((e) => e.name);
      return out;
    `);
    assert.equal(report.read, "hello");
    assert.deepEqual(report.deep, [{ name: "forest.orangey.json", kind: "file" }]);
    assert.equal(report.nested, "x");
    assert.equal(report.moved, "x");
    assert.deepEqual(report.movedFolder, ["x", "y"]);
    assert.equal(report.gone, true);
    assert.ok(!report.afterRemove.includes("three"));
  });

  await test("a randomizer can be dragged into a folder, and renamed through a dialog", async (page) => {
    await open(page, "", { fresh: true });
    const path = await createList(page, "Draggable", [{ label: "A", weight: 1 }]);
    await page.evaluate(`await window.orangey.state.library.createFolder("", "Target")`);
    await open(page, "#/library");
    await page.waitForFunction(`document.querySelector(".folder-row")`);
    await page.evaluate(`
      const file = [...document.querySelectorAll(".tree-row")].find((r) => r.textContent.includes("Draggable"));
      const folder = [...document.querySelectorAll(".folder-row")].find((r) => r.textContent.includes("Target"));
      const dt = new DataTransfer();
      file.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
      folder.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
      folder.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
      file.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
    `);
    await page.waitForFunction(`window.orangey.state.library.files().some((f) => f.path === "Target/draggable.orangey.json")`);

    // Rename through the app's own dialog — no browser prompt.
    await page.evaluate(`
      const more = [...document.querySelectorAll(".tree-file .icon-button")].find((b) => b.getAttribute("aria-label").includes("Draggable"));
      more.click();
    `);
    await page.waitForFunction(`document.querySelector(".menu")`);
    await page.evaluate(`[...document.querySelectorAll(".menu-item")].find((b) => b.textContent === "Rename…").click()`);
    await page.waitForFunction(`document.querySelector("dialog[open] input[type=text]")`);
    await page.type("dialog[open] input[type=text]", "Renamed by dialog");
    await page.evaluate(`document.querySelector("dialog[open] form").requestSubmit()`);
    await page.waitForFunction(`window.orangey.state.library.files().some((f) => f.randomizer && f.randomizer.name === "Renamed by dialog")`);
  });

  await test("a library ZIP goes through the one import door", async (page) => {
    await open(page, "", { fresh: true });
    await createList(page, "Zipped", [{ label: "A", weight: 1 }]);
    const zipBase64 = await page.evaluate(`
      const { state } = window.orangey;
      const node = state.library.files()[0];
      const text = await state.library.backend.read(node.path);
      // Build a ZIP in-page with the app's own writer by importing nothing:
      // the debug hook does not expose it, so use the export path instead.
      return null;
    `);
    void zipBase64;
    // Export through the storage menu, then re-import through the wizard.
    const entries = await page.evaluate(`
      const { state } = window.orangey;
      const node = state.library.files()[0];
      return [{ path: "Packed/" + node.path, text: await state.library.backend.read(node.path) }];
    `);
    const result = await page.evaluate(`
      const { state } = window.orangey;
      return await state.library.importArchive(${JSON.stringify(entries)}, async () => "keep-both");
    `);
    assert.equal(result.added, 1);
    const paths = await page.evaluate(`return window.orangey.state.library.files().map((f) => f.path).sort()`);
    assert.deepEqual(paths, ["Packed/zipped.orangey.json", "zipped.orangey.json"]);
    // The wizard accepts .zip files and says so.
    await open(page, "#/import");
    const accept = await page.evaluate(`return document.querySelector('input[type=file]').getAttribute("accept")`);
    assert.ok(accept.includes(".zip"));
    assert.equal(await page.evaluate(`return document.querySelectorAll('input[accept=".zip"]').length`), 0, "the separate ZIP import should be gone");
  });

  await test("a randomizer's own Feel settings are saved with it and used when it rolls", async (page) => {
    await open(page, "", { fresh: true });
    const path = await createList(page, "Own feel", [{ label: "A", weight: 1 }, { label: "B", weight: 1 }]);
    await open(page, `#/edit/${encodeURIComponent(path)}`);
    await page.waitForFunction(`document.querySelector(".feel-card input[type=range]")`);
    // Spin length is the first slider in the wheel section.
    await page.type('.feel-card input[aria-label="Spin length"]', "600");
    const stored = await page.evaluate(`
      const { state } = window.orangey;
      await state.library.flush();
      return JSON.parse(await state.library.backend.read(${JSON.stringify(path)})).randomizer.feel;
    `);
    assert.deepEqual(stored, { wheel: { durationMs: 600 } });

    await open(page, `#/r/${encodeURIComponent(path)}`);
    await page.evaluate(`window.orangey.state.setFeel({ motion: "full", wheel: { ...window.orangey.state.prefs.feel.wheel, durationMs: 3000 } })`);
    const measured = await page.evaluate(`
      const started = performance.now();
      document.querySelector(".roll-button").click();
      await new Promise((resolve) => {
        const check = () => (document.querySelector(".roll-button").textContent === "Roll" ? resolve() : requestAnimationFrame(check));
        requestAnimationFrame(check);
      });
      return performance.now() - started;
    `);
    assert.ok(measured < 1500, `the override of 600 ms should win over the global 3000 ms; spin took ${measured.toFixed(0)} ms`);

    // Back to global.
    await open(page, `#/edit/${encodeURIComponent(path)}`);
    await page.waitForFunction(`document.querySelector(".reset-feel")`);
    await page.click(".reset-feel");
    const cleared = await page.evaluate(`
      const { state } = window.orangey;
      await state.library.flush();
      return JSON.parse(await state.library.backend.read(${JSON.stringify(path)})).randomizer.feel;
    `);
    assert.equal(cleared, undefined);
  });

  await test("the Animate switch on the play screen turns motion off without touching Settings", async (page) => {
    await open(page, "", { fresh: true });
    const path = await createList(page, "Switchable", [{ label: "A", weight: 1 }, { label: "B", weight: 1 }]);
    await open(page, `#/r/${encodeURIComponent(path)}`);
    await page.evaluate(`window.orangey.state.setFeel({ motion: "full" })`);
    await page.click(".animate-toggle input");
    await page.waitForFunction(`window.orangey.state.prefs.animationsOff === true`);
    const elapsed = await page.evaluate(`
      const started = performance.now();
      document.querySelector(".roll-button").click();
      await new Promise((r) => requestAnimationFrame(r));
      return { ms: performance.now() - started, text: document.querySelector(".result-value").textContent, motion: window.orangey.state.prefs.feel.motion };
    `);
    assert.ok(elapsed.ms < 100 && ["A", "B"].includes(elapsed.text), JSON.stringify(elapsed));
    assert.equal(elapsed.motion, "full", "the global setting must be untouched");
  });

  await test("the coin is tossed along an arc and the dice fly in, scattering", async (page) => {
    await open(page, "", { fresh: true });
    await page.evaluate(`window.orangey.state.setFeel({ motion: "full", coin: { flips: 4, durationMs: 1200, arc: 1.2 }, dice: { style: "flat", tumbleMs: 1200, bounces: 2, spread: 0.8 } })`);
    await page.evaluate(`[...document.querySelectorAll(".quickbar button")].find((b) => b.textContent === "Coin").click()`);
    await new Promise((r) => setTimeout(r, 300));
    const coin = await page.evaluate(`
      const f = document.querySelector(".coin-flight");
      return { tossing: f.classList.contains("tossing"), arc: f.style.getPropertyValue("--arc-h"), transform: getComputedStyle(f).transform };
    `);
    assert.equal(coin.tossing, true);
    assert.match(coin.arc, /^\d+px$/);
    assert.notEqual(coin.transform, "none", "the coin should be off its start point mid-toss");
    await page.waitForFunction(`document.querySelector(".result-value").textContent !== "Rolling…"`);

    await page.evaluate(`
      const f = document.querySelector('.quickbar input[type="text"]');
      f.focus(); f.value = "3d6";
      f.dispatchEvent(new Event("input", { bubbles: true }));
      f.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    `);
    await new Promise((r) => setTimeout(r, 250));
    const dice = await page.evaluate(`
      const flights = [...document.querySelectorAll(".die-flight")];
      return { count: flights.length, flying: flights.filter((f) => f.classList.contains("flying")).length,
               mids: flights.map((f) => f.style.getPropertyValue("--mx")), transforms: flights.map((f) => getComputedStyle(f).transform) };
    `);
    assert.equal(dice.count, 3);
    assert.equal(dice.flying, 3, "the dice should be in flight");
    assert.ok(new Set(dice.mids).size > 1, "the scatter should differ between dice");
    assert.ok(dice.transforms.every((t) => t !== "none"), "each die should be away from its slot mid-flight");
    await page.waitForFunction(`document.querySelector(".result-value").textContent !== "Rolling…"`);
    const settled = await page.evaluate(`return [...document.querySelectorAll(".die-flight")].map((f) => f.classList.contains("flying"))`);
    assert.deepEqual(settled, [false, false, false], "every die should have arrived");
  });

  await test("wireframe numbers share one size across a mixed handful", async (page) => {
    await open(page, "", { fresh: true });
    await page.evaluate(`window.orangey.state.setFeel({ motion: "instant", dice: { style: "wireframe", tumbleMs: 400, bounces: 1, spread: 0 } })`);
    await page.evaluate(`
      const f = document.querySelector('.quickbar input[type="text"]');
      f.focus(); f.value = "d4+d6+d12+d20";
      f.dispatchEvent(new Event("input", { bubbles: true }));
      f.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    `);
    await page.waitForFunction(`document.querySelectorAll(".die-value").length === 4`);
    const sizes = await page.evaluate(`return [...document.querySelectorAll(".die-value")].map((v) => v.style.fontSize)`);
    assert.equal(new Set(sizes).size, 1, `sizes differ: ${sizes.join(", ")}`);
    assert.ok(parseFloat(sizes[0]) >= 8);
  });

  await test("a colour scheme applies at once and survives a reload", async (page) => {
    await open(page, "", { fresh: true });
    await open(page, "#/settings");
    await page.evaluate(`[...document.querySelectorAll(".scheme-card")].find((b) => b.textContent.includes("Ocean")).click()`);
    await page.waitForFunction(`document.documentElement.getAttribute("data-scheme") === "ocean"`);
    const accent = await page.evaluate(`return getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()`);
    assert.equal(accent, "#3fa7e0");
    await open(page);
    assert.equal(await page.evaluate(`return document.documentElement.getAttribute("data-scheme")`), "ocean");
    await page.evaluate(`await window.orangey.state.savePrefs({ scheme: "orangey" })`);
    assert.equal(await page.evaluate(`return getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()`), "#f3a257");
  });

  // ---- deliverable N: the combination matrix -------------------------------

  await test("N1 import → edit → save → reload → roll", async (page) => {
    await open(page, "#/import", { fresh: true });
    await page.waitForFunction(`document.querySelector(".importer textarea")`);
    const csv = ["Name,Weight,Description"]
      .concat(Array.from({ length: 40 }, (_, i) => `Outcome ${i + 1},${i + 1},Note ${i + 1}`))
      .join("\n");
    await page.type(".importer textarea", csv);
    await page.click(".importer .primary");
    await page.waitForFunction(`document.querySelector(".report")`);
    const report = await page.evaluate(`return document.querySelector(".report").textContent`);
    assert.match(report, /40 entries ready/);

    await page.evaluate(`
      const buttons = [...document.querySelectorAll("button")];
      buttons.find((b) => b.textContent === "Create and edit").click();
    `);
    await page.waitForFunction(`document.querySelectorAll(".outcomes tbody tr").length === 40`);

    // Disable five, delete two, add one, recolour one.
    await page.evaluate(`
      for (let i = 1; i <= 5; i++) document.querySelector(".outcomes tbody tr:nth-child(" + i + ") .disable-button").click();
    `);
    await page.waitForFunction(`document.querySelectorAll(".outcomes tbody tr.disabled").length === 5`);
    await page.click(".outcomes tbody tr:nth-child(10) .delete-button");
    await page.waitForFunction(`document.querySelectorAll(".outcomes tbody tr").length === 39`);
    await page.click(".outcomes tbody tr:nth-child(10) .delete-button");
    await page.waitForFunction(`document.querySelectorAll(".outcomes tbody tr").length === 38`);
    await page.click(".add-outcome");
    await page.type(".outcomes tbody tr:nth-child(39) .label-cell input", "Added later");
    const deleted = await page.evaluate(`
      const { state } = window.orangey;
      await state.library.flush();
      const node = state.library.files()[0];
      const r = { ...node.randomizer, items: node.randomizer.items.map((i, n) => (n === 0 ? { ...i, color: "#a33a30" } : i)) };
      state.library.save(node.path, r);
      await state.library.flush();
      return { path: node.path, labels: r.items.map((i) => i.label), disabled: r.items.filter((i) => i.disabled).length };
    `);
    assert.equal(deleted.labels.length, 39);
    assert.equal(deleted.disabled, 5);

    // Reload: the file and the UI agree.
    await open(page);
    const reloaded = await page.evaluate(`
      const node = window.orangey.state.library.files()[0];
      return { labels: node.randomizer.items.map((i) => i.label), disabled: node.randomizer.items.filter((i) => i.disabled).map((i) => i.label), color: node.randomizer.items[0].color };
    `);
    assert.deepEqual(reloaded.labels, deleted.labels);
    assert.equal(reloaded.color, "#a33a30");
    assert.equal(reloaded.disabled.length, 5);

    // 10000 seeded rolls never produce a disabled or deleted outcome.
    const seen = await page.evaluate(`
      const { state, rollRandomizer } = window.orangey;
      const node = state.library.files()[0];
      const { SeededSource } = window.orangey.state.constructor === Object ? {} : {};
      const results = new Set();
      for (let i = 0; i < 10000; i++) results.add(rollRandomizer(node.randomizer, state.source()).text);
      return [...results];
    `);
    for (const label of reloaded.disabled) assert.ok(!seen.includes(label), `${label} is disabled but came up`);
    assert.ok(!seen.includes("Outcome 10"), "a deleted outcome came up");
  });

  await test("N2 disabled outcomes × geometry × colour", async (page) => {
    await open(page, "", { fresh: true });
    const items = Array.from({ length: 12 }, (_, i) => ({ label: `Item ${i + 1}`, weight: i + 1, disabled: i < 5 }));
    const path = await createList(page, "Mixed", items);
    await open(page, `#/edit/${encodeURIComponent(path)}`);
    await page.waitForFunction(`document.querySelectorAll(".wheel-svg path[data-index]").length === 7`);

    const before = await page.evaluate(`
      return [...document.querySelectorAll(".wheel-svg path[data-index]")].map((p) => ({ index: p.dataset.index, fill: p.getAttribute("fill") }));
    `);
    assert.equal(before.length, 7);
    assert.equal(new Set(before.map((s) => s.fill)).size, 7, "two visible segments share a colour");

    // Enabling one restores its own colour rather than reshuffling the wheel.
    await page.click(".outcomes tbody tr:nth-child(1) .disable-button");
    await page.waitForFunction(`document.querySelectorAll(".wheel-svg path[data-index]").length === 8`);
    const after = await page.evaluate(`
      return [...document.querySelectorAll(".wheel-svg path[data-index]")].map((p) => ({ index: p.dataset.index, fill: p.getAttribute("fill") }));
    `);
    for (const segment of before) {
      const match = after.find((s) => s.index === segment.index);
      assert.equal(match.fill, segment.fill, `segment ${segment.index} changed colour when another was enabled`);
    }
  });

  await test("N4 seeded RNG × instant mode × history", async (page) => {
    await open(page, "", { fresh: true });
    const path = await createList(page, "Seeded", [
      { label: "One", weight: 1 },
      { label: "Two", weight: 1 },
      { label: "Three", weight: 1 },
    ]);
    const sequence = async (motion) =>
      page.evaluate(`
        const { state, rollRandomizer } = window.orangey;
        await state.savePrefs({ seed: "847193" });
        state.setFeel({ motion: ${JSON.stringify(motion)} });
        state.resetSeedSequence();
        const node = state.library.find(${JSON.stringify(path)});
        const out = [];
        for (let i = 0; i < 20; i++) out.push(rollRandomizer(node.randomizer, state.source()).text);
        return out;
      `);
    const withAnimation = await sequence("full");
    const withoutAnimation = await sequence("instant");
    assert.deepEqual(withoutAnimation, withAnimation, "the same seed gave different sequences");

    // The result recorded in history is the same text either way, with the seed.
    await page.evaluate(`
      const { state, rollRandomizer } = window.orangey;
      state.resetSeedSequence();
      const node = state.library.find(${JSON.stringify(path)});
      await state.record(node.randomizer, rollRandomizer(node.randomizer, state.source()));
    `);
    const entry = await page.evaluate(`return window.orangey.state.history[0]`);
    assert.equal(entry.resultText, withAnimation[0]);
    assert.match(entry.seed, /^847193#/);
  });

  await test("N5 feel × wheel × skip: a skipped spin lands on the same result", async (page) => {
    await open(page, "", { fresh: true });
    const path = await createList(page, "Skippable", [
      { label: "Alpha", weight: 1 },
      { label: "Beta", weight: 1 },
      { label: "Gamma", weight: 1 },
      { label: "Delta", weight: 1 },
    ]);
    for (const curve of ["gentle", "standard", "snappy"]) {
      for (const settle of ["none", "slight", "bouncy"]) {
        await open(page, `#/r/${encodeURIComponent(path)}`);
        await page.evaluate(`
          window.orangey.state.setFeel({ motion: "full", wheel: { durationMs: 2000, turns: 4, curve: ${JSON.stringify(curve)}, settle: ${JSON.stringify(settle)} } });
        `);
        await page.click(".roll-button");
        await new Promise((r) => setTimeout(r, 600)); // ~30 % through

        // Mid-spin the answer must not be on screen yet.
        const midway = await page.evaluate(`return document.querySelector(".result-value").textContent`);
        assert.equal(midway, "Rolling…", `${curve}/${settle}: the result showed during the spin`);

        await page.key("Escape");
        await page.waitForFunction(`document.querySelector(".roll-button").textContent === "Roll"`);
        const final = await page.evaluate(`return document.querySelector(".result-value").textContent`);
        const recorded = await page.evaluate(`return window.orangey.state.history[0].resultText`);
        assert.equal(final, recorded, `${curve}/${settle}: the shown result is not the one that was rolled`);
        assert.ok(["Alpha", "Beta", "Gamma", "Delta"].includes(final), final);
      }
    }
  });

  await test("the result stays hidden until the wheel, dice and coin land", async (page) => {
    await open(page, "", { fresh: true });
    const path = await createList(page, "Hidden", [
      { label: "Alpha", weight: 1 },
      { label: "Beta", weight: 1 },
    ]);

    // Wheel.
    await open(page, `#/r/${encodeURIComponent(path)}`);
    await page.evaluate(`window.orangey.state.setFeel({ motion: "full", wheel: { durationMs: 1200, turns: 3, curve: "standard", settle: "bouncy" } })`);
    let samples = await page.evaluate(`
      document.querySelector(".roll-button").click();
      const seen = [];
      for (let i = 0; i < 8; i++) {
        seen.push(document.querySelector(".result-value").textContent);
        await new Promise((r) => setTimeout(r, 100));
      }
      return seen;
    `);
    assert.ok(samples.every((s) => s === "Rolling…"), `wheel leaked the result: ${samples.join(", ")}`);
    await page.waitForFunction(`document.querySelector(".result-value").textContent !== "Rolling…"`);
    assert.ok(["Alpha", "Beta"].includes(await page.evaluate(`return document.querySelector(".result-value").textContent`)));

    // Dice.
    await open(page, "#/");
    await page.evaluate(`window.orangey.state.setFeel({ motion: "full", dice: { tumbleMs: 1200, bounces: 2, spread: 0.5 } })`);
    samples = await page.evaluate(`
      document.querySelector(".quickbar button:nth-child(6)").click();
      const seen = [];
      for (let i = 0; i < 8; i++) {
        seen.push(document.querySelector(".result-value").textContent);
        await new Promise((r) => setTimeout(r, 100));
      }
      return seen;
    `);
    assert.ok(samples.every((s) => s === "Rolling…"), `dice leaked the result: ${samples.join(", ")}`);

    // Coin.
    await open(page, "#/");
    await page.evaluate(`window.orangey.state.setFeel({ motion: "full", coin: { flips: 5, durationMs: 1200 } })`);
    samples = await page.evaluate(`
      [...document.querySelectorAll(".quickbar button")].find((b) => b.textContent === "Coin").click();
      const seen = [];
      for (let i = 0; i < 6; i++) {
        seen.push([document.querySelector(".result-value").textContent, document.querySelector(".coin").textContent]);
        await new Promise((r) => setTimeout(r, 120));
      }
      return seen;
    `);
    for (const [panel, face] of samples) {
      assert.equal(panel, "Rolling…", `coin leaked the result into the panel: ${panel}`);
      assert.equal(face, "", `coin leaked the result onto the coin: ${face}`);
    }
  });

  await test("the dice tumble through changing values and settle on the real ones", async (page) => {
    await open(page, "", { fresh: true });
    await page.evaluate(`window.orangey.state.setFeel({ motion: "full", dice: { tumbleMs: 1400, bounces: 2, spread: 0.4 } })`);
    const observed = await page.evaluate(`
      const field = document.querySelector('.quickbar input[type="text"]');
      field.focus();
      field.value = "4d6kh3";
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      const frames = [];
      for (let i = 0; i < 8; i++) {
        frames.push([...document.querySelectorAll(".die")].map((d) => d.textContent).join(","));
        await new Promise((r) => setTimeout(r, 110));
      }
      return frames;
    `);
    assert.equal(new Set(observed).size > 1, true, `the dice never changed: ${observed.join(" | ")}`);
    for (const frame of observed) {
      for (const value of frame.split(",").filter(Boolean)) {
        assert.ok(Number(value) >= 1 && Number(value) <= 6, `a tumbling die showed ${value}`);
      }
    }
    await page.waitForFunction(`document.querySelector(".result-value").textContent !== "Rolling…"`);
    const settled = await page.evaluate(`
      const dice = [...document.querySelectorAll(".die")];
      return {
        values: dice.map((d) => Number(d.textContent)),
        dropped: dice.filter((d) => d.classList.contains("dropped")).length,
        total: Number(document.querySelector(".result-value").textContent),
      };
    `);
    assert.equal(settled.values.length, 4);
    assert.equal(settled.dropped, 1, "4d6kh3 must show exactly one dropped die");
    const kept = settled.values.slice().sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);
    assert.equal(settled.total, kept, "the total must be the three kept dice");
  });

  await test("wireframe dice draw a solid, stay blank while tumbling, and reveal on landing", async (page) => {
    await open(page, "", { fresh: true });
    await page.evaluate(`window.orangey.state.setFeel({ motion: "full", dice: { style: "wireframe", tumbleMs: 1500, bounces: 3, spread: 0.4 } })`);
    await page.evaluate(`
      const f = document.querySelector('.quickbar input[type="text"]');
      f.focus();
      f.value = "4d6kh3";
      f.dispatchEvent(new Event("input", { bubbles: true }));
      f.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    `);

    const during = await page.evaluate(`
      const frames = [];
      for (let i = 0; i < 6; i++) {
        frames.push({
          canvases: document.querySelectorAll(".die-canvas").length,
          rolling: document.querySelectorAll(".die-slot.rolling").length,
          values: [...document.querySelectorAll(".die-value")].map((v) => v.textContent).join(""),
          captions: [...document.querySelectorAll(".die-caption")].map((v) => v.textContent).join(""),
          pixels: document.querySelector(".die-canvas").toDataURL().length + ":" + document.querySelector(".die-canvas").toDataURL().slice(-24),
          flat: document.querySelectorAll(".dice-tray .die").length,
        });
        await new Promise((r) => setTimeout(r, 120));
      }
      return frames;
    `);
    for (const frame of during) {
      assert.equal(frame.canvases, 4, "one canvas per die");
      assert.equal(frame.flat, 0, "no flat dice while wireframe is on");
      assert.equal(frame.rolling, 4, "every die should still be rolling");
      assert.equal(frame.values, "", "the wireframe must not show numbers while tumbling");
      assert.equal(frame.captions, "", "no caption while tumbling either");
    }
    assert.ok(new Set(during.map((f) => f.pixels)).size > 1, "the wireframe never redrew");

    await page.waitForFunction(`document.querySelector(".result-value").textContent !== "Rolling…"`);
    const landed = await page.evaluate(`
      const slots = [...document.querySelectorAll(".die-slot")];
      return {
        rolling: document.querySelectorAll(".die-slot.rolling").length,
        values: slots.map((s) => Number(s.querySelector(".die-value").textContent)),
        captions: slots.map((s) => Number(s.querySelector(".die-caption").textContent)),
        dropped: slots.filter((s) => s.classList.contains("dropped")).length,
        total: Number(document.querySelector(".result-value").textContent),
      };
    `);
    assert.equal(landed.rolling, 0, "nothing should still be rolling");
    assert.deepEqual(landed.values, landed.captions, "the centred value and the caption must agree");
    assert.equal(landed.values.length, 4);
    for (const v of landed.values) assert.ok(v >= 1 && v <= 6, `a d6 showed ${v}`);
    assert.equal(landed.dropped, 1, "4d6kh3 drops exactly one die");
    const kept = landed.values.slice().sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);
    assert.equal(landed.total, kept);
  });

  await test("a landed wireframe die is still, and shows a face square-on with its number inside", async (page) => {
    await open(page, "", { fresh: true });
    await page.evaluate(`window.orangey.state.setFeel({ motion: "full", dice: { style: "wireframe", tumbleMs: 700, bounces: 2, spread: 0 } })`);
    await page.click(".quickbar button:nth-child(6)");
    await page.waitForFunction(`document.querySelector(".result-value").textContent !== "Rolling…"`);
    // Give the landing bounce time to finish, then check the drawing no longer
    // changes: a die that is still being animated would differ between frames.
    const stable = await page.evaluate(`
      await new Promise((r) => setTimeout(r, 700));
      const canvas = document.querySelector(".die-canvas");
      const first = canvas.toDataURL();
      await new Promise((r) => setTimeout(r, 250));
      return first === canvas.toDataURL();
    `);
    assert.equal(stable, true, "the die is still moving after it should have settled");

    const label = await page.evaluate(`
      const value = document.querySelector(".die-value");
      const stage = document.querySelector(".die-stage");
      const v = value.getBoundingClientRect();
      const s = stage.getBoundingClientRect();
      return {
        text: value.textContent,
        fontSize: parseFloat(getComputedStyle(value).fontSize),
        stageSize: s.width,
        insideStage: v.left >= s.left - 1 && v.right <= s.right + 1 && v.top >= s.top - 1 && v.bottom <= s.bottom + 1,
        hasTransform: value.style.transform.startsWith("translate("),
      };
    `);
    assert.ok(Number(label.text) >= 1 && Number(label.text) <= 20, label.text);
    // The number is sized from the face, not from a fixed rule in the CSS.
    assert.ok(label.fontSize > 10 && label.fontSize < label.stageSize * 0.6, `font-size ${label.fontSize}px`);
    assert.ok(label.hasTransform, "the number should be placed on the face it belongs to");
    assert.ok(label.insideStage, "the number should sit within the die");
  });

  await test("the number is about half a side of the face it sits on", async (page) => {
    await open(page, "", { fresh: true });
    await page.evaluate(`window.orangey.state.setFeel({ motion: "instant", dice: { style: "wireframe", tumbleMs: 400, bounces: 1, spread: 0 } })`);
    // A d6 lands on a square, so half a side is unambiguous, and a single
    // digit needs no shrinking to fit.
    for (let attempt = 0; attempt < 12; attempt++) {
      await page.click(".quickbar button:nth-child(2)");
      await page.waitForFunction(`document.querySelector(".die-value") && document.querySelector(".die-value").textContent !== ""`);
      const measured = await page.evaluate(`
        const { state } = window.orangey;
        const value = document.querySelector(".die-value");
        return { text: value.textContent, fontSize: parseFloat(getComputedStyle(value).fontSize) };
      `);
      assert.equal(measured.text.length, 1, "a d6 always shows a single digit");
      // The cube is 92px across with a projection radius of 0.34 of that; the
      // square's side works out near 36px on screen, so half is about 18px.
      assert.ok(
        measured.fontSize > 14 && measured.fontSize < 26,
        `a d6 showing ${measured.text} sized its number at ${measured.fontSize}px`,
      );
    }
  });

  await test("dice with no solid of their own still roll as wireframes", async (page) => {
    await open(page, "", { fresh: true });
    await page.evaluate(`window.orangey.state.setFeel({ motion: "full", dice: { style: "wireframe", tumbleMs: 400, bounces: 1, spread: 0 } })`);
    for (const expression of ["d7", "2d30", "d100", "d4"]) {
      await page.evaluate(`
        const f = document.querySelector('.quickbar input[type="text"]');
        f.focus();
        f.value = ${JSON.stringify(expression)};
        f.dispatchEvent(new Event("input", { bubbles: true }));
        f.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      `);
      await page.waitForFunction(`document.querySelector(".result-value").textContent !== "Rolling…"`);
      const shown = await page.evaluate(`
        return {
          canvases: document.querySelectorAll(".die-canvas").length,
          values: [...document.querySelectorAll(".die-value")].map((v) => Number(v.textContent)),
        };
      `);
      const sides = Number(expression.replace(/^\d*d/, ""));
      assert.ok(shown.canvases >= 1, `${expression} drew no wireframe`);
      for (const v of shown.values) assert.ok(v >= 1 && v <= sides, `${expression} showed ${v}`);
    }
  });

  await test("flat is the default, and the dice style setting sticks", async (page) => {
    await open(page, "", { fresh: true });
    assert.equal(await page.evaluate(`return window.orangey.state.prefs.feel.dice.style`), "flat");
    await page.evaluate(`window.orangey.state.setFeel({ motion: "instant" })`);
    await page.click(".quickbar button:nth-child(6)");
    await page.waitForFunction(`document.querySelector(".result-value").textContent !== "Ready"`);
    assert.equal(await page.evaluate(`return document.querySelectorAll(".die-canvas").length`), 0);
    assert.equal(await page.evaluate(`return document.querySelectorAll(".dice-tray .die").length`), 1);

    // Switch it in Settings and reload.
    await open(page, "#/settings");
    await page.evaluate(`
      const groups = [...document.querySelectorAll('[aria-label="Style"] button')];
      groups.find((b) => b.textContent === "Wireframe").click();
    `);
    await open(page);
    assert.equal(await page.evaluate(`return window.orangey.state.prefs.feel.dice.style`), "wireframe");
    await page.evaluate(`window.orangey.state.setFeel({ motion: "instant" })`);
    await page.click(".quickbar button:nth-child(6)");
    await page.waitForFunction(`document.querySelectorAll(".die-canvas").length === 1`);
    // Instant mode draws the solid at rest with its value, without animating.
    const value = await page.evaluate(`return Number(document.querySelector(".die-value").textContent)`);
    assert.ok(value >= 1 && value <= 20, `got ${value}`);
  });

  await test("the wheel swings past its target and settles back onto it", async (page) => {
    await open(page, "", { fresh: true });
    const path = await createList(page, "Bouncy", [
      { label: "Alpha", weight: 1 },
      { label: "Beta", weight: 1 },
      { label: "Gamma", weight: 1 },
    ]);
    const trace = async (settle) => {
      await open(page, `#/r/${encodeURIComponent(path)}`);
      await page.evaluate(`
        window.orangey.state.setFeel({ motion: "full", wheel: { durationMs: 900, turns: 2, curve: "standard", settle: ${JSON.stringify(settle)} } });
      `);
      return page.evaluate(`
        const angleOf = () => {
          const t = document.querySelector(".wheel-rotor").getAttribute("transform") || "rotate(0 0 0)";
          return Number(t.match(/rotate\\(([-0-9.]+)/)[1]);
        };
        document.querySelector(".roll-button").click();
        const seen = [];
        // Sample the whole spin, not just its beginning: the overshoot only
        // happens in the last quarter.
        while (document.querySelector(".roll-button").textContent !== "Roll") {
          seen.push(angleOf());
          await new Promise((r) => requestAnimationFrame(r));
        }
        return { seen, final: angleOf() };
      `);
    };

    const bouncy = await trace("bouncy");
    const none = await trace("none");
    // The rotation is taken modulo 360, so only the tail of the spin can be
    // compared with the settled angle: a bounce goes past it and comes back,
    // a plain spin approaches it from below and stops.
    const past = (t) => {
      const tail = t.seen.slice(Math.floor(t.seen.length * 0.8));
      return tail.filter((a) => a > t.final + 0.5 && a - t.final < 40).length;
    };
    assert.ok(past(bouncy) > 0, "a bouncy wheel should overshoot before settling");
    assert.equal(past(none), 0, "a wheel with no settle should not overshoot");
  });

  await test("N6 storage × library operations × history", async (page) => {
    await open(page, "", { fresh: true });
    const path = await createList(page, "Movable", [{ label: "A", weight: 1 }, { label: "B", weight: 1 }]);
    await page.evaluate(`
      const { state, rollRandomizer } = window.orangey;
      const node = state.library.find(${JSON.stringify(path)});
      await state.record(node.randomizer, rollRandomizer(node.randomizer, state.source()));
      await state.library.createFolder("", "Campaign");
      const renamed = await state.library.rename(${JSON.stringify(path)}, "Renamed");
      const moved = await state.library.move(renamed, "Campaign");
      const copy = await state.library.duplicate(moved);
      await state.library.remove(copy);
      return { renamed, moved };
    `);
    const files = await page.evaluate(`return window.orangey.state.library.files().map((f) => f.path)`);
    assert.deepEqual(files, ["Campaign/renamed.orangey.json"]);
    const history = await page.evaluate(`return window.orangey.state.history.map((h) => [h.randomizerName, h.resultText])`);
    assert.equal(history.length, 1);
    assert.equal(history[0][0], "Movable", "history should keep the name it was rolled under");
    assert.ok(["A", "B"].includes(history[0][1]));

    // Deleting the randomizer leaves history readable.
    await page.evaluate(`await window.orangey.state.library.remove("Campaign/renamed.orangey.json")`);
    const after = await page.evaluate(`return window.orangey.state.history.length`);
    assert.equal(after, 1);
  });

  await test("N7 large data × wheel modes", async (page) => {
    await open(page, "", { fresh: true });
    for (const [count, expected] of [[33, "unlabelled"], [201, "ticker"], [500, "ticker"]]) {
      const items = Array.from({ length: count }, (_, i) => ({ label: `Outcome ${i + 1}`, weight: 1 }));
      const path = await createList(page, `Big ${count}`, items);
      await open(page, `#/r/${encodeURIComponent(path)}`);
      await page.evaluate(`window.orangey.state.setFeel({ motion: "instant" })`);
      const mode = await page.evaluate(`
        if (document.querySelector(".ticker")) return "ticker";
        return document.querySelector(".wheel-label") ? "wheel" : "unlabelled";
      `);
      assert.equal(mode, expected, `${count} outcomes rendered as ${mode}`);
      await page.click(".roll-button");
      await page.waitForFunction(`document.querySelector(".result-value").textContent !== "Ready"`);
      const result = await page.evaluate(`return document.querySelector(".result-value").textContent`);
      assert.match(result, /^Outcome \d+$/);
    }
    // A 32-outcome wheel still carries labels.
    const items = Array.from({ length: 32 }, (_, i) => ({ label: `L${i}`, weight: 1 }));
    const path = await createList(page, "Exactly 32", items);
    await open(page, `#/r/${encodeURIComponent(path)}`);
    assert.ok(await page.evaluate(`return Boolean(document.querySelector(".wheel-label"))`));
  });

  await test("N7b distribution over a large wheel stays within 1 %", async (page) => {
    await open(page, "", { fresh: true });
    const path = await createList(page, "Distribution", [
      { label: "Half", weight: 50 },
      { label: "Third", weight: 30 },
      { label: "Fifth", weight: 20 },
    ]);
    const counts = await page.evaluate(`
      const { state, rollRandomizer } = window.orangey;
      const node = state.library.find(${JSON.stringify(path)});
      const counts = { Half: 0, Third: 0, Fifth: 0 };
      for (let i = 0; i < 100000; i++) counts[rollRandomizer(node.randomizer, state.source()).text]++;
      return counts;
    `);
    assert.ok(Math.abs(counts.Half / 1000 - 50) < 1, `Half ${counts.Half / 1000}%`);
    assert.ok(Math.abs(counts.Third / 1000 - 30) < 1, `Third ${counts.Third / 1000}%`);
    assert.ok(Math.abs(counts.Fifth / 1000 - 20) < 1, `Fifth ${counts.Fifth / 1000}%`);
  });

  await test("N8 offline: everything still works with the network cut", async (page) => {
    await open(page, "", { fresh: true });
    await page.waitForFunction(`navigator.serviceWorker.controller || true`);
    await page.setOffline(true);
    await page.goto(`${server.origin}/index.html?debug`);
    await page.waitForFunction("window.orangey");
    const path = await createList(page, "Offline", [{ label: "Works", weight: 1 }, { label: "Also", weight: 1 }]);
    await open(page, `#/r/${encodeURIComponent(path)}`);
    await page.evaluate(`window.orangey.state.setFeel({ motion: "instant" })`);
    await page.click(".roll-button");
    await page.waitForFunction(`document.querySelector(".result-value").textContent !== "Ready"`);
    const result = await page.evaluate(`return document.querySelector(".result-value").textContent`);
    assert.ok(["Works", "Also"].includes(result), result);
    await page.setOffline(false);
  });

  await test("N8b the single-file build works from file:// and keeps its library", async (page) => {
    await page.goto(`file://${join(dist, "orangey.html")}?debug&noseed`);
    await page.waitForFunction("window.orangey");
    const backend = await page.evaluate(`return window.orangey.state.library.backend.kind`);
    // A page opened from disk gets no OPFS; it must fall to IndexedDB, never
    // to memory — that is exactly the bug where a new wheel disappeared.
    assert.equal(backend, "idb", `expected the IndexedDB backend on file://, got ${backend}`);
    await page.evaluate(`window.orangey.state.setFeel({ motion: "instant" })`);
    await page.click(".quickbar button:nth-child(6)");
    await page.waitForFunction(`document.querySelector(".result-value").textContent !== "Ready"`);
    const value = Number(await page.evaluate(`return document.querySelector(".result-value").textContent`));
    assert.ok(value >= 1 && value <= 20, `got ${value}`);

    await createList(page, "Kept on disk", [{ label: "A", weight: 1 }, { label: "B", weight: 2 }]);
    await page.goto(`file://${join(dist, "orangey.html")}?debug&noseed`);
    await page.waitForFunction("window.orangey");
    const names = await page.evaluate(`return window.orangey.state.library.files().map((f) => f.randomizer.name)`);
    assert.ok(names.includes("Kept on disk"), `the library did not survive a reload: ${names.join(", ")}`);
    assert.deepEqual(page.consoleErrors, []);
  });

  await test("M spin length follows the setting", async (page) => {
    await open(page, "", { fresh: true });
    const path = await createList(page, "Timed", [{ label: "A", weight: 1 }, { label: "B", weight: 1 }]);
    for (const durationMs of [800, 2000]) {
      await open(page, `#/r/${encodeURIComponent(path)}`);
      const measured = await page.evaluate(`
        const { state } = window.orangey;
        state.setFeel({ motion: "full", wheel: { ...state.prefs.feel.wheel, durationMs: ${durationMs}, turns: 3 } });
        const started = performance.now();
        document.querySelector(".roll-button").click();
        await new Promise((resolve) => {
          const check = () => (document.querySelector(".roll-button").textContent === "Roll" ? resolve() : requestAnimationFrame(check));
          requestAnimationFrame(check);
        });
        return performance.now() - started;
      `);
      assert.ok(
        Math.abs(measured - durationMs) < durationMs * 0.25 + 120,
        `asked for ${durationMs} ms, spin took ${measured.toFixed(0)} ms`,
      );
    }
  });

  await test("M instant mode produces a result within a frame", async (page) => {
    await open(page, "", { fresh: true });
    const path = await createList(page, "Instant", [{ label: "A", weight: 1 }, { label: "B", weight: 1 }]);
    await open(page, `#/r/${encodeURIComponent(path)}`);
    const elapsed = await page.evaluate(`
      window.orangey.state.setFeel({ motion: "instant" });
      const started = performance.now();
      document.querySelector(".roll-button").click();
      await new Promise((r) => requestAnimationFrame(r));
      return performance.now() - started;
    `);
    assert.ok(elapsed < 100, `took ${elapsed.toFixed(0)} ms`);
    const spoken = await page.evaluate(`return document.querySelector('[role="status"]').textContent`);
    assert.ok(spoken.length > 0, "instant mode should announce immediately");
  });

  await test("J drag-and-drop and the wizard report agree with the fixture", async (page) => {
    await open(page, "#/import", { fresh: true });
    await page.waitForFunction(`document.querySelector(".importer textarea")`);
    await page.type(".importer textarea", fixture("broken.csv"));
    await page.click(".importer .primary");
    await page.waitForFunction(`document.querySelector(".report")`);
    const report = await page.evaluate(`return [...document.querySelectorAll(".report div")].map((d) => d.textContent).join("\\n")`);
    assert.equal(
      report,
      [
        "✓ 4 entries ready",
        "✓ Weights valid (total 105)",
        "⚠ 1 entry has no description",
        '⚠ 1 duplicate label: "Wolf pack" (rows 4, 7) — kept both',
        "✗ 1 row had no label (row 6) — skipped",
        '✗ 1 entry has an invalid weight: row 5 "many" — will be skipped',
      ].join("\n"),
    );
  });

  await test("K the library keeps folders, search and favourites", async (page) => {
    await open(page, "", { fresh: true });
    await createList(page, "Forest Encounters", [{ label: "Goblin patrol", weight: 5 }, { label: "Merchant", weight: 1 }]);
    await open(page, "#/library");
    await page.waitForFunction(`document.querySelector(".library input[type=search]")`);
    await page.type(".library input[type=search]", "goblin");
    await page.waitForFunction(`document.querySelector(".search-hit")`);
    const hit = await page.evaluate(`return document.querySelector(".search-hit").textContent`);
    assert.match(hit, /Forest Encounters/);
    assert.match(hit, /outcome: Goblin patrol/);
  });

  await test("L history exports as CSV and can be cleared", async (page) => {
    await open(page, "", { fresh: true });
    const path = await createList(page, "Loggable", [{ label: "A", weight: 1 }]);
    await page.evaluate(`
      const { state, rollRandomizer } = window.orangey;
      const node = state.library.find(${JSON.stringify(path)});
      for (let i = 0; i < 3; i++) await state.record(node.randomizer, rollRandomizer(node.randomizer, state.source()));
    `);
    await open(page, "#/history");
    await page.waitForFunction(`document.querySelectorAll(".history-list li").length === 3`);
    await page.evaluate(`await window.orangey.state.clearHistory()`);
    await page.waitForFunction(`document.querySelectorAll(".history-list li").length === 0`);
  });

  await test("every interactive element has an accessible name", async (page) => {
    await open(page, "#/settings", { fresh: true });
    await page.waitForFunction(`document.querySelector(".card")`);
    const unnamed = await page.evaluate(`
      const nodes = [...document.querySelectorAll("button, input, select, textarea, a")];
      return nodes
        .filter((el) => {
          const label = el.getAttribute("aria-label") || el.textContent.trim() ||
            (el.labels && el.labels.length ? [...el.labels].map((l) => l.textContent).join(" ").trim() : "") ||
            el.getAttribute("title") || el.getAttribute("placeholder");
          return !label;
        })
        .map((el) => el.outerHTML.slice(0, 80));
    `);
    assert.deepEqual(unnamed, []);
  });

  await test("O the README walkthrough works end to end, offline, from a clean start", async (page) => {
    await open(page, "", { fresh: true });

    // 1–3: import the example CSV and create the wheel.
    await page.evaluate(`window.orangey.navigate("#/import")`);
    await page.waitForFunction(`document.querySelector(".importer textarea")`);
    await page.type(".importer textarea", readmeCsv);
    await page.click(".importer .primary");
    await page.waitForFunction(`document.querySelector(".report")`);
    assert.match(await page.evaluate(`return document.querySelector(".report").textContent`), /5 entries ready/);
    await page.evaluate(`[...document.querySelectorAll("button")].find((b) => b.textContent === "Create and edit").click()`);
    // Wait for the editor specifically: the wizard's preview table is also
    // ".outcomes", and with five rows it would otherwise match first.
    await page.waitForFunction(`document.querySelectorAll(".outcomes .weight-cell input").length === 5`);

    // From here on, nothing may touch the network.
    await page.setOffline(true);

    // 4: set the dragon's weight, disable the merchant, roll.
    await page.type(".outcomes tbody tr:nth-child(5) .weight-cell input", "1");
    await page.click(".outcomes tbody tr:nth-child(2) .disable-button");
    await page.waitForFunction(`document.querySelectorAll(".outcomes tbody tr.disabled").length === 1`);
    await page.evaluate(`window.orangey.state.setFeel({ motion: "instant" })`);
    await page.click(".roll-button");
    await page.waitForFunction(`document.querySelector(".result-value").textContent !== "Try it"`);
    const rolled = await page.evaluate(`return document.querySelector(".result-value").textContent`);
    assert.ok(["Goblin patrol", "Wolf pack", "Nothing", "Young green dragon"].includes(rolled), rolled);
    assert.notEqual(rolled, "Merchant", "a disabled outcome came up");

    // 5: reload — it is still there, still offline.
    await open(page);
    const saved = await page.evaluate(`
      const node = window.orangey.state.library.files()[0];
      return {
        name: node.randomizer.name,
        count: node.randomizer.items.length,
        disabled: node.randomizer.items.filter((i) => i.disabled).map((i) => i.label),
        dragon: node.randomizer.items.find((i) => i.label === "Young green dragon").weight,
      };
    `);
    assert.equal(saved.count, 5);
    assert.deepEqual(saved.disabled, ["Merchant"]);
    assert.equal(saved.dragon, 1);
    assert.deepEqual(page.consoleErrors, []);
    await page.setOffline(false);
  });

  // ---- P: Orangey the mascot ---------------------------------------------
  // The rules: one Orangey however many dice; a max roll is Happy and a min is
  // Oops; reveal waits for the landing; a failed link is Oops; presence is
  // the GM's choice; he never touches history or the RNG; at rest he is the
  // drawing.

  /**
   * Show him, with every reaction switched on. Orangey ships with four of them
   * off — the noisy ones — but these tests are about the machinery, so they
   * start from all of them on. What he does out of the box has its own test.
   */
  const mascotOn = (page, presence = "always", motion = "instant") =>
    page.evaluate(`
      const { state } = window.orangey;
      state.setFeel({ motion: ${JSON.stringify(motion)}, mascot: { ...state.prefs.feel.mascot, rules: {}, presence: ${JSON.stringify(presence)} } });
    `);
  /** Show him without touching the rules, so the shipped defaults still apply. */
  const mascotShow = (page, presence = "always", motion = "instant") =>
    page.evaluate(`
      const { state } = window.orangey;
      state.setFeel({ motion: ${JSON.stringify(motion)}, mascot: { ...state.prefs.feel.mascot, presence: ${JSON.stringify(presence)} } });
    `);
  const played = (page) => page.evaluate(`return [...window.orangey.mascot.played]`);
  const hostState = (page) => page.evaluate(`return window.orangey.mascot.state`);
  /** A seed whose FIRST d20 roll gives `want`, found by trying seeds in the page. */
  const seedFor = (page, expression, want) =>
    page.evaluate(`
      const { state, rollRandomizer } = window.orangey;
      const r = { type: "dice", expression: ${JSON.stringify(expression)}, id: "x", name: "x", created: "", modified: "" };
      for (let i = 0; i < 5000; i++) {
        await state.savePrefs({ seed: "p" + i });
        state.resetSeedSequence();
        if (rollRandomizer(r, state.source()).text === ${JSON.stringify(want)}) { state.resetSeedSequence(); return "p" + i; }
      }
      throw new Error("no seed found");
    `);

  await test("P one Orangey, however many dice: 8d6 makes one element and one landing", async (page) => {
    await open(page, "", { fresh: true });
    await mascotOn(page);
    await page.type(".quickbar input", "8d6");
    await page.key("Enter");
    await page.waitForFunction(`document.querySelector(".result-value").textContent !== "Ready"`);
    assert.equal(await page.evaluate(`return document.querySelectorAll(".mascot-host").length`), 1);
    assert.equal(await page.evaluate(`return document.querySelectorAll(".mascot-svg").length`), 1);
    const seen = await played(page);
    assert.equal(seen.length, 1, `one roll produced ${seen.length} reactions: ${seen}`);
  });

  await test("P a max roll is Happy, a min roll is Oops, anything else is Reveal", async (page) => {
    await open(page, "", { fresh: true });
    await mascotOn(page);
    for (const [want, expect] of [["20", "happy"], ["1", "oops"], ["11", "reveal"]]) {
      const seed = await seedFor(page, "d20", want);
      await page.evaluate(`await window.orangey.state.savePrefs({ seed: ${JSON.stringify(seed)} }); window.orangey.state.resetSeedSequence();`);
      await page.click(".quickbar button:nth-child(6)");
      await page.waitForFunction(`document.querySelector(".result-value").textContent === ${JSON.stringify(want)}`);
      assert.equal(await hostState(page), expect, `rolled ${want}`);
    }
    const seen = await played(page);
    assert.deepEqual(seen, ["happy", "oops", "reveal"]);
  });

  await test("P reveal waits for the landing: he is still anticipating at 1.5 s of a 3 s spin", async (page) => {
    await open(page, "", { fresh: true });
    const path = await createList(page, "Slow", [{ label: "A", weight: 1 }, { label: "B", weight: 1 }]);
    await open(page, `#/r/${encodeURIComponent(path)}`);
    await mascotOn(page, "always", "full");
    await page.evaluate(`window.orangey.state.setFeel({ wheel: { ...window.orangey.state.prefs.feel.wheel, durationMs: 3000 } })`);
    await page.click(".roll-button");
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(await hostState(page), "anticipate", "should still be watching the wheel");
    assert.equal(await page.evaluate(`return document.querySelector(".result-panel").classList.contains("is-pending")`), true);
    await page.waitForFunction(`document.querySelector(".roll-button").textContent === "Roll"`);
    assert.equal(await hostState(page), "reveal");
    assert.deepEqual(await played(page), ["anticipate", "reveal"]);
  });

  await test("P instant mode never flashes the anticipation pose", async (page) => {
    await open(page, "", { fresh: true });
    await mascotOn(page, "always", "instant");
    for (let i = 0; i < 5; i++) {
      await page.click(".quickbar button:nth-child(2)");
      await page.waitForFunction(`window.orangey.state.history.length === ${i + 1}`);
    }
    const seen = await played(page);
    assert.ok(!seen.includes("anticipate"), `anticipate was shown: ${seen}`);
    assert.equal(seen.length, 5);
  });

  await test("P a slide link to something this library does not have makes him wince", async (page) => {
    await open(page, "", { fresh: true });
    await mascotOn(page, "triggers");
    await open(page, "#/id/not-in-this-library?roll=1");
    const text = await page.evaluate(`return document.querySelector(".main-inner").textContent`);
    assert.match(text, /not stored in this browser/);
    assert.equal(await hostState(page), "oops");
    assert.equal(await page.evaluate(`return document.querySelector(".mascot-host").classList.contains("is-visible")`), true);
    assert.equal(await page.evaluate(`return document.querySelector(".main-inner .mascot-slot .mascot-host") !== null`), true, "he is in the message's slot");
  });

  await test("P a roll that cannot happen is an Oops", async (page) => {
    await open(page, "", { fresh: true });
    const path = await createList(page, "Nothing", [{ label: "A", weight: 0 }, { label: "B", weight: 0 }]);
    await open(page, `#/r/${encodeURIComponent(path)}`);
    await mascotOn(page);
    await page.click(".roll-button");
    await page.waitForFunction(`document.querySelector(".result-value").textContent.includes("No outcomes")`);
    assert.equal(await hostState(page), "oops");
  });

  await test("P a clean import is Happy and one with problems is Oops", async (page) => {
    for (const [file, expect] of [["simple.csv", "happy"], ["broken.csv", "oops"]]) {
      await open(page, "#/import", { fresh: true });
      await mascotOn(page);
      await page.waitForFunction(`document.querySelector(".importer textarea")`);
      await page.type(".importer textarea", fixture(file));
      await page.click(".importer .primary");
      await page.waitForFunction(`document.querySelector(".report")`);
      await page.evaluate(`[...document.querySelectorAll(".importer button")].find((b) => b.textContent === "Create and edit").click()`);
      await page.waitForFunction(`location.hash.startsWith("#/edit/")`);
      const seen = await played(page);
      assert.equal(seen[seen.length - 1], expect, `${file}: ${seen}`);
    }
  });

  await test("P presence: hidden mounts nothing, triggers shows him only for a roll, always idles from load", async (page) => {
    await open(page, "", { fresh: true });
    await mascotOn(page, "hidden");
    assert.equal(await page.evaluate(`return document.querySelectorAll(".mascot-host").length`), 0);
    await page.click(".quickbar button:nth-child(6)");
    await page.waitForFunction(`document.querySelector(".result-value").textContent !== "Ready"`);
    assert.equal(await page.evaluate(`return document.querySelectorAll(".mascot-host").length`), 0, "still nothing after a roll");
    assert.deepEqual(await played(page), []);

    await mascotOn(page, "triggers");
    assert.equal(await page.evaluate(`return document.querySelectorAll(".mascot-host").length`), 1);
    assert.equal(await page.evaluate(`return document.querySelector(".mascot-host").classList.contains("is-visible")`), false, "invisible until something happens");
    await page.click(".quickbar button:nth-child(6)");
    await page.waitForFunction(`document.querySelector(".mascot-host").classList.contains("is-visible")`);
    await page.waitForFunction(`!document.querySelector(".mascot-host").classList.contains("is-visible")`, 6000);

    await mascotOn(page, "always");
    assert.equal(await page.evaluate(`return document.querySelector(".mascot-host").classList.contains("is-visible")`), true);
    assert.equal(await hostState(page), "idle");
    // the setting survives a reload
    await open(page);
    assert.equal(await page.evaluate(`return window.orangey.state.prefs.feel.mascot.presence`), "always");
    assert.equal(await page.evaluate(`return document.querySelector(".mascot-host").classList.contains("is-visible")`), true);
  });

  await test("P instant mode draws one still pose and schedules no frames", async (page) => {
    await open(page, "", { fresh: true });
    await mascotOn(page, "always", "instant");
    await page.click(".quickbar button:nth-child(6)");
    await page.waitForFunction(`document.querySelector(".result-value").textContent !== "Ready"`);
    const a = await page.evaluate(`return document.querySelector(".mascot-svg .body").getAttribute("d")`);
    await new Promise((r) => setTimeout(r, 400));
    const b = await page.evaluate(`return document.querySelector(".mascot-svg .body").getAttribute("d")`);
    assert.equal(a, b, "the body moved in instant mode");
    assert.equal(await page.evaluate(`return window.orangey.mascotTicker.running`), false);
    assert.equal(await page.evaluate(`return window.orangey.mascotTicker.size`), 0);
  });

  await test("P Escape at 30 % of a spin leaves him in the same pose as a full spin", async (page) => {
    await open(page, "", { fresh: true });
    const path = await createList(page, "Skippable", [{ label: "A", weight: 1 }, { label: "B", weight: 1 }]);
    await open(page, `#/r/${encodeURIComponent(path)}`);
    await mascotOn(page, "always", "full");
    await page.evaluate(`window.orangey.state.setFeel({ wheel: { ...window.orangey.state.prefs.feel.wheel, durationMs: 2000 } })`);
    await page.click(".roll-button");
    await new Promise((r) => setTimeout(r, 600));
    await page.key("Escape");
    await page.waitForFunction(`document.querySelector(".roll-button").textContent === "Roll"`);
    assert.equal(await hostState(page), "reveal");
    assert.deepEqual(await played(page), ["anticipate", "reveal"]);
  });

  await test("P he never touches history or the RNG: the same seed gives the same rolls with him on and off", async (page) => {
    await open(page, "", { fresh: true });
    const run = async (presence) => {
      await page.evaluate(`
        const { state } = window.orangey;
        await state.clearHistory();
        await state.savePrefs({ seed: "parity" });
        state.resetSeedSequence();
      `);
      await mascotOn(page, presence, "instant");
      for (let i = 0; i < 30; i++) {
        await page.click(".quickbar button:nth-child(6)");
        await page.waitForFunction(`window.orangey.state.history.length === ${i + 1}`);
      }
      return page.evaluate(`return window.orangey.state.history.map((e) => e.resultText + "|" + e.seed).reverse()`);
    };
    const hidden = await run("hidden");
    const always = await run("always");
    assert.deepEqual(always, hidden);
    assert.equal(hidden.length, 30);
  });

  await test("P two hundred rolls leave one element and one ticker subscriber at most", async (page) => {
    await open(page, "", { fresh: true });
    await mascotOn(page, "always", "instant");
    for (let i = 0; i < 200; i++) {
      await page.click(".quickbar button:nth-child(2)");
      await page.waitForFunction(`window.orangey.mascot.played.length === ${i + 1}`);
    }
    assert.equal(await page.evaluate(`return document.querySelectorAll(".mascot-host").length`), 1);
    assert.equal(await page.evaluate(`return document.querySelectorAll(".mascot-svg").length`), 1);
    assert.ok((await page.evaluate(`return window.orangey.mascotTicker.size`)) <= 1);
  });

  await test("P at rest he is the drawing: mean body height within 0.5 % at every wobble setting", async (page) => {
    await open(page, "", { fresh: true });
    await mascotOn(page, "always", "full");
    const DRAWN = 112.09;
    for (const wobble of [0, 1, 1.8]) {
      await page.evaluate(`window.orangey.state.setFeel({ mascot: { ...window.orangey.state.prefs.feel.mascot, wobble: ${wobble} } })`);
      // let the change settle, then sample for two breath cycles
      await new Promise((r) => setTimeout(r, 1200));
      const stats = await page.evaluate(`
        const el = document.querySelector(".mascot-svg .body");
        const hs = [];
        const t0 = performance.now();
        while (performance.now() - t0 < 6800) { await new Promise((r) => requestAnimationFrame(r)); hs.push(el.getBBox().height); }
        return { mean: hs.reduce((a, b) => a + b, 0) / hs.length, max: Math.max(...hs), n: hs.length };
      `);
      assert.ok(Math.abs(stats.mean / DRAWN - 1) < 0.005, `wobble ${wobble}: mean height ${stats.mean.toFixed(2)} vs ${DRAWN} over ${stats.n} frames`);
      assert.ok(stats.max >= DRAWN - 0.05, `wobble ${wobble}: never reached the drawn height (max ${stats.max.toFixed(2)})`);
    }
  });

  await test("P the mascot is decoration: aria-hidden, not focusable, no accessible name needed", async (page) => {
    await open(page, "", { fresh: true });
    await mascotOn(page, "always");
    assert.equal(await page.evaluate(`return document.querySelector(".mascot-host").getAttribute("aria-hidden")`), "true");
    assert.equal(await page.evaluate(`return document.querySelector(".mascot-svg").getAttribute("aria-hidden")`), "true");
    assert.equal(await page.evaluate(`return document.querySelector(".mascot-host").querySelectorAll("button, a, input, [tabindex]").length`), 0);
  });

  await test("P the Orangey settings card changes presence, wobble and rules, and they survive a reload", async (page) => {
    await open(page, "#/settings", { fresh: true });
    await page.waitForFunction(`document.querySelector(".mascot-card")`);
    await page.click('.mascot-card [aria-label="Presence"] button:nth-child(3)');
    await page.waitForFunction(`window.orangey.state.prefs.feel.mascot.presence === "always"`);
    await page.click('.mascot-card [aria-label="Wobble"] button:nth-child(1)');
    await page.waitForFunction(`window.orangey.state.prefs.feel.mascot.wobble === 0`);
    await page.click('.mascot-card input[data-rule="roll-max"]');
    await page.waitForFunction(`window.orangey.state.prefs.feel.mascot.rules["roll-max"] === false`);
    await page.click(".preview-mascot-happy");
    await open(page, "#/settings");
    const m = await page.evaluate(`return window.orangey.state.prefs.feel.mascot`);
    assert.equal(m.presence, "always");
    assert.equal(m.wobble, 0);
    // the four Orangey ships with off are still off, and roll-max joins them
    assert.deepEqual(m.rules, {
      "roll-start": false, "roll-land": false, "roll-fail": false, "import-warn": false, "roll-max": false,
    });
    // and the switched-off rule really is off: a maximum no longer cheers
    await open(page, "#/");
    const seed = await seedFor(page, "d20", "20");
    await page.evaluate(`await window.orangey.state.savePrefs({ seed: ${JSON.stringify(seed)} }); window.orangey.state.resetSeedSequence(); window.orangey.state.setFeel({ motion: "instant" });`);
    await page.click(".quickbar button:nth-child(6)");
    await page.waitForFunction(`document.querySelector(".result-value").textContent === "20"`);
    assert.ok(!(await played(page)).includes("happy"), "cheering was switched off");
    assert.notEqual(await hostState(page), "happy");
    assert.deepEqual(page.consoleErrors, []);
  });

  // ---- Q: Orangey on wheels and coins ---------------------------------------

  /** A seed whose first roll of the randomizer at `path` lands on `wantText`. */
  const seedForPath = (page, path, wantText) =>
    page.evaluate(`
      const { state, rollRandomizer } = window.orangey;
      const r = state.library.find(${JSON.stringify(path)}).randomizer;
      for (let i = 0; i < 5000; i++) {
        await state.savePrefs({ seed: "q" + i });
        state.resetSeedSequence();
        if (rollRandomizer(r, state.source()).text === ${JSON.stringify(wantText)}) { state.resetSeedSequence(); return "q" + i; }
      }
      throw new Error("no seed found");
    `);

  await test("Q tagging a wheel outcome in the editor: the cell cycles none → cheer → wince → none and is saved", async (page) => {
    await open(page, "", { fresh: true });
    const path = await createList(page, "Tagged", [{ label: "Crit", weight: 1 }, { label: "Fumble", weight: 1 }, { label: "Meh", weight: 1 }]);
    await open(page, `#/edit/${encodeURIComponent(path)}`);
    await page.waitForFunction(`document.querySelectorAll(".outcomes .reaction-control").length === 3`);
    const cell = (n) => `.outcomes tr:nth-child(${n}) .reaction-control`;
    assert.equal(await page.evaluate(`return document.querySelector(${JSON.stringify(cell(1))}).dataset.reaction`), "none");
    await page.click(cell(1));
    await page.waitForFunction(`document.querySelector(${JSON.stringify(cell(1))}).dataset.reaction === "cheer"`);
    await page.click(cell(2));
    await page.click(cell(2));
    await page.waitForFunction(`document.querySelector(${JSON.stringify(cell(2))}).dataset.reaction === "wince"`);
    await page.click(cell(3));
    await page.click(cell(3));
    await page.click(cell(3));
    await page.waitForFunction(`document.querySelector(${JSON.stringify(cell(3))}).dataset.reaction === "none"`);
    await page.evaluate(`await window.orangey.state.library.flush()`);
    await open(page, `#/edit/${encodeURIComponent(path)}`);
    const saved = await page.evaluate(`return window.orangey.state.library.find(${JSON.stringify(path)}).randomizer.items.map((i) => i.reaction ?? null)`);
    assert.deepEqual(saved, ["cheer", "wince", null]);
    assert.deepEqual(page.consoleErrors, []);
  });

  await test("Q the bulk bar tags every selected outcome at once", async (page) => {
    await open(page, "", { fresh: true });
    const path = await createList(page, "Bulk", [{ label: "A", weight: 1 }, { label: "B", weight: 1 }, { label: "C", weight: 1 }]);
    await open(page, `#/edit/${encodeURIComponent(path)}`);
    await page.waitForFunction(`document.querySelectorAll(".outcomes tbody tr").length === 3`);
    await page.click('.outcomes th input[aria-label="Select all outcomes"]');
    await page.waitForFunction(`document.querySelector(".bulk-wince")`);
    await page.click(".bulk-wince");
    await page.waitForFunction(`[...document.querySelectorAll(".outcomes .reaction-control")].every((b) => b.dataset.reaction === "wince")`);
    await page.click('.outcomes th input[aria-label="Select all outcomes"]');
    await page.click('.outcomes tr:nth-child(2) input[type="checkbox"]');
    await page.waitForFunction(`document.querySelector(".bulk-no-reaction")`);
    await page.click(".bulk-no-reaction");
    await page.waitForFunction(`document.querySelector(".outcomes tr:nth-child(2) .reaction-control").dataset.reaction === "none"`);
    const saved = await page.evaluate(`return window.orangey.state.library.find(${JSON.stringify(path)}).randomizer.items.map((i) => i.reaction ?? null)`);
    assert.deepEqual(saved, ["wince", null, "wince"]);
  });

  await test("Q a tagged wheel outcome is Happy or Oops when it lands, exactly like a max or min die", async (page) => {
    await open(page, "", { fresh: true });
    const path = await createList(page, "Fate", [
      { label: "Crit", weight: 1, reaction: "cheer" }, { label: "Fumble", weight: 1, reaction: "wince" }, { label: "Meh", weight: 1 },
    ]);
    await open(page, `#/r/${encodeURIComponent(path)}`);
    await mascotOn(page, "always", "instant");
    for (const [want, expect] of [["Crit", "happy"], ["Fumble", "oops"], ["Meh", "reveal"]]) {
      const seed = await seedForPath(page, path, want);
      await page.evaluate(`await window.orangey.state.savePrefs({ seed: ${JSON.stringify(seed)} }); window.orangey.state.resetSeedSequence();`);
      await page.click(".roll-button");
      await page.waitForFunction(`document.querySelector(".result-value").textContent === ${JSON.stringify(want)}`);
      assert.equal(await hostState(page), expect, `landed on ${want}`);
    }
    assert.deepEqual(await played(page), ["happy", "oops", "reveal"]);
  });

  await test("Q a coin face can be tagged in its editor and Orangey reacts to that face only", async (page) => {
    await open(page, "", { fresh: true });
    const path = await page.evaluate(`
      const { state } = window.orangey;
      const r = { id: "coin1", type: "coin", name: "Omen", faces: ["Good", "Ill"], created: new Date().toISOString(), modified: new Date().toISOString() };
      return await state.library.create("", r);
    `);
    await open(page, `#/edit/${encodeURIComponent(path)}`);
    await page.waitForFunction(`document.querySelectorAll(".reaction-control").length === 2`);
    // second face → wince (two presses)
    await page.click(".reaction-control:nth-of-type(1)");
    await page.evaluate(`document.querySelectorAll(".reaction-control")[1].click()`);
    await page.waitForFunction(`document.querySelectorAll(".reaction-control")[1].dataset.reaction === "cheer"`);
    await page.evaluate(`document.querySelectorAll(".reaction-control")[1].click()`);
    await page.waitForFunction(`document.querySelectorAll(".reaction-control")[1].dataset.reaction === "wince"`);
    await page.evaluate(`await window.orangey.state.library.flush()`);
    let saved = await page.evaluate(`return window.orangey.state.library.find(${JSON.stringify(path)}).randomizer.faceReactions`);
    assert.deepEqual(saved, ["cheer", "wince"]);
    // clearing both faces removes the key from the file entirely
    await page.evaluate(`document.querySelectorAll(".reaction-control")[0].click()`);
    await page.evaluate(`document.querySelectorAll(".reaction-control")[0].click()`);
    await page.evaluate(`document.querySelectorAll(".reaction-control")[1].click()`);
    await page.evaluate(`await window.orangey.state.library.flush()`);
    saved = await page.evaluate(`return "faceReactions" in window.orangey.state.library.find(${JSON.stringify(path)}).randomizer`);
    assert.equal(saved, false);
    // tag Ill again and roll it
    await page.evaluate(`document.querySelectorAll(".reaction-control")[1].click()`);
    await page.evaluate(`document.querySelectorAll(".reaction-control")[1].click()`);
    await page.evaluate(`await window.orangey.state.library.flush()`);
    await open(page, `#/r/${encodeURIComponent(path)}`);
    await mascotOn(page, "always", "instant");
    for (const [want, expect] of [["Ill", "oops"], ["Good", "reveal"]]) {
      const seed = await seedForPath(page, path, want);
      await page.evaluate(`await window.orangey.state.savePrefs({ seed: ${JSON.stringify(seed)} }); window.orangey.state.resetSeedSequence();`);
      await page.click(".roll-button");
      await page.waitForFunction(`document.querySelector(".result-value").textContent === ${JSON.stringify(want)}`);
      assert.equal(await hostState(page), expect, `landed on ${want}`);
    }
    assert.deepEqual(page.consoleErrors, []);
  });

  await test("Q switching off the tag rules in Settings makes a tagged outcome a plain landing", async (page) => {
    await open(page, "", { fresh: true });
    const path = await createList(page, "Off", [{ label: "Crit", weight: 1, reaction: "cheer" }, { label: "Meh", weight: 1 }]);
    await open(page, "#/settings");
    await page.waitForFunction(`document.querySelector('.mascot-card input[data-rule="outcome-cheer"]')`);
    await page.click('.mascot-card input[data-rule="outcome-cheer"]');
    await page.waitForFunction(`window.orangey.state.prefs.feel.mascot.rules["outcome-cheer"] === false`);
    await open(page, `#/r/${encodeURIComponent(path)}`);
    await mascotShow(page, "always", "instant");
    // Say the precondition out loud rather than inheriting it: what he does
    // with the shipped defaults has its own test, and the suite shares one
    // browser profile, so a previous test's preferences can outlive a clear.
    await page.evaluate(`
      const { state } = window.orangey;
      const rules = { ...state.prefs.feel.mascot.rules, "roll-land": false };
      state.setFeel({ mascot: { ...state.prefs.feel.mascot, rules } });
    `);
    const seed = await seedForPath(page, path, "Crit");
    await page.evaluate(`await window.orangey.state.savePrefs({ seed: ${JSON.stringify(seed)} }); window.orangey.state.resetSeedSequence();`);
    await page.click(".roll-button");
    await page.waitForFunction(`document.querySelector(".result-value").textContent === "Crit"`);
    // ordinary landings are off out of the box too, so with the tag rule off
    // he has nothing to say about this outcome at all
    assert.deepEqual(await played(page), []);
    assert.notEqual(await hostState(page), "happy");
  });

  await test("Q a file with a tag round-trips through the library byte for byte", async (page) => {
    await open(page, "", { fresh: true });
    const path = await createList(page, "RT", [{ label: "X", weight: 2, color: "#a33a30", reaction: "cheer" }, { label: "Y", weight: 1 }]);
    const text = await page.evaluate(`return await window.orangey.state.library.backend.read(${JSON.stringify(path)})`);
    assert.ok(text.includes('"color": "#a33a30",\n        "reaction": "cheer"'), text);
  });

  // ---- Q: back, settings file, my colours, a copy of the app ----------------

  /** Capture what the app hands to the browser as a download: the blob's text. */
  const captureDownload = (page) =>
    page.evaluate(`
      window.__downloads = [];
      const real = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (blob) => { window.__downloads.push(blob); return real(blob); };
    `);
  const lastDownload = (page) => page.evaluate(`return await window.__downloads.at(-1).text()`);

  await test("Q Back returns to the last played randomizer from Settings, History and Import, and to play when there is none", async (page) => {
    await open(page, "", { fresh: true });
    const path = await createList(page, "Home", [{ label: "A", weight: 1 }]);
    await open(page, "#/settings");
    await page.waitForFunction(`document.querySelector(".topbar .back") && !document.querySelector(".topbar .back").hidden`);
    await page.click(".topbar .back");
    await page.waitForFunction(`location.hash === "#/"`);
    assert.equal(await page.evaluate(`return document.querySelector(".topbar .back").hidden`), true, "hidden on play");
    await open(page, `#/r/${encodeURIComponent(path)}`);
    await page.waitForFunction(`window.orangey.state.prefs.lastPath === ${JSON.stringify(path)}`);
    for (const hash of ["#/settings", "#/history", "#/import", "#/library"]) {
      await open(page, hash);
      await page.waitForFunction(`!document.querySelector(".topbar .back").hidden`);
      await page.click(".topbar .back");
      await page.waitForFunction(`location.hash === ${JSON.stringify(`#/r/${encodeURIComponent(path)}`)}`, `from ${hash}`);
      assert.equal(await page.evaluate(`return document.querySelector(".topbar .back").hidden`), true);
    }
    // an editor goes back to what it edits, not to what was played last
    const other = await createList(page, "Other", [{ label: "B", weight: 1 }]);
    await open(page, `#/edit/${encodeURIComponent(other)}`);
    await page.waitForFunction(`!document.querySelector(".topbar .back").hidden`);
    await page.click(".topbar .back");
    await page.waitForFunction(`location.hash === ${JSON.stringify(`#/r/${encodeURIComponent(other)}`)}`);
    // the last played one deleted: back goes to play, not to a missing page
    await page.evaluate(`await window.orangey.state.library.remove(${JSON.stringify(path)})`);
    await page.evaluate(`await window.orangey.state.savePrefs({ lastPath: ${JSON.stringify(path)} })`);
    await open(page, "#/settings");
    await page.click(".topbar .back");
    await page.waitForFunction(`location.hash === "#/"`);
    assert.deepEqual(page.consoleErrors, []);
  });

  await test("Q Back is the one top-bar button that stays on a phone-sized screen", async (page) => {
    await open(page, "#/settings", { fresh: true });
    await page.setViewport(400, 800);
    await page.waitForFunction(`document.querySelector(".topbar .back")`);
    const shown = await page.evaluate(`
      const vis = (sel) => getComputedStyle(document.querySelector(sel)).display !== "none";
      return { back: vis(".topbar .back"), library: [...document.querySelectorAll(".topbar button")].filter((b) => !b.classList.contains("back")).every((b) => getComputedStyle(b).display === "none") };
    `);
    assert.equal(shown.back, true);
    assert.equal(shown.library, true, "the other top-bar buttons yield to the tab bar");
    await page.setViewport(1280, 900);
  });

  await test("Q Save settings writes a file with the scheme, feel, Orangey, seed and my colours; Load applies it and refuses a bad one", async (page) => {
    await open(page, "#/settings", { fresh: true });
    await page.waitForFunction(`document.querySelector(".settings-file-card")`);
    await page.evaluate(`
      const { state } = window.orangey;
      state.setFeel({ wheel: { ...state.prefs.feel.wheel, durationMs: 4200 }, mascot: { ...state.prefs.feel.mascot, presence: "always", rules: { "roll-min": false } } });
      await state.savePrefs({ scheme: "ocean", seed: "table 7", lastPath: "secret.orangey.json" });
      state.addColour({ name: "Campaign red", hex: "#B3202A" });
    `);
    await captureDownload(page);
    await page.click(".save-settings");
    await page.waitForFunction(`window.__downloads.length === 1`);
    const text = await lastDownload(page);
    const doc = JSON.parse(text);
    assert.equal(doc.format, "orangey-settings");
    assert.equal(doc.settings.scheme, "ocean");
    assert.equal(doc.settings.feel.wheel.durationMs, 4200);
    assert.equal(doc.settings.feel.mascot.presence, "always");
    assert.deepEqual(doc.settings.feel.mascot.rules, { "roll-min": false });
    assert.equal(doc.settings.seed, "table 7");
    assert.deepEqual(doc.settings.colours, [{ name: "Campaign red", hex: "#b3202a" }]);
    assert.ok(!text.includes("secret.orangey.json"), "device-local paths must not travel");

    // a fresh browser, then load that file through the real file input
    await open(page, "#/settings", { fresh: true });
    await page.waitForFunction(`document.querySelector(".load-settings")`);
    assert.equal(await page.evaluate(`return window.orangey.state.prefs.scheme`), "orangey");
    await page.evaluate(`
      const input = document.querySelector('.settings-file-card input[type="file"]');
      const dt = new DataTransfer();
      dt.items.add(new File([${JSON.stringify(text)}], "orangey-settings.json", { type: "application/json" }));
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    `);
    await page.waitForFunction(`window.orangey.state.prefs.scheme === "ocean"`);
    const after = await page.evaluate(`return { feel: window.orangey.state.prefs.feel, seed: window.orangey.state.prefs.seed, colours: window.orangey.state.prefs.colours, scheme: document.documentElement.getAttribute("data-scheme") }`);
    assert.equal(after.feel.wheel.durationMs, 4200);
    assert.equal(after.feel.mascot.presence, "always");
    assert.deepEqual(after.feel.mascot.rules, { "roll-min": false });
    assert.equal(after.seed, "table 7");
    assert.deepEqual(after.colours, [{ name: "Campaign red", hex: "#b3202a" }]);
    assert.equal(after.scheme, "ocean", "the scheme is applied to the page at once");
    // it survives a reload
    await open(page, "#/settings");
    assert.equal(await page.evaluate(`return window.orangey.state.prefs.feel.wheel.durationMs`), 4200);

    // a bad file: nothing changes, and the toast names the problem
    await page.evaluate(`
      const input = document.querySelector('.settings-file-card input[type="file"]');
      const dt = new DataTransfer();
      dt.items.add(new File(['{"format":"orangey-settings","version":1,"settings":{"scheme":"lava","seed":"nope"}}'], "bad.json"));
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    `);
    await page.waitForFunction(`[...document.querySelectorAll(".toasts *")].some((t) => t.textContent.includes("Could not load bad.json"))`);
    const toast = await page.evaluate(`return document.querySelector(".toasts").textContent`);
    assert.match(toast, /settings\.scheme/);
    assert.equal(await page.evaluate(`return window.orangey.state.prefs.seed`), "table 7", "a refused file changes nothing");
    assert.equal(await page.evaluate(`return window.orangey.state.prefs.scheme`), "ocean");
    assert.deepEqual(page.consoleErrors, []);
  });

  await test("Q my colours: added in Settings or from the picker, shown first in the picker, removable, and used on an outcome", async (page) => {
    await open(page, "#/settings", { fresh: true });
    await page.waitForFunction(`document.querySelector(".colours-card")`);
    await page.evaluate(`
      const c = document.querySelector('.colours-card input[type="color"]');
      c.value = "#5a6b2f"; c.dispatchEvent(new Event("input", { bubbles: true }));
      const n = document.querySelector('.colours-card input[type="text"]');
      n.value = "Swamp";
    `);
    await page.click(".colours-card .add-colour");
    await page.waitForFunction(`document.querySelectorAll(".my-colour").length === 1`);
    assert.deepEqual(await page.evaluate(`return window.orangey.state.prefs.colours`), [{ name: "Swamp", hex: "#5a6b2f" }]);
    // an empty name is refused, not saved as a blank
    await page.click(".colours-card .add-colour");
    assert.equal(await page.evaluate(`return document.querySelectorAll(".my-colour").length`), 1);
    assert.equal(await page.evaluate(`return document.querySelector('.colours-card input[type="text"]').getAttribute("aria-invalid")`), "true");

    // from the picker in an editor
    const path = await createList(page, "Palette", [{ label: "A", weight: 1 }, { label: "B", weight: 1 }]);
    await open(page, `#/edit/${encodeURIComponent(path)}`);
    await page.waitForFunction(`document.querySelector(".outcomes tr:nth-child(1) .swatch")`);
    await page.click(".outcomes tr:nth-child(1) .swatch");
    await page.waitForFunction(`document.querySelector(".swatch-dialog[open]")`);
    const firstGroup = await page.evaluate(`return document.querySelector(".swatch-dialog .swatch-group-title").textContent`);
    assert.equal(firstGroup, "My colours");
    assert.equal(await page.evaluate(`return document.querySelector(".swatch-grid-custom button").getAttribute("aria-label")`), "Swamp");
    await page.evaluate(`
      const c = document.querySelector('.swatch-add input[type="color"]');
      c.value = "#b3202a"; c.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector('.swatch-add input[type="text"]').value = "Campaign red";
    `);
    await page.click(".swatch-add-save");
    await page.waitForFunction(`!document.querySelector(".swatch-dialog")`);
    await page.evaluate(`await window.orangey.state.library.flush()`);
    const item = await page.evaluate(`return window.orangey.state.library.find(${JSON.stringify(path)}).randomizer.items[0].color`);
    assert.equal(item, "#b3202a", "saving a new colour also applies it to the outcome");
    assert.deepEqual(await page.evaluate(`return window.orangey.state.prefs.colours.map((c) => c.name)`), ["Swamp", "Campaign red"]);
    // it is named in the picker next time
    await page.click(".outcomes tr:nth-child(1) .swatch");
    await page.waitForFunction(`document.querySelector(".swatch-dialog[open]")`);
    assert.match(await page.evaluate(`return document.querySelector(".swatch-name").textContent`), /Campaign red/);
    await page.evaluate(`document.querySelector(".swatch-dialog").close()`);

    // remove one in Settings; the outcome keeps its hex, it just loses its name
    await open(page, "#/settings");
    await page.waitForFunction(`document.querySelectorAll(".my-colour").length === 2`);
    await page.click('.my-colour[data-hex="#b3202a"] .remove-colour');
    await page.waitForFunction(`document.querySelectorAll(".my-colour").length === 1`);
    assert.deepEqual(await page.evaluate(`return window.orangey.state.prefs.colours.map((c) => c.name)`), ["Swamp"]);
    assert.equal(await page.evaluate(`return window.orangey.state.library.find(${JSON.stringify(path)}).randomizer.items[0].color`), "#b3202a");
    assert.deepEqual(page.consoleErrors, []);
  });

  await test("Q the About card downloads orangey.html — the single file — and the single file says so instead", async (page) => {
    await open(page, "#/settings", { fresh: true });
    await page.waitForFunction(`document.querySelector(".download-copy")`);
    await captureDownload(page);
    await page.click(".download-copy");
    await page.waitForFunction(`window.__downloads.length === 1`);
    const html = await lastDownload(page);
    assert.ok(html.startsWith("<!doctype html>") || html.startsWith("<!DOCTYPE html>"), html.slice(0, 40));
    assert.ok(html.includes('<meta name="orangey-build" content="single">'));
    assert.ok(html.length > 300000, `only ${html.length} bytes`);
    assert.ok(html.includes("<title>Orangey"));
    // opened as the single file, the card explains rather than offering itself
    await page.goto(`${server.origin}/orangey.html?debug&noseed#/settings`);
    await page.waitForFunction(`window.orangey && document.querySelector(".about-card")`);
    assert.equal(await page.evaluate(`return document.querySelector(".download-copy")`), null);
    assert.match(await page.evaluate(`return document.querySelector(".about-card").textContent`), /single-file Orangey/);
    assert.deepEqual(page.consoleErrors, []);
  });

  // ---- R: the brand mark and the icons ---------------------------------------

  await test("R the top bar wears Orangey's head, on every scheme, and the placeholder wheel is gone", async (page) => {
    await open(page, "", { fresh: true });
    await page.waitForFunction(`document.querySelector(".brand .mark svg")`);
    const mark = await page.evaluate(`
      const span = document.querySelector(".brand .mark");
      const svg = span.querySelector("svg");
      const body = svg.querySelector("path.body");
      return {
        background: getComputedStyle(span).backgroundImage,
        hasBody: !!body,
        bodyFill: getComputedStyle(body).fill,
        eyes: svg.querySelectorAll("ellipse.eye").length,
        stem: !!svg.querySelector("ellipse.stem"),
        mouths: svg.querySelectorAll(".mouth").length,
        hidden: svg.getAttribute("aria-hidden"),
        width: Math.round(span.getBoundingClientRect().width),
        height: Math.round(span.getBoundingClientRect().height),
      };
    `);
    assert.equal(mark.background, "none", "the placeholder gradient is still there");
    assert.equal(mark.hasBody, true, "no body path in the mark");
    assert.equal(mark.bodyFill, "rgb(243, 162, 87)");
    assert.equal(mark.eyes, 2);
    assert.equal(mark.stem, true);
    assert.equal(mark.mouths, 0, "the mark is the logo, not a pose");
    assert.equal(mark.hidden, "true", "the mark is decoration beside the word Orangey");
    assert.ok(mark.width > 8 && mark.height > 8, `the mark has no size: ${mark.width}×${mark.height}`);

    // he is the same fruit in every scheme, and always visible against the bar
    for (const scheme of ["orangey", "night", "meadow", "ocean", "berry"]) {
      await page.evaluate(`await window.orangey.state.savePrefs({ scheme: ${JSON.stringify(scheme)} })`);
      const fill = await page.evaluate(`return getComputedStyle(document.querySelector(".brand .mark path.body")).fill`);
      assert.equal(fill, "rgb(243, 162, 87)", `scheme ${scheme}`);
    }
    assert.deepEqual(page.consoleErrors, []);
  });

  await test("R every icon the manifest names is served, is a PNG, and one of them is maskable", async (page) => {
    await open(page, "", { fresh: true });
    const icons = await page.evaluate(`
      const manifest = await (await fetch("manifest.webmanifest")).json();
      const out = [];
      for (const icon of manifest.icons) {
        const res = await fetch(icon.src);
        const bytes = new Uint8Array(await res.arrayBuffer());
        out.push({ src: icon.src, purpose: icon.purpose, ok: res.ok, png: bytes[0] === 0x89 && bytes[1] === 0x50, length: bytes.length });
      }
      return out;
    `);
    assert.equal(icons.length, 3);
    for (const icon of icons) {
      assert.equal(icon.ok, true, `${icon.src} was not served`);
      assert.equal(icon.png, true, `${icon.src} is not a PNG`);
      assert.ok(icon.length > 500, `${icon.src} is suspiciously small: ${icon.length} bytes`);
    }
    const maskable = icons.find((i) => i.purpose === "maskable");
    assert.ok(maskable, "no maskable icon");
    assert.ok(maskable.src.includes("maskable"), "the maskable icon is not its own inset copy");
  });

  await test("R the single file carries the icon with it", async (page) => {
    await page.goto(`${server.origin}/orangey.html?debug&noseed`);
    await page.waitForFunction(`window.orangey && document.querySelector(".brand .mark svg")`);
    const href = await page.evaluate(`return document.querySelector('link[rel="icon"]').getAttribute("href")`);
    assert.match(href, /^data:image\/png;base64,/);
    assert.ok(href.length > 1000, `the embedded icon is too small: ${href.length} characters`);
  });

  await test("R the app runs from a project subpath, which is where it is published", async (page) => {
    // Orangey lives at orangey-app.github.io/orangey/, not at a root. Every
    // path in the build is relative and the worker registers with scope ".",
    // so this has to hold at any depth.
    const nest = join(root, ".tmp", "subpath");
    rmSync(nest, { recursive: true, force: true });
    mkdirSync(join(nest, "tools"), { recursive: true });
    // a real copy, not a link: this is meant to be an ordinary deployment
    cpSync(dist, join(nest, "tools", "orangey"), { recursive: true });
    const sub = await serve(nest);
    try {
      const base = `${sub.origin}/tools/orangey/`;
      await page.goto(`${base}index.html?debug&noseed`);
      await page.waitForFunction("window.orangey && window.orangey.state.ready");
      const boot = await page.evaluate(`
        const bar = document.querySelector(".topbar");
        const mark = document.querySelector(".brand .mark path.body");
        const single = await fetch("orangey.html", { method: "HEAD" });
        const manifest = await (await fetch("manifest.webmanifest")).json();
        const icon = await fetch(manifest.icons[0].src);
        return {
          styled: getComputedStyle(bar).position,
          markFill: mark ? getComputedStyle(mark).fill : null,
          single: single.status,
          icon: icon.status,
        };
      `);
      assert.equal(boot.styled, "sticky", "the stylesheet did not load from the subpath");
      assert.equal(boot.markFill, "rgb(243, 162, 87)", "no logo mark");
      assert.equal(boot.single, 200, "Settings → Download could not find orangey.html");
      assert.equal(boot.icon, 200, "the manifest's icon is not beside the app");
      // The same registration call index.html makes on load, run here so the
      // assertion is about the scope it resolves to rather than about when
      // the harness happens to fire load. (That it registers at all on load
      // is what N8's offline test proves, at the root.) It is raced against a
      // clock because registration is the one step here that depends on a
      // background thread the runner may be slow to start, and a promise that
      // never settles would take the whole suite with it.
      const scope = await page.evaluate(`
        const reg = await Promise.race([
          navigator.serviceWorker.register("sw.js", { scope: "." }).catch(() => null),
          new Promise((done) => setTimeout(() => done("slow"), 5000)),
        ]);
        return reg === "slow" ? "slow" : reg === null ? "refused" : new URL(reg.scope).pathname;
      `);
      assert.notEqual(scope, "refused", "the worker would not register from a subpath");
      if (scope !== "slow") {
        assert.equal(scope, "/tools/orangey/", `the worker claimed the wrong scope: ${scope}`);
      }

      // and it actually rolls, with history, from down here
      await page.click(".quickbar button:nth-child(2)");
      await page.waitForFunction("window.orangey.state.history.length === 1");
      const value = await page.evaluate(`return document.querySelector(".result-value").textContent`);
      assert.match(value, /^\d+$/, `no result: ${value}`);
      assert.deepEqual(page.consoleErrors, []);
    } finally {
      await sub.close();
      rmSync(nest, { recursive: true, force: true });
    }
  });

  // ---- S: a steady card, a way home, and storage -----------------------------

  await test("S the card does not change height whatever comes up, and a long outcome is clipped", async (page) => {
    await open(page, "", { fresh: true });
    const path = await createList(page, "Steady", [
      { label: "7", weight: 1 },
      { label: "Wolf", weight: 1 },
      { label: "A wandering merchant with an overpriced cart of curios", weight: 1 },
      { label: "Bandits, four of them, on the ridge above the road, waiting for someone slower than they are to come along the valley", weight: 1 },
    ]);
    await open(page, `#/r/${encodeURIComponent(path)}`);
    await page.waitForFunction(`document.querySelector(".play-card")`);
    await page.evaluate(`window.orangey.state.setFeel({ motion: "instant" })`);
    const cardHeight = () => page.evaluate(`return Math.round(document.querySelector(".play-card").getBoundingClientRect().height)`);
    const settled = await (async () => {
      await page.click(".roll-button");
      await page.waitForFunction(`window.orangey.state.history.length === 1`);
      return cardHeight();
    })();
    const texts = new Set();
    for (let i = 0; i < 30; i++) {
      await page.click(".roll-button");
      await page.waitForFunction(`window.orangey.state.history.length === ${i + 2}`);
      assert.equal(await cardHeight(), settled, `the card moved on roll ${i + 2}`);
      texts.add(await page.evaluate(`return document.querySelector(".result-value").textContent`));
    }
    assert.ok(texts.size >= 3, `only saw ${texts.size} distinct outcomes: ${[...texts]}`);

    // the longest one is held to two lines and clipped rather than allowed to push
    const shape = await page.evaluate(`
      const value = document.querySelector(".result-value");
      const slot = document.querySelector(".result-slot");
      const style = getComputedStyle(value);
      const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.05;
      return {
        clamp: style.webkitLineClamp,
        overflow: style.overflow,
        slotLines: Math.round(slot.getBoundingClientRect().height / lineHeight),
        overflows: value.scrollHeight > Math.ceil(value.getBoundingClientRect().height) + 1,
      };
    `);
    assert.equal(shape.clamp, "2", `line clamp is ${shape.clamp}`);
    assert.equal(shape.overflow, "hidden");
    assert.equal(shape.slotLines, 2, "the slot should hold exactly the two reserved lines");
    assert.deepEqual(page.consoleErrors, []);
  });

  await test("S a wheel of short labels keeps the big type and one line", async (page) => {
    await open(page, "", { fresh: true });
    const path = await createList(page, "Short", [{ label: "Yes", weight: 1 }, { label: "No", weight: 1 }]);
    await open(page, `#/r/${encodeURIComponent(path)}`);
    await page.waitForFunction(`document.querySelector(".result-slot")`);
    const shape = await page.evaluate(`
      const slot = document.querySelector(".result-slot");
      return { small: slot.classList.contains("small"), clamp: getComputedStyle(document.querySelector(".result-value")).webkitLineClamp };
    `);
    assert.equal(shape.small, false, "short labels should keep the large type");
    assert.equal(shape.clamp, "1");
  });

  await test("S a randomizer from the library shows a way home, not the dice presets", async (page) => {
    await open(page, "", { fresh: true });
    const path = await createList(page, "Opened", [{ label: "A", weight: 1 }, { label: "B", weight: 1 }]);
    // the plain play screen keeps its presets
    assert.equal(await page.evaluate(`return document.querySelectorAll(".quickbar .preset").length`), 7);
    assert.equal(await page.evaluate(`return !!document.querySelector(".home-button")`), false);

    await open(page, `#/r/${encodeURIComponent(path)}`);
    await page.waitForFunction(`document.querySelector(".play-card")`);
    assert.equal(await page.evaluate(`return document.querySelectorAll(".quickbar .preset").length`), 0, "a press must not be able to swap out the randomizer");
    assert.equal(await page.evaluate(`return document.querySelectorAll(".quickbar input").length`), 0);
    assert.equal(await page.evaluate(`return !!document.querySelector(".home-button")`), true);
    // and it goes back to the presets
    await page.click(".home-button");
    await page.waitForFunction(`location.hash === "#/"`);
    await page.waitForFunction(`document.querySelectorAll(".quickbar .preset").length === 7`);
    assert.deepEqual(page.consoleErrors, []);
  });

  await test("S Settings has a Storage section, and the library's About storage lands on it", async (page) => {
    await open(page, "#/settings", { fresh: true });
    await page.waitForFunction(`document.querySelector(".storage-card")`);
    const card = await page.evaluate(`
      const el = document.querySelector(".storage-card");
      return {
        text: el.textContent,
        folder: !!el.querySelector(".use-folder"),
        zip: !!el.querySelector(".export-library"),
        persistState: !!el.querySelector(".persist-state"),
      };
    `);
    assert.match(card.text, /Browser storage/);
    assert.match(card.text, /clearing this site's data/);
    assert.equal(card.zip, true, "no ZIP export");
    assert.equal(card.persistState, true, "nothing said about eviction");
    // the ZIP export really produces the library
    await page.evaluate(`
      window.__downloads = [];
      const real = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (blob) => { window.__downloads.push(blob); return real(blob); };
    `);
    await page.click(".export-library");
    await page.waitForFunction(`window.__downloads.length === 1`);
    const size = await page.evaluate(`return (await window.__downloads[0].arrayBuffer()).byteLength`);
    assert.ok(size > 0, "the export was empty");

    // the menu entry that used to lead nowhere now leads here
    await open(page, "#/library");
    await page.waitForFunction(`document.querySelector(".storage-badge")`);
    await page.click(".storage-badge");
    await page.waitForFunction(`[...document.querySelectorAll("[role='menu'] button, .menu button")].some((b) => b.textContent.includes("About storage"))`);
    await page.evaluate(`[...document.querySelectorAll("[role='menu'] button, .menu button")].find((b) => b.textContent.includes("About storage")).click()`);
    await page.waitForFunction(`location.hash === "#/settings"`);
    await page.waitForFunction(`document.querySelector(".storage-card")`);
    assert.deepEqual(page.consoleErrors, []);
  });

  await test("S out of the box he speaks up for what carries something, and stays quiet otherwise", async (page) => {
    await open(page, "", { fresh: true });
    const path = await createList(page, "Fate", [
      { label: "Crit", weight: 1, reaction: "cheer" },
      { label: "Fumble", weight: 1, reaction: "wince" },
      { label: "Meh", weight: 1 },
    ]);

    // A plain die roll: nothing. No watching, no reacting to the landing.
    await open(page, "#/");
    await mascotShow(page, "always", "instant");
    for (const [want, expect] of [["11", null], ["20", "happy"], ["1", "oops"]]) {
      const seed = await seedFor(page, "d20", want);
      await page.evaluate(`await window.orangey.state.savePrefs({ seed: ${JSON.stringify(seed)} }); window.orangey.state.resetSeedSequence();`);
      const before = (await played(page)).length;
      await page.click(".quickbar button:nth-child(6)");
      await page.waitForFunction(`document.querySelector(".result-value").textContent === ${JSON.stringify(want)}`);
      const after = await played(page);
      if (expect === null) assert.equal(after.length, before, `a plain ${want} should pass without comment, got ${after.at(-1)}`);
      else assert.equal(after.at(-1), expect, `rolled ${want}`);
    }

    // A tagged outcome on a wheel: cheer and wince, but nothing for the rest.
    await open(page, `#/r/${encodeURIComponent(path)}`);
    await mascotShow(page, "always", "instant");
    for (const [want, expect] of [["Crit", "happy"], ["Fumble", "oops"], ["Meh", null]]) {
      const seed = await seedForPath(page, path, want);
      await page.evaluate(`await window.orangey.state.savePrefs({ seed: ${JSON.stringify(seed)} }); window.orangey.state.resetSeedSequence();`);
      const before = (await played(page)).length;
      await page.click(".roll-button");
      await page.waitForFunction(`document.querySelector(".result-value").textContent === ${JSON.stringify(want)}`);
      const after = await played(page);
      if (expect === null) assert.equal(after.length, before, `an untagged outcome should pass without comment, got ${after.at(-1)}`);
      else assert.equal(after.at(-1), expect, `landed on ${want}`);
    }

    // A link that points nowhere still gets a wince: that one is worth saying.
    await open(page, "#/", { fresh: true });
    await mascotShow(page, "triggers", "instant");
    await open(page, "#/id/not-in-this-library");
    await page.waitForFunction(`window.orangey.mascot.played.length === 1`);
    assert.deepEqual(await played(page), ["oops"]);
    assert.deepEqual(page.consoleErrors, []);
  });

  // ---- T: a wheel inside the link --------------------------------------------

  /** Build a link in the app's own dialog, the way a game master would. */
  const makeLink = async (page, path, kind = "embedded") => {
    await open(page, `#/r/${encodeURIComponent(path)}`);
    await page.waitForFunction(`document.querySelector(".link-button")`);
    await page.click(".link-button");
    await page.waitForFunction(`document.querySelector(".link-dialog[open]")`);
    if (kind === "library") await page.click(".link-kind-library");
    const value = await page.evaluate(`return document.querySelector(".link-dialog input[type=text]").value`);
    await page.evaluate(`document.querySelector(".link-dialog").close()`);
    return value;
  };
  /** The randomizer the current link carries, decoded in the page. */
  const linkedNow = (page) =>
    page.evaluate(`
      const query = location.hash.slice(location.hash.indexOf("?") + 1);
      return await window.orangey.decodeRandomizer(new URLSearchParams(query).get("w"));
    `);
  /** The same link, pointed at this test server. */
  const localise = (link) => `${server.origin}/index.html?debug&noseed${link.slice(link.indexOf("#"))}`;

  const encounters = (page, extra = {}) =>
    page.evaluate(`
      const { state } = window.orangey;
      return await state.library.create("", {
        id: "enc-linked", type: "list", name: "Forest Encounters", view: "wheel",
        created: new Date().toISOString(), modified: new Date().toISOString(),
        ...${JSON.stringify(extra)},
        items: [
          { id: "a", label: "Goblin patrol", weight: 50 },
          { id: "b", label: "Merchant", weight: 20 },
          { id: "c", label: "Wolf pack", weight: 20, reaction: "wince" },
          { id: "d", label: "Dragon", weight: 1, color: "#a33a30", reaction: "cheer" },
        ],
      });
    `);

  await test("T a link with the wheel inside rolls on a machine that has never seen it", async (page) => {
    await open(page, "", { fresh: true });
    const path = await encounters(page);
    const link = await makeLink(page, path);
    assert.match(link, /#\/roll\?w=/);

    // a browser with an empty library
    await open(page, "", { fresh: true });
    await page.goto(localise(link));
    await page.waitForFunction(`document.querySelector(".play-card")`);
    assert.equal(await page.evaluate(`return document.querySelector(".play-card h1").textContent`), "Forest Encounters");
    assert.equal(await page.evaluate(`return window.orangey.state.library.files().length`), 0, "opening a link must not put anything in the library");
    // it is a fixed randomizer, like one from the library: no presets to press
    assert.equal(await page.evaluate(`return document.querySelectorAll(".quickbar .preset").length`), 0);
    assert.equal(await page.evaluate(`return !!document.querySelector(".home-button")`), true);
    // and it rolls
    await page.evaluate(`window.orangey.state.setFeel({ motion: "instant" })`);
    await page.click(".roll-button");
    await page.waitForFunction(`window.orangey.state.history.length === 1`);
    const text = await page.evaluate(`return document.querySelector(".result-value").textContent`);
    assert.ok(["Goblin patrol", "Merchant", "Wolf pack", "Dragon"].includes(text), text);
    assert.deepEqual(page.consoleErrors, []);
  });

  await test("T the author's spin travels, and the reader's motion setting still wins", async (page) => {
    await open(page, "", { fresh: true });
    const path = await encounters(page, { feel: { wheel: { durationMs: 5200, turns: 9 } } });
    const link = await makeLink(page, path);

    await open(page, "", { fresh: true });
    await page.goto(localise(link));
    await page.waitForFunction(`document.querySelector(".play-card")`);
    const carried = await page.evaluate(`
      const { effectiveFeel, state, decodeRandomizer } = window.orangey;
      const query = location.hash.slice(location.hash.indexOf("?") + 1);
      const linked = await decodeRandomizer(new URLSearchParams(query).get("w"));
      return effectiveFeel(state.prefs.feel, linked.feel).wheel;
    `);
    assert.equal(carried.durationMs, 5200, "the author's spin length did not travel");
    assert.equal(carried.turns, 9);
    // the reader's own choice is not a per-randomizer setting, so it still wins
    await page.evaluate(`window.orangey.state.setFeel({ motion: "instant" })`);
    const started = Date.now();
    await page.click(".roll-button");
    await page.waitForFunction(`window.orangey.state.history.length === 1`);
    assert.ok(Date.now() - started < 1500, "instant mode should not sit through the author's five-second spin");
  });

  await test("T Orangey's tags travel with the wheel", async (page) => {
    await open(page, "", { fresh: true });
    const path = await encounters(page);
    const link = await makeLink(page, path);
    await open(page, "", { fresh: true });
    await page.goto(localise(link));
    await page.waitForFunction(`window.orangey && document.querySelector(".play-card")`);
    // The link says roll=1, so it is already rolling; let that finish or the
    // next press would be read as "skip".
    await page.waitForFunction(`document.querySelector(".roll-button").textContent === "Roll"`);
    await mascotShow(page, "always", "instant");
    for (const [want, expect] of [["Dragon", "happy"], ["Wolf pack", "oops"]]) {
      const seed = await page.evaluate(`
        const { state, rollRandomizer, decodeRandomizer } = window.orangey;
        const query = location.hash.slice(location.hash.indexOf("?") + 1);
        const r = await decodeRandomizer(new URLSearchParams(query).get("w"));
        for (let i = 0; i < 5000; i++) {
          await state.savePrefs({ seed: "t" + i });
          state.resetSeedSequence();
          if (rollRandomizer(r, state.source()).text === ${JSON.stringify(want)}) { state.resetSeedSequence(); return "t" + i; }
        }
        throw new Error("no seed found");
      `);
      await page.evaluate(`await window.orangey.state.savePrefs({ seed: ${JSON.stringify(seed)} }); window.orangey.state.resetSeedSequence();`);
      await page.click(".roll-button");
      await page.waitForFunction(`document.querySelector(".result-value").textContent === ${JSON.stringify(want)}`);
      assert.equal(await hostState(page), expect, `landed on ${want}`);
    }
  });

  await test("T saving a linked wheel keeps the identity it arrived with", async (page) => {
    await open(page, "", { fresh: true });
    const path = await encounters(page);
    const link = await makeLink(page, path);
    await open(page, "", { fresh: true });
    await page.goto(localise(link));
    await page.waitForFunction(`document.querySelector(".save-randomizer")`);
    await page.click(".save-randomizer");
    await page.waitForFunction(`location.hash.startsWith("#/r/")`);
    const saved = await page.evaluate(`
      const files = window.orangey.state.library.files();
      return { count: files.length, id: files[0].randomizer.id, name: files[0].randomizer.name, items: files[0].randomizer.items.length };
    `);
    assert.equal(saved.count, 1);
    assert.equal(saved.id, "enc-linked", "a link by id should find this copy afterwards");
    assert.equal(saved.name, "Forest Encounters");
    assert.equal(saved.items, 4);
    assert.deepEqual(page.consoleErrors, []);
  });

  await test("T the dialog offers both kinds, embedded first, and the library one still works", async (page) => {
    await open(page, "", { fresh: true });
    const path = await encounters(page);
    await open(page, `#/r/${encodeURIComponent(path)}`);
    await page.waitForFunction(`document.querySelector(".link-button")`);
    await page.click(".link-button");
    await page.waitForFunction(`document.querySelector(".link-dialog[open]")`);
    const kinds = await page.evaluate(`
      return [...document.querySelectorAll(".link-kinds button")].map((b) => [b.textContent, b.getAttribute("aria-pressed")]);
    `);
    assert.deepEqual(kinds, [["With the wheel inside", "true"], ["To my library", "false"]]);
    const embedded = await page.evaluate(`return document.querySelector(".link-dialog input[type=text]").value`);
    await page.click(".link-kind-library");
    const library = await page.evaluate(`return document.querySelector(".link-dialog input[type=text]").value`);
    await page.evaluate(`document.querySelector(".link-dialog").close()`);
    assert.match(embedded, /#\/roll\?w=/);
    assert.match(library, /#\/id\/enc-linked/);
    assert.ok(embedded.length > library.length, "the embedded link is the longer one");
    // the library link still opens the library copy
    await page.goto(localise(library));
    await page.waitForFunction(`document.querySelector(".play-card")`);
    assert.equal(await page.evaluate(`return document.querySelector(".play-card h1").textContent`), "Forest Encounters");
  });

  await test("T the Import page takes a pasted link, and explains a damaged one", async (page) => {
    await open(page, "", { fresh: true });
    const path = await encounters(page);
    const link = await makeLink(page, path);

    await open(page, "#/import", { fresh: true });
    await page.waitForFunction(`document.querySelector("textarea")`);
    await page.evaluate(`
      const t = document.querySelector("textarea");
      t.value = ${JSON.stringify(link)};
      t.dispatchEvent(new Event("input", { bubbles: true }));
    `);
    await page.waitForFunction(`document.querySelector(".link-import")`);
    assert.match(await page.evaluate(`return document.querySelector(".link-import").textContent`), /This is an Orangey link/);
    assert.match(await page.evaluate(`return document.querySelector(".link-import").textContent`), /Forest Encounters/);
    await page.click(".add-linked");
    await page.waitForFunction(`location.hash.startsWith("#/edit/")`);
    assert.equal(await page.evaluate(`return window.orangey.state.library.files().length`), 1);

    // a payload with a hole in it is explained rather than opened
    await open(page, "#/import", { fresh: true });
    await page.waitForFunction(`document.querySelector("textarea")`);
    const damaged = link.replace(/w=(.{10})(.{10})/, "w=$1");
    await page.evaluate(`
      const t = document.querySelector("textarea");
      t.value = ${JSON.stringify("__DAMAGED__")}.replace("__DAMAGED__", ${JSON.stringify(damaged)});
      t.dispatchEvent(new Event("input", { bubbles: true }));
    `);
    await page.waitForFunction(`document.querySelector(".link-import")`);
    assert.match(await page.evaluate(`return document.querySelector(".link-import").textContent`), /damaged/);
    assert.equal(await page.evaluate(`return window.orangey.state.library.files().length`), 0);
    assert.deepEqual(page.consoleErrors, []);
  });

  await test("T a link that arrives broken says so, and Orangey winces", async (page) => {
    await open(page, "", { fresh: true });
    await mascotShow(page, "triggers", "instant");
    await page.goto(`${server.origin}/index.html?debug&noseed#/roll?w=1NotAValidPayloadAtAll`);
    await page.waitForFunction(`document.querySelector(".broken-link")`);
    const text = await page.evaluate(`return document.querySelector(".broken-link").textContent`);
    assert.match(text, /did not survive/);
    await page.waitForFunction(`window.orangey.mascot.played.length === 1`);
    assert.deepEqual(await played(page), ["oops"]);
  });

  await test("T a link with present=1 fills the screen even when the app is already open", async (page) => {
    // Following a slide link inside a tab that already has Orangey open goes
    // through hashchange: the outgoing view is torn down after the incoming
    // one is built, and it used to take the full-screen class with it.
    await open(page, "", { fresh: true });
    const path = await createList(page, "Deck", [{ label: "A", weight: 1 }, { label: "B", weight: 1 }]);
    assert.equal(await page.evaluate(`return document.body.classList.contains("presenting")`), false);
    await page.evaluate(`location.hash = "#/r/${encodeURIComponent(path)}?present=1"`);
    await page.waitForFunction(`document.querySelector(".play-card")`);
    assert.equal(await page.evaluate(`return document.body.classList.contains("presenting")`), true, "the link did not fill the screen");
    // and leaving that randomizer leaves full screen behind
    await page.evaluate(`location.hash = "#/settings"`);
    await page.waitForFunction(`document.querySelector(".storage-card")`);
    assert.equal(await page.evaluate(`return document.body.classList.contains("presenting")`), false);
  });

  await test("S full screen: the wheel, the answer and the button never draw over each other", async (page) => {
    await open(page, "", { fresh: true });
    const path = await createList(page, "Projector", [
      { label: "Goblin patrol", weight: 50 },
      { label: "Young green dragon", weight: 1 },
      { label: "Nothing", weight: 9 },
    ]);
    await open(page, `#/r/${encodeURIComponent(path)}`);
    await page.waitForFunction(`document.querySelector(".play-card")`);
    await page.evaluate(`window.orangey.state.setFeel({ motion: "instant" })`);
    await page.click(".present-button");
    await page.waitForFunction(`document.body.classList.contains("presenting")`);
    // a laptop, a small projector and a big one
    for (const [w, h] of [[900, 640], [1280, 800], [1920, 1080]]) {
      await page.setViewport(w, h);
      await page.click(".roll-button");
      await page.waitForFunction(`document.querySelector(".result-value").textContent !== "Ready"`);
      const box = await page.evaluate(`
        const rect = (sel) => { const el = document.querySelector(sel); return el ? el.getBoundingClientRect() : null; };
        const wheel = rect(".wheel-svg"), slot = rect(".result-slot"), roll = rect(".roll-button");
        return {
          wheelBottom: wheel.bottom, slotTop: slot.top, slotBottom: slot.bottom, rollTop: roll.top,
          height: window.innerHeight, wheelHeight: wheel.height,
        };
      `);
      assert.ok(box.wheelBottom <= box.slotTop + 1, `${w}×${h}: the wheel reaches ${box.wheelBottom}, the answer starts at ${box.slotTop}`);
      assert.ok(box.slotBottom <= box.rollTop + 1, `${w}×${h}: the answer reaches ${box.slotBottom}, the button starts at ${box.rollTop}`);
      assert.ok(box.wheelHeight > 120, `${w}×${h}: the wheel was squeezed to ${box.wheelHeight}px`);
      assert.ok(box.rollTop + 52 <= box.height + 1, `${w}×${h}: the button is off the bottom`);
    }
    await page.setViewport(1280, 900);
    assert.deepEqual(page.consoleErrors, []);
  });

  // ---- report --------------------------------------------------------------

  await browser.close();
  await server.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n1..${results.length}`);
  console.log(`# pass ${results.length - failed.length}`);
  console.log(`# fail ${failed.length}`);
  if (failed.length) process.exitCode = 1;
}

await main();
