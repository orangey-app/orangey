/**
 * Browser tests, driving the built app in headless Chromium over CDP.
 *
 * They cover the paths a person actually walks: loading the app, building a
 * randomizer, rolling it, sharing it, and coming back to it later. Anything a
 * unit test can answer on its own is left to tests/unit.
 */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * No single test may hold the suite up: a stuck one fails and is named.
 *
 * The harness's own waits are 15 to 30 seconds and a healthy test takes a few.
 * A slower machine or CI runner raises the limit through the environment.
 */
const TEST_TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS ?? 45000);

async function test(name, fn) {
  // ONLY=AM runs just the tests whose names start with that, while working on one.
  if (process.env.ONLY && !name.startsWith(process.env.ONLY)) return;
  // On CI, print the name first so a hang can be attributed from the log.
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
    await settle(page);
    await page.close().catch(() => {});
  }
}

/**
 * Wait for the page's storage writes to finish.
 *
 * A roll is on screen a moment before its history row is stored; a page closed
 * in between let that row land after the next test had wiped storage. Bounded,
 * because a page that has navigated away has nothing to wait for.
 */
async function settle(page) {
  await Promise.race([
    page.evaluate(`
      if (window.orangey?.storageSettled) {
        await window.orangey.state.library.flush().catch(() => {});
        await window.orangey.storageSettled();
      }
    `).catch(() => {}),
    new Promise((r) => setTimeout(r, 5000)),
  ]);
}

/**
 * Open the app at `hash`. With { fresh: true } the origin's storage is wiped
 * first: tests share one browser, so otherwise one test's library turns up in
 * the next one's assertions. Without it, this reloads and keeps what was stored.
 */
const open = async (page, hash = "", { fresh = false } = {}) => {
  // Let pending writes land first: a bag's draw is stored a moment after it
  // shows, and a reload in that moment brought the bag back one draw fuller.
  await settle(page);
  if (fresh) {
    await page.goto(`${server.origin}/index.html?debug&noseed`);
    // The app writes as it starts up; let that land before wiping, or it
    // lands after the wipe instead.
    await page.waitForFunction("window.orangey");
    await settle(page);
    // Recorded so a test that still finds rows can tell a wipe that did not take
    // from a late write.
    page.wipedAt = Date.now();
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

/**
 * How far the answer's lowest-hanging glyphs would reach past its clip, in
 * pixels (0 or less is fine). Measured with the font's deepest glyphs rather
 * than whatever came up, so the check does not depend on the roll.
 */
const answerOverhang = (page) =>
  page.evaluate(`
    const v = document.querySelector(".result-value");
    const text = [...v.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
    const style = getComputedStyle(v);
    const g = document.createElement("canvas").getContext("2d");
    g.font = style.fontStyle + " " + style.fontWeight + " " + style.fontSize + " " + style.fontFamily;
    // Old-style digits for the dice font, descenders for the text one.
    const deepest = v.closest(".result-panel").classList.contains("is-dice") ? "3457" : "gpyj";
    const m = g.measureText(deepest);
    const range = document.createRange();
    range.selectNodeContents(text);
    const rects = [...range.getClientRects()];
    const baseline = rects[rects.length - 1].top + m.fontBoundingBoxAscent;
    return Math.round((baseline + m.actualBoundingBoxDescent - v.getBoundingClientRect().bottom) * 10) / 10;
  `);

async function main() {
  server = await serve(dist);
  browser = await launch();

  // ---- feature checks ------------------------------------------------------

  await test("the app loads, renders and makes no network requests after load", async (page) => {
    await open(page, "", { fresh: true });
    // data: URLs (the embedded fonts) are not the network, so they are left out
    // of both counts.
    const network = () => page.requests.filter((u) => !u.startsWith("data:"));
    const before = network().length;
    await page.click(".quickbar button");
    await new Promise((r) => setTimeout(r, 600));
    const after = network().length;
    assert.equal(after, before, `new requests: ${network().slice(before).join(", ")}`);
    assert.deepEqual(page.consoleErrors, []);
  });

  await test("a d20 preset rolls a number between 1 and 20", async (page) => {
    await open(page, "", { fresh: true });
    await page.evaluate(`window.orangey.state.setFeel({ motion: "instant" })`);
    await page.click(".quickbar button:nth-child(6)");
    await page.waitForFunction(`document.querySelector(".result-value").textContent !== "Ready"`);
    const value = Number(await page.evaluate(`return document.querySelector(".result-value").textContent`));
    assert.ok(value >= 1 && value <= 20, `got ${value}`);
    // The dice font's old-style 3, 4, 5, 7 and 9 hang below the line; the clip
    // that keeps an answer to its lines must not cut them off.
    await page.evaluate("await document.fonts.ready");
    const overhang = await answerOverhang(page);
    assert.ok(overhang <= 0, `a dice answer's digits reach ${overhang}px past the answer's box`);
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

  // Safari 18, and so every browser on iOS 18, has an origin-private file system
  // that lists but cannot write: there is no createWritable(). Chromium is made
  // to look like that here, and the library must land in IndexedDB and stay there.
  await test("an OPFS that cannot be written to is passed over for IndexedDB", async (page) => {
    await open(page, "", { fresh: true });
    await page.send("Page.addScriptToEvaluateOnNewDocument", {
      // Guarded: the harness passes through about:blank, which is not a
      // secure context and has no file system classes at all.
      source: "if (typeof FileSystemFileHandle !== 'undefined') { delete FileSystemFileHandle.prototype.createWritable; delete FileSystemHandle.prototype.move; }",
    });
    // With the starters this time: seeding is the first write a new library sees.
    await page.goto(`${server.origin}/index.html?debug`);
    await page.waitForFunction("window.orangey && window.orangey.state.ready");
    const kind = await page.evaluate(`return window.orangey.state.library.backend.kind`);
    assert.equal(kind, "idb");
    const seeded = await page.evaluate(`return window.orangey.state.library.files().map((f) => f.randomizer.name)`);
    assert.ok(seeded.includes("Forest Encounters"), `starters were not written: ${seeded.join(", ")}`);
    assert.ok(seeded.includes("Inkblot"), `a fresh library has no inkblot: ${seeded.join(", ")}`);
    await createList(page, "Made on Safari 18", [{ label: "A", weight: 1 }]);
    await page.goto(`${server.origin}/index.html?debug`);
    await page.waitForFunction("window.orangey && window.orangey.state.ready");
    const names = await page.evaluate(`return window.orangey.state.library.files().map((f) => f.randomizer.name)`);
    assert.ok(names.includes("Made on Safari 18"), `the wheel did not survive a reload: ${names.join(", ")}`);
    assert.equal(await page.evaluate(`return window.orangey.state.library.backend.kind`), "idb");
    // The app's write probe must leave nothing where the library tree would show it.
    const stray = await page.evaluate(`
      const root = await navigator.storage.getDirectory();
      const lib = await root.getDirectoryHandle("library");
      const names = [];
      for await (const [name] of lib.entries()) names.push(name);
      return names.filter((n) => !n.startsWith("."));
    `);
    assert.deepEqual(stray, []);
  });

  // An iPad updated to a Safari that can write: the library already in IndexedDB
  // must still be the one shown, not a fresh, empty file system.
  await test("a library already in IndexedDB is kept over an empty OPFS", async (page) => {
    await open(page, "", { fresh: true });
    await page.evaluate(`
      const { IndexedDbBackend } = window.orangey.backends;
      const idb = await IndexedDbBackend.open();
      await idb.write("kept.orangey.json", JSON.stringify({ format: "orangey", version: 1, randomizer: {
        id: "kept", type: "list", name: "Kept", view: "wheel",
        created: new Date().toISOString(), modified: new Date().toISOString(),
        items: [{ id: "i1", label: "A", weight: 1 }] } }));
      idb.close();
    `);
    await open(page);
    assert.equal(await page.evaluate(`return window.orangey.state.library.backend.kind`), "idb");
    const names = await page.evaluate(`return window.orangey.state.library.files().map((f) => f.randomizer.name)`);
    assert.deepEqual(names, ["Kept"]);
  });

  await test("the layout is two-pane on a desktop and tabbed on a phone", async (page) => {
    await open(page, "", { fresh: true });
    await page.setViewport(1280, 900);
    assert.equal(await page.evaluate(`return getComputedStyle(document.querySelector(".side")).display`), "block");
    assert.equal(await page.evaluate(`return getComputedStyle(document.querySelector(".tabbar")).display`), "none");
    // The library scrolls on its own, so a long one cannot lengthen the page and
    // take the randomizer out of view.
    const scroll = await page.evaluate(`
      const { state } = window.orangey;
      const now = new Date().toISOString();
      for (let i = 0; i < 40; i++) {
        await state.library.create("", { id: "long" + i, type: "coin", name: "Coin " + i, faces: ["Heads", "Tails"], created: now, modified: now });
      }
      await new Promise((r) => setTimeout(r, 100));
      const side = document.querySelector(".side");
      return { page: document.documentElement.scrollHeight, window: innerHeight, side: side.scrollHeight > side.clientHeight };
    `);
    assert.ok(scroll.page <= scroll.window, `the page grew to ${scroll.page}px with the library`);
    assert.ok(scroll.side, "the library should scroll within its own panel");
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

  await test("the outcome table disables, duplicates, deletes and reorders, and undo restores", async (page) => {
    await open(page, "", { fresh: true });
    const path = await createList(page, "Table", [
      { label: "Goblin", weight: 50 },
      { label: "Orc", weight: 30 },
      { label: "Troll", weight: 20 },
    ]);
    await page.evaluate(`window.orangey.navigate("#/edit/" + encodeURIComponent(${JSON.stringify(path)}))`);
    await page.waitForFunction(`document.querySelectorAll(".outcomes tbody tr").length === 3`);

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

    await page.click(".outcomes tbody tr:nth-child(2) .disable-button");
    await page.waitForFunction(`document.querySelectorAll(".outcomes tbody tr.disabled").length === 0`);
    const percents = await page.evaluate(`return [...document.querySelectorAll(".outcomes tbody .pct")].map((c) => c.textContent)`);
    assert.deepEqual(percents, ["50.0%", "30.0%", "20.0%"]);

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

    // Drag the last row onto the first; the table and the file must agree.
    await page.evaluate(`
      const rows = [...document.querySelectorAll(".outcomes tbody tr")];
      const dt = new DataTransfer();
      rows[3].dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
      rows[0].dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
      rows[0].dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
      rows[3].dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
    `);
    await page.waitForFunction(`document.querySelector(".outcomes tbody tr:nth-child(1) .label-cell input").value === "Troll"`);
    const reordered = await page.evaluate(`return [...document.querySelectorAll(".label-cell input")].map((i) => i.value)`);
    assert.deepEqual(reordered, ["Troll", "Goblin", "Goblin (copy)", "Orc"]);
    const onDisk = await page.evaluate(`
      const { state } = window.orangey;
      await state.library.flush();
      return JSON.parse(await state.library.backend.read(${JSON.stringify(path)})).randomizer.items.map((i) => i.label);
    `);
    assert.deepEqual(onDisk, reordered, "the new order was not saved");
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
    // The dialog opens on the embedded link, which has a test of its own; this one
    // is about the library link.
    await page.click(".link-kind-library");

    const link = await page.evaluate(`return document.querySelector(".link-dialog input[type=text]").value`);
    assert.match(link, /#\/id\/Forest%20Encounters\?roll=1&present=1$/, link);
    assert.ok(!link.includes(".orangey.json"), "a slide link should not depend on the file name");

    await page.evaluate(`
      const boxes = [...document.querySelectorAll(".link-dialog input[type=checkbox]")];
      boxes[1].click();
    `);
    const withoutPresent = await page.evaluate(`return document.querySelector(".link-dialog input[type=text]").value`);
    assert.match(withoutPresent, /\?roll=1$/, withoutPresent);
    await page.evaluate(`document.querySelector(".link-dialog").close()`);

    await page.goto(link);
    await page.waitForFunction("window.orangey");
    assert.equal(await page.evaluate(`return document.body.classList.contains("presenting")`), true);
    const chrome = await page.evaluate(`
      return ["topbar", "side", "tabbar", "quickbar"].map((c) => getComputedStyle(document.querySelector("." + c)).display);
    `);
    assert.deepEqual(chrome, ["none", "none", "none", "none"], "the chrome should be hidden while presenting");
    // Nothing sits above the card, not even an empty chain strip.
    const cardTop = await page.evaluate(`return document.querySelector(".play-card").getBoundingClientRect().top`);
    assert.ok(cardTop < 2, `the full-screen card starts ${cardTop}px down`);
    await page.waitForFunction(`document.querySelector(".result-value").textContent !== "Rolling…"`, 15000);
    const result = await page.evaluate(`return document.querySelector(".result-value").textContent`);
    assert.ok(["Goblin patrol", "Merchant", "Wolf pack"].includes(result), result);
    assert.equal(await page.evaluate(`return window.orangey.state.history.length`), 1);
    await page.evaluate("await document.fonts.ready");
    const overhang = await answerOverhang(page);
    assert.ok(overhang <= 0, `the answer's descenders reach ${overhang}px past its box`);
  });

  await test("a link to something this library does not have explains itself", async (page) => {
    await open(page, "", { fresh: true });
    await open(page, "#/id/not-in-this-library?roll=1");
    const text = await page.evaluate(`return document.querySelector(".main-inner").textContent`);
    assert.match(text, /not stored in this browser/);
    assert.match(text, /not-in-this-library/);
  });

  await test("Escape skips a running roll onto the result that was rolled, and then leaves the full-screen view", async (page) => {
    await open(page, "", { fresh: true });
    const path = await createList(page, "Escapable", [{ label: "A", weight: 1 }, { label: "B", weight: 1 }]);
    const id = await page.evaluate(`return window.orangey.state.library.find(${JSON.stringify(path)}).randomizer.id`);
    await open(page, `#/id/${encodeURIComponent(id)}?present=1`);
    await page.evaluate(`window.orangey.state.setFeel({ motion: "full", wheel: { durationMs: 2500, turns: 4, curve: "standard", settle: "bouncy" } })`);
    assert.equal(await page.evaluate(`return document.body.classList.contains("presenting")`), true);

    await page.click(".roll-button");
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(await page.evaluate(`return document.querySelector(".result-value").textContent`), "Rolling…");
    await page.key("Escape");
    await page.waitForFunction(`document.querySelector(".roll-button").textContent === "Roll"`);
    // The result is decided before the animation, so skipping shows the one
    // history kept rather than a fresh one.
    const skipped = await page.evaluate(`
      return { shown: document.querySelector(".result-value").textContent, recorded: window.orangey.state.history[0].resultText };
    `);
    assert.equal(skipped.shown, skipped.recorded, "the shown result is not the one that was rolled");
    assert.ok(["A", "B"].includes(skipped.shown), skipped.shown);
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

  await test("a randomizer is created, moved, renamed and deleted through the library, and the tree follows", async (page) => {
    await open(page, "#/library", { fresh: true });
    await page.waitForFunction(`document.querySelector(".new-button")`);

    // Creating opens the editor, so go back to the library to watch the tree.
    const newThing = async (kind, name) => {
      await page.click(".new-button");
      await page.waitForFunction(`document.querySelector(".menu")`);
      await page.evaluate(`[...document.querySelectorAll(".menu-item")].find((b) => b.textContent === ${JSON.stringify(kind)}).click()`);
      await page.waitForFunction(`document.querySelector("dialog[open] input[type=text]")`);
      await page.type("dialog[open] input[type=text]", name);
      await page.evaluate(`document.querySelector("dialog[open] form").requestSubmit()`);
    };
    await newThing("Wheel", "Draggable");
    await page.waitForFunction(`location.hash.startsWith("#/edit/")`);
    await open(page, "#/library");
    await page.waitForFunction(`[...document.querySelectorAll(".tree-row")].some((r) => r.textContent.includes("Draggable"))`);
    assert.deepEqual(await page.evaluate(`return window.orangey.state.library.files().map((f) => f.path)`), ["draggable.orangey.json"]);

    await newThing("Folder", "Target");
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
    const fileMenu = async (name, item) => {
      await page.evaluate(`
        [...document.querySelectorAll(".tree-file .icon-button")].find((b) => b.getAttribute("aria-label").includes(${JSON.stringify(name)})).click();
      `);
      await page.waitForFunction(`document.querySelector(".menu")`);
      await page.evaluate(`[...document.querySelectorAll(".menu-item")].find((b) => b.textContent === ${JSON.stringify(item)}).click()`);
    };
    await fileMenu("Draggable", "Rename…");
    await page.waitForFunction(`document.querySelector("dialog[open] input[type=text]")`);
    await page.type("dialog[open] input[type=text]", "Renamed by dialog");
    await page.evaluate(`document.querySelector("dialog[open] form").requestSubmit()`);
    await page.waitForFunction(`window.orangey.state.library.files().some((f) => f.randomizer && f.randomizer.name === "Renamed by dialog")`);

    await fileMenu("Renamed by dialog", "Delete…");
    await page.waitForFunction(`document.querySelector("dialog[open] .danger-primary")`);
    await page.click("dialog[open] .danger-primary");
    await page.waitForFunction(`window.orangey.state.library.files().length === 0`);
    assert.equal(
      await page.evaluate(`return [...document.querySelectorAll(".tree-row")].some((r) => r.textContent.includes("Renamed by dialog"))`),
      false,
      "the deleted randomizer is still in the tree",
    );
    assert.ok(await page.evaluate(`return document.querySelectorAll(".folder-row").length >= 1`), "the folder went with it");

    // Undo restores it at the same path with the same id, so boards and "goes to"
    // links that pointed at it work again.
    await page.evaluate(`[...document.querySelectorAll(".toast button")].find((b) => b.textContent === "Undo").click()`);
    await page.waitForFunction(`window.orangey.state.library.files().length === 1`);
    const restored = await page.evaluate(`
      const f = window.orangey.state.library.files()[0];
      return { path: f.path, name: f.randomizer.name };
    `);
    assert.deepEqual(restored, { path: "Target/renamed-by-dialog.orangey.json", name: "Renamed by dialog" });
    assert.deepEqual(page.consoleErrors, []);
  });

  await test("V the wheel has three settings: spin length, turns, and a roll-back switch", async (page) => {
    await open(page, "#/settings", { fresh: true });
    await page.waitForFunction(`document.querySelector('input[aria-label="Spin length"]')`);
    // The wheel is the first Feel section on the page; the editor wraps the
    // same controls in .feel-card, Settings puts each in a card of its own.
    const wheelSection = `document.querySelectorAll(".feel-section")[0]`;
    const controls = await page.evaluate(`
      const section = ${wheelSection};
      return {
        labels: [...section.querySelectorAll(".field-label")].map((el) => el.textContent),
        windDown: section.textContent.includes("Wind-down"),
        rollBack: Boolean(section.querySelector('input[aria-label="Roll-back"]')),
        checked: section.querySelector('input[aria-label="Roll-back"]').checked,
      };
    `);
    assert.deepEqual(controls.labels, ["Spin length", "Turns", "Roll-back"]);
    assert.equal(controls.windDown, false, "the wind-down choice should be gone");
    assert.equal(controls.checked, true, "the roll-back ships on");

    await page.click('input[aria-label="Roll-back"]');
    await page.waitForFunction(`window.orangey.state.prefs.feel.wheel.settleDegrees === 0`);
    await open(page, "#/settings", { fresh: false });
    await page.waitForFunction(`document.querySelector('input[aria-label="Roll-back"]')`);
    assert.equal(await page.evaluate(`return document.querySelector('input[aria-label="Roll-back"]').checked`), false);
    assert.equal(await page.evaluate(`return window.orangey.state.prefs.feel.wheel.settleDegrees`), 0);

    await page.click('input[aria-label="Roll-back"]');
    await page.waitForFunction(`window.orangey.state.prefs.feel.wheel.settleDegrees > 0`);
    assert.equal(await page.evaluate(`return window.orangey.state.prefs.feel.wheel.settleDegrees`), 11);
    // A curve in a settings file is still honoured; it just has no control.
    await page.evaluate(`window.orangey.state.setFeel({ wheel: { ...window.orangey.state.prefs.feel.wheel, curve: "snappy" } })`);
    assert.equal(await page.evaluate(`return window.orangey.state.prefs.feel.wheel.curve`), "snappy");
    assert.deepEqual(page.consoleErrors, []);
  });

  await test("a randomizer's own Feel settings are saved with it and used when it rolls", async (page) => {
    await open(page, "", { fresh: true });
    const path = await createList(page, "Own feel", [{ label: "A", weight: 1 }, { label: "B", weight: 1 }]);
    await open(page, `#/edit/${encodeURIComponent(path)}`);
    await page.waitForFunction(`document.querySelector(".feel-card input[type=range]")`);
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

  await test("the result stays hidden until the wheel, dice and coin land", async (page) => {
    await open(page, "", { fresh: true });
    const path = await createList(page, "Hidden", [
      { label: "Alpha", weight: 1 },
      { label: "Beta", weight: 1 },
    ]);

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

    // Exploding dice land in throws: the die an explosion adds waits, unseen, until
    // the first throw is down, and the answer waits for the last. Seed "table"
    // makes the first 2d2! a 1 and a 2, and the 2 explodes into a 1, so this is one
    // fixed roll, not a hunt for one.
    await page.evaluate(`
      const { state } = window.orangey;
      await state.savePrefs({ seed: "table" });
      state.resetSeedSequence();
    `);
    const staged = await page.evaluate(`
      const field = document.querySelector('.quickbar input[type="text"]');
      field.focus();
      field.value = "2d2!";
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      const look = () => ({
        dice: document.querySelectorAll(".dice-tray .die").length,
        waiting: document.querySelectorAll(".die-flight.waiting").length,
        down: document.querySelectorAll(".dice-tray .die:not(.rolling)").length,
        panel: document.querySelector(".result-value").textContent,
      });
      // The first throw lands at 1400 ms and the second at 1960 ms.
      await new Promise((r) => setTimeout(r, 300));
      const early = look();
      await new Promise((r) => setTimeout(r, 1350));
      return { early, between: look() };
    `);
    assert.deepEqual(staged.early, { dice: 3, waiting: 1, down: 0, panel: "Rolling…" }, "in the air: the explosion's die waits");
    assert.deepEqual(staged.between, { dice: 3, waiting: 0, down: 2, panel: "Rolling…" }, "first throw down, second in the air");
    await page.waitForFunction(`document.querySelector(".result-value").textContent !== "Rolling…"`);
    assert.equal(await page.evaluate(`return document.querySelector(".result-value").textContent`), "4");
    assert.equal(await page.evaluate(`return [...document.querySelectorAll(".dice-tray .die")].map((d) => d.textContent).join(",")`), "1,2,1");
    assert.equal(await page.evaluate(`return document.querySelectorAll(".die-flight.waiting, .die.rolling").length`), 0);
    // Finish only once the roll's history row is stored, so the write cannot land
    // in a later test's storage.
    await page.evaluate(`
      for (let i = 0; i < 100; i++) {
        const stored = await new Promise((resolve, reject) => {
          const req = indexedDB.open("orangey");
          req.onerror = () => reject(req.error);
          req.onsuccess = () => {
            const db = req.result;
            const count = db.transaction("history").objectStore("history").count();
            count.onsuccess = () => { db.close(); resolve(count.result); };
            count.onerror = () => { db.close(); reject(count.error); };
          };
        });
        if (stored >= 2) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("the 2d2! roll never reached the stored history");
    `);
    await page.evaluate(`await window.orangey.state.savePrefs({ seed: null })`);
  });

  await test("flat is the default, and the dice style setting sticks", async (page) => {
    await open(page, "", { fresh: true });
    assert.equal(await page.evaluate(`return window.orangey.state.prefs.feel.dice.style`), "flat");
    await page.evaluate(`window.orangey.state.setFeel({ motion: "instant" })`);
    await page.click(".quickbar button:nth-child(6)");
    await page.waitForFunction(`document.querySelector(".result-value").textContent !== "Ready"`);
    assert.equal(await page.evaluate(`return document.querySelectorAll(".die-canvas").length`), 0);
    assert.equal(await page.evaluate(`return document.querySelectorAll(".dice-tray .die").length`), 1);

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
    const value = await page.evaluate(`return Number(document.querySelector(".die-value").textContent)`);
    assert.ok(value >= 1 && value <= 20, `got ${value}`);
    // The number sits square in the middle of the face the die came to rest on,
    // even when nothing animated: it is placed from the resting pose, not the
    // starting one.
    const offset = await page.evaluate(`
      const [x, y] = (document.querySelector(".die-value").style.transform.match(/-?[0-9.]+/g) ?? ["NaN", "NaN"]).map(Number);
      return Math.hypot(x, y);
    `);
    // A few pixels either way are the digits' own ink being centred; placing from
    // the wrong pose puts it about 25 px off.
    assert.ok(offset < 8, `the number sits ${offset.toFixed(1)} px from the middle of the die`);

    const type = await page.evaluate(`
      await document.fonts.ready;
      const family = (sel) => getComputedStyle(document.querySelector(sel)).fontFamily;
      return {
        textLoaded: document.fonts.check('16px "Orangey Text"'),
        diceLoaded: document.fonts.check('16px "Orangey Dice"', "0123456789"),
        dieValue: family(".die-value"),
        total: family(".result-panel.is-dice .result-value"),
        brand: family(".brand"),
        body: family("body"),
        button: family("button"),
        caption: family(".die-caption"),
      };
    `);
    assert.equal(type.textLoaded, true, "Arapey did not load");
    assert.equal(type.diceLoaded, true, "Young Serif did not load");
    assert.match(type.dieValue, /^"?Orangey Dice/);
    assert.match(type.total, /^"?Orangey Dice/);
    assert.match(type.brand, /^"?Orangey Text/);
    assert.match(type.body, /^"?Orangey Text/);
    assert.match(type.button, /^"?Orangey Text/);
    assert.match(type.caption, /^"?Orangey Text/);
    const slices = await createList(page, "Slices", [{ label: "A", weight: 1 }, { label: "B", weight: 1 }]);
    await open(page, `#/r/${encodeURIComponent(slices)}`);
    await page.waitForFunction(`document.querySelector(".wheel-label")`);
    const label = await page.evaluate(`return getComputedStyle(document.querySelector(".wheel-label")).fontFamily`);
    assert.ok(!label.includes("Orangey"), `wheel labels are set in ${label}; they belong in the system font`);
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

    await page.evaluate(`
      const { state } = window.orangey;
      state.toggleFavourite(state.library.files()[0].randomizer.id);
    `);
    await open(page, "#/");
    await page.waitForFunction(`document.querySelector(".home-shortcuts:not([hidden]) .shortcut")`);
    const shortcut = await page.evaluate(`return document.querySelector(".home-shortcuts .shortcut").textContent`);
    assert.equal(shortcut, "Forest Encounters");
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

    // The README's "A first run": import the example CSV and create the wheel.
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

    await page.setOffline(true);

    // Set the dragon's weight, disable the merchant, roll.
    await page.type(".outcomes tbody tr:nth-child(5) .weight-cell input", "1");
    await page.click(".outcomes tbody tr:nth-child(2) .disable-button");
    await page.waitForFunction(`document.querySelectorAll(".outcomes tbody tr.disabled").length === 1`);
    await page.evaluate(`window.orangey.state.setFeel({ motion: "instant" })`);
    await page.click(".roll-button");
    await page.waitForFunction(`document.querySelector(".result-value").textContent !== "Try it"`);
    const rolled = await page.evaluate(`return document.querySelector(".result-value").textContent`);
    assert.ok(["Goblin patrol", "Wolf pack", "Nothing", "Young green dragon"].includes(rolled), rolled);
    assert.notEqual(rolled, "Merchant", "a disabled outcome came up");

    // Reload, still offline: it is still there.
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
  // His reactions are unit-tested; here, only that he really appears, and only
  // ever once on the screen.

  /**
   * Show him with every reaction switched on (four ship switched off), since
   * this tests the machinery, not the defaults.
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

  // ---- Q: outcome tags, back, and the settings file -------------------------

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
    await open(page, "#/settings");
    assert.equal(await page.evaluate(`return window.orangey.state.prefs.feel.wheel.durationMs`), 4200);

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

  // ---- R: where the app is published ----------------------------------------

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
      // assertion is about the scope it resolves to, not about when load fires (the
      // offline walkthrough test covers registering on load). Raced against a clock:
      // registration depends on a background thread the runner may be slow to start,
      // and a promise that never settles would hang the suite.
      const scope = await page.evaluate(`
        const reg = await Promise.race([
          navigator.serviceWorker.register("sw.js", { scope: "." }).catch(() => null),
          new Promise((done) => setTimeout(() => done("slow"), 5000)),
        ]);
        return reg === "slow" ? "slow" : reg === null ? "refused" : new URL(reg.scope).pathname;
      `);
      assert.notEqual(scope, "refused", "the worker would not register from a subpath");
      if (scope === "slow") console.log("    (worker slow to start: install and offline reload skipped)");
      else {
        assert.equal(scope, "/tools/orangey/", `the worker claimed the wrong scope: ${scope}`);
        // Registered is not installed: the install fetches every file it caches,
        // "./" included, and one failure throws the whole install away.
        const state = await page.evaluate(`
          const reg = await navigator.serviceWorker.getRegistration(".");
          const deadline = Date.now() + 10000;
          while (Date.now() < deadline) {
            if (reg.active && reg.active.state === "activated") return "activated";
            if (!reg.installing && !reg.waiting && !reg.active) return "failed";
            await new Promise((r) => setTimeout(r, 50));
          }
          return "timeout";
        `);
        assert.equal(state, "activated", "the worker registered from the subpath but never installed");
        // And it is what opens the app with the network gone.
        await page.setOffline(true);
        try {
          await page.goto(`${base}index.html?debug&noseed`);
          await page.waitForFunction("window.orangey && window.orangey.state.ready");
        } finally {
          await page.setOffline(false);
        }
      }

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

  await test("R the worker clears only its own old caches, so an app beside it stays offline", async (page) => {
    // The Cache API belongs to the whole site, and Sekwe is published beside
    // Orangey on it. A worker that cleared every cache but its own would wipe
    // Sekwe's offline copy on each Orangey update.
    const nest = join(root, ".tmp", "neighbour");
    rmSync(nest, { recursive: true, force: true });
    mkdirSync(nest, { recursive: true });
    // Where it is published: in a folder of its own, beside the neighbour.
    cpSync(dist, join(nest, "orangey"), { recursive: true });
    const sub = await serve(nest);
    try {
      // Not the app's page: it registers the worker on load, which would clean
      // up before the caches below exist. A blank page on the same site registers
      // nothing (and page.goto would wait for the app, so navigate directly).
      writeFileSync(join(nest, "blank.html"), "<!doctype html><title>blank</title>");
      const loaded = page.waitFor("Page.loadEventFired");
      await page.send("Page.navigate", { url: `${sub.origin}/blank.html` });
      await loaded;
      const keys = await page.evaluate(`
        await caches.open("orangey-v0.0.0-00000000");
        await caches.open("workbox-precache-v2-sekwe");
        await caches.open("sekwe-journal");
        const reg = await navigator.serviceWorker.register("/orangey/sw.js", { scope: "/orangey/" }).catch(() => null);
        if (!reg) return "refused";
        // Raced against a clock, like the subpath test: a runner slow to start
        // the worker thread must not hang the suite.
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const w = reg.active;
          if (w && w.state === "activated") return (await caches.keys()).sort();
          await new Promise((r) => setTimeout(r, 50));
        }
        return "slow";
      `);
      assert.notEqual(keys, "refused", "the worker would not register");
      if (keys === "slow") console.log("    (worker slow to start: cache check skipped)");
      else {
        assert.ok(!keys.includes("orangey-v0.0.0-00000000"), `Orangey's old cache survived: ${keys}`);
        assert.ok(keys.includes("workbox-precache-v2-sekwe"), `a neighbour's cache was deleted: ${keys}`);
        assert.ok(keys.includes("sekwe-journal"), `a neighbour's cache was deleted: ${keys}`);
        assert.equal(keys.filter((k) => k.startsWith("orangey-v")).length, 1, `expected exactly Orangey's current cache: ${keys}`);
      }
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

  await test("S a randomizer from the library shows a way home, not the dice presets", async (page) => {
    await open(page, "", { fresh: true });
    const path = await createList(page, "Opened", [{ label: "A", weight: 1 }, { label: "B", weight: 1 }]);
    assert.equal(await page.evaluate(`return document.querySelectorAll(".quickbar .preset").length`), 7);
    assert.equal(await page.evaluate(`return !!document.querySelector(".home-button")`), false);

    await open(page, `#/r/${encodeURIComponent(path)}`);
    await page.waitForFunction(`document.querySelector(".play-card")`);
    assert.equal(await page.evaluate(`return document.querySelectorAll(".quickbar .preset").length`), 0, "a press must not be able to swap out the randomizer");
    assert.equal(await page.evaluate(`return document.querySelectorAll(".quickbar input").length`), 0);
    assert.equal(await page.evaluate(`return !!document.querySelector(".home-button")`), true);
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
    // Chrome has a folder picker, so it is told nothing extra. Take the picker away
    // and pretend to be an iPhone tab: the card says what to do instead, without
    // suggesting Chrome or Edge, which cannot help on an iPhone.
    assert.equal(await page.evaluate(`return document.querySelector(".storage-advice")`), null);
    await page.evaluate(`
      Object.defineProperty(window, "showDirectoryPicker", { value: undefined, configurable: true });
      Object.defineProperty(navigator, "standalone", { value: false, configurable: true });
      window.orangey.navigate("#/history");
    `);
    await page.waitForFunction(`location.hash === "#/history"`);
    await page.evaluate(`window.orangey.navigate("#/settings")`);
    await page.waitForFunction(`document.querySelector(".storage-advice")`);
    const advice = await page.evaluate(`return document.querySelector(".storage-advice").textContent`);
    assert.match(advice, /Add Orangey to your Home Screen/);
    assert.doesNotMatch(advice, /Chrome and Edge/);
    await page.evaluate(`
      window.__downloads = [];
      const real = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (blob) => { window.__downloads.push(blob); return real(blob); };
    `);
    await page.click(".export-library");
    await page.waitForFunction(`window.__downloads.length === 1`);
    const size = await page.evaluate(`return (await window.__downloads[0].arrayBuffer()).byteLength`);
    assert.ok(size > 0, "the export was empty");

    await open(page, "#/library");
    await page.waitForFunction(`document.querySelector(".storage-badge")`);
    await page.click(".storage-badge");
    await page.waitForFunction(`[...document.querySelectorAll("[role='menu'] button, .menu button")].some((b) => b.textContent.includes("About storage"))`);
    await page.evaluate(`[...document.querySelectorAll("[role='menu'] button, .menu button")].find((b) => b.textContent.includes("About storage")).click()`);
    await page.waitForFunction(`location.hash === "#/settings"`);
    await page.waitForFunction(`document.querySelector(".storage-card")`);
    assert.deepEqual(page.consoleErrors, []);
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
  /**
   * A link from the dialog carries roll=1, so the linked wheel rolls by itself
   * one animation frame after it appears. Wait until that roll has landed, or
   * a test's own press can arrive first and make two rolls (or skip this one).
   */
  const autoRollLanded = (page) =>
    page.waitForFunction(
      `window.orangey.state.history.length === 1 && document.querySelector(".roll-button").textContent === "Roll"`,
    );
  /** The same link, pointed at this test server. */
  const localise = (link) => `${server.origin}/index.html?debug&noseed${link.slice(link.indexOf("#"))}`;

  /** The wheel these tests share: four outcomes, two of them tagged. */
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
    assert.equal(await page.evaluate(`return document.querySelectorAll(".quickbar .preset").length`), 0);
    assert.equal(await page.evaluate(`return !!document.querySelector(".home-button")`), true);
    assert.match(link, /[?&]roll=1(&|$)/);
    await page.evaluate(`window.orangey.state.setFeel({ motion: "instant" })`);
    await autoRollLanded(page);
    await page.click(".roll-button");
    await page.waitForFunction(`window.orangey.state.history.length === 2`);
    const text = await page.evaluate(`return document.querySelector(".result-value").textContent`);
    assert.ok(["Goblin patrol", "Merchant", "Wolf pack", "Dragon"].includes(text), text);
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
    // Following a slide link in a tab that already has Orangey open goes through
    // hashchange: the outgoing view is torn down after the incoming one is built,
    // and must not take the full-screen class with it.
    await open(page, "", { fresh: true });
    const path = await createList(page, "Deck", [{ label: "A", weight: 1 }, { label: "B", weight: 1 }]);
    assert.equal(await page.evaluate(`return document.body.classList.contains("presenting")`), false);
    await page.evaluate(`location.hash = "#/r/${encodeURIComponent(path)}?present=1"`);
    await page.waitForFunction(`document.querySelector(".play-card")`);
    assert.equal(await page.evaluate(`return document.body.classList.contains("presenting")`), true, "the link did not fill the screen");
    await page.evaluate(`location.hash = "#/settings"`);
    await page.waitForFunction(`document.querySelector(".storage-card")`);
    assert.equal(await page.evaluate(`return document.body.classList.contains("presenting")`), false);
  });

  // ---- U: labels along the radius, the pointer on the right ----------------

  await test("U the slice under the pointer is the answer, and its label arrives the right way up", async (page) => {
    await open(page, "", { fresh: true });
    const labels = ["Goblin patrol", "Wolf pack", "Merchant", "Nothing", "Bandits", "Owlbear", "Young green dragon"];
    const path = await createList(page, "Pointer", labels.map((label, i) => ({ label, weight: [30, 20, 15, 12, 10, 8, 5][i] })));
    await open(page, `#/r/${encodeURIComponent(path)}`);
    await page.waitForFunction(`document.querySelector(".wheel-pointer")`);
    await page.evaluate(`window.orangey.state.setFeel({ motion: "instant" })`);
    for (let k = 0; k < 25; k++) {
      await page.click(".roll-button");
      await page.waitForFunction(`window.orangey.state.history.length === ${k + 1}`);
      const seen = await page.evaluate(`
        const pointer = document.querySelector(".wheel-pointer").getBoundingClientRect();
        const svg = document.querySelector(".wheel-svg").getBoundingClientRect();
        const tip = { x: pointer.left, y: pointer.top + pointer.height / 2 };
        const under = document.elementFromPoint(tip.x - 6, tip.y);
        const index = under && under.getAttribute("data-index");
        const label = document.querySelector('.wheel-label[data-index="' + index + '"]');
        const m = label.getScreenCTM();
        const end = new DOMPoint(Number(label.getAttribute("x")), Number(label.getAttribute("y"))).matrixTransform(m);
        return {
          result: document.querySelector(".result-value").textContent,
          index: Number(index),
          lean: (Math.atan2(m.b, m.a) * 180) / Math.PI,
          endX: end.x, tipX: tip.x,
          pointerRight: pointer.right, svgRight: svg.right, pointerMidY: tip.y, svgMidY: svg.top + svg.height / 2,
        };
      `);
      assert.equal(labels[seen.index], seen.result, `roll ${k}: the pointer shows ${labels[seen.index]}, the answer is ${seen.result}`);
      assert.ok(Math.abs(seen.lean) <= 75.5, `roll ${k}: ${seen.result}'s label leans ${seen.lean.toFixed(1)}°`);
      assert.ok(seen.endX < seen.tipX, `roll ${k}: the label ends at ${seen.endX}, under the pointer's tip at ${seen.tipX}`);
      assert.ok(Math.abs(seen.pointerMidY - seen.svgMidY) < 1 && seen.svgRight - seen.pointerRight < 4, "the pointer is not at three o'clock");
    }
    assert.deepEqual(page.consoleErrors, []);
  });

  await test("U labels fit their slice as the browser draws them, up to 48 outcomes", async (page) => {
    await open(page, "", { fresh: true });
    for (const n of [2, 6, 12, 32, 48]) {
      const items = Array.from({ length: n }, (_, i) => ({ label: `The lost travellers of the old road, number ${i + 1}`, weight: 1 }));
      const path = await createList(page, `Fit ${n}`, items);
      await open(page, `#/r/${encodeURIComponent(path)}`);
      await page.waitForFunction(`document.querySelector(".wheel-svg")`);
      const drawn = await page.evaluate(`
        const size = document.querySelector(".wheel-svg").viewBox.baseVal.width;
        return { size, labels: [...document.querySelectorAll(".wheel-label")].map((el) => ({
          text: el.textContent, length: el.getComputedTextLength(), font: Number(el.getAttribute("font-size")),
        })) };
      `);
      assert.equal(drawn.labels.length, n, `${n} outcomes: ${drawn.labels.length} labels`);
      // The component's own numbers: labels end 25 short of the centre-to-edge
      // distance, the hub is 16 with a margin of 6, and a line needs 1.15 em.
      const end = drawn.size / 2 - 25;
      const span = 360 / n - 0.4;
      for (const label of drawn.labels) {
        const inner = Math.max(22, (1.15 * label.font) / (2 * Math.sin((Math.min(span, 180) * Math.PI) / 360)));
        assert.ok(label.length <= end - inner + 0.5, `${n} outcomes: "${label.text}" is ${label.length.toFixed(1)} long, room ${(end - inner).toFixed(1)}`);
        assert.ok(label.text.endsWith("…"), `${n} outcomes: "${label.text}" should have been cut`);
        assert.ok(label.text.length >= 7, `${n} outcomes: only "${label.text}" fits`);
      }
    }
    assert.deepEqual(page.consoleErrors, []);
  });

  await test("W the single file works when opened from disk, and keeps its library", async (page) => {
    await page.goto(`file://${join(dist, "orangey.html")}?debug&noseed`);
    await page.waitForFunction("window.orangey");
    const backend = await page.evaluate(`return window.orangey.state.library.backend.kind`);
    // A page opened from disk gets no OPFS; it must fall back to IndexedDB, never
    // to memory, or a new wheel would vanish on reload.
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

  // ---- X: boards --------------------------------------------------------

  /** A board holding the randomizers with these ids, saved in the library. */
  const createBoard = (page, name, ids) =>
    page.evaluate(`
      const { state } = window.orangey;
      const now = new Date().toISOString();
      const entries = ${JSON.stringify(ids)}.map((id) => ({ id, name: state.library.findById(id).randomizer.name }));
      return await state.library.create("", { id: ${JSON.stringify(name)}, type: "board", name: ${JSON.stringify(name)},
        created: now, modified: now, entries });
    `);

  await test("X a board rolls everything on it, and each cell keeps its own answer", async (page) => {
    await open(page, "", { fresh: true });
    const wheel = await createList(page, "Encounters", [{ label: "Goblins", weight: 1 }, { label: "Nothing", weight: 1 }]);
    const other = await createList(page, "Weather", [{ label: "Rain", weight: 1 }, { label: "Sun", weight: 1 }]);
    const ids = await page.evaluate(`
      const { state } = window.orangey;
      return [${JSON.stringify(wheel)}, ${JSON.stringify(other)}].map((p) => state.library.find(p).randomizer.id);
    `);
    const path = await createBoard(page, "Tonight", ids);

    await open(page, `#/r/${encodeURIComponent(path)}`);
    await page.waitForFunction(`document.querySelectorAll(".cell-holder").length === 2`);
    await page.evaluate(`window.orangey.state.setFeel({ motion: "instant" })`);
    await page.click(".roll-all");
    await page.waitForFunction(`window.orangey.state.history.length === 2`);
    const shown = await page.evaluate(`return [...document.querySelectorAll(".cell .result-value")].map((el) => el.textContent)`);
    assert.ok(["Goblins", "Nothing"].includes(shown[0]), `first cell shows ${shown[0]}`);
    assert.ok(["Rain", "Sun"].includes(shown[1]), `second cell shows ${shown[1]}`);
    const names = await page.evaluate(`return window.orangey.state.history.map((h) => h.randomizerName).sort()`);
    assert.deepEqual(names, ["Encounters", "Weather"]);

    await page.click(".present-button");
    await page.waitForFunction(`document.body.classList.contains("presenting")`);
    const fill = await page.evaluate(`return document.querySelector(".board").getBoundingClientRect().width / innerWidth`);
    assert.ok(fill > 0.95, `the board is ${Math.round(fill * 100)}% of the window's width`);
    const cellsInRow = await page.evaluate(`return new Set([...document.querySelectorAll(".cell-holder")].map((c) => Math.round(c.getBoundingClientRect().top))).size`);
    assert.equal(cellsInRow, 1, "two cells fit side by side on a desktop screen");
    assert.ok(await page.evaluate(`return document.querySelector(".leave-presenting").getBoundingClientRect().width > 0`), "Leave full screen is not visible");
    await page.click(".leave-presenting");
    await page.waitForFunction(`!document.body.classList.contains("presenting")`);

    const before = shown[1];
    // A wheel rolls from its hub; a click on a slice does nothing (a
    // double-tap there edits the slice's weight).
    await page.evaluate(`document.querySelectorAll(".cell-holder")[0].querySelector(".wheel-rotor path").dispatchEvent(new MouseEvent("click", { bubbles: true }))`);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(await page.evaluate(`return window.orangey.state.history.length`), 2, "a click on a slice rolled the wheel");
    await page.evaluate(`document.querySelectorAll(".cell-holder")[0].querySelector(".wheel-hub").dispatchEvent(new MouseEvent("click", { bubbles: true }))`);
    await page.waitForFunction(`window.orangey.state.history.length === 3`);
    const after = await page.evaluate(`return [...document.querySelectorAll(".cell .result-value")].map((el) => el.textContent)`);
    assert.equal(after[1], before, "rolling one cell should not disturb the others");

    // An outcome's link is followed from a cell's own Roll (here a list shown as a
    // list), and what it opens sits right after it and waits. Roll all closes it.
    await createList(page, "Hoard", [{ label: "Gold", weight: 1 }]);
    await createList(page, "Ambush", [{ label: "Wolves", weight: 1, goesTo: "Hoard" }], "list");
    const chained = await createBoard(page, "Chains", ["Ambush"]);
    await open(page, `#/r/${encodeURIComponent(chained)}`);
    await page.waitForFunction(`document.querySelectorAll(".cell-holder").length === 1`);
    await page.click(".cell-roll");
    await page.waitForFunction(`document.querySelector(".board-chain")`);
    assert.equal(await page.evaluate(`return document.querySelector(".cell-holder").nextElementSibling.querySelector(".cell-name").textContent`), "Hoard");
    assert.equal(await page.evaluate(`return document.querySelector(".board-chain .result-value").textContent`), "Ready");
    await page.click(".board-chain .chain-roll");
    await page.waitForFunction(`document.querySelector(".board-chain .result-value").textContent === "Gold"`);
    await page.click(".roll-all");
    await page.waitForFunction(`!document.querySelector(".board-chain")`);
    const kept = await page.evaluate(`
      const { state } = window.orangey;
      await state.library.flush();
      return JSON.parse(await state.library.backend.read(${JSON.stringify(chained)})).randomizer.entries.length;
    `);
    assert.equal(kept, 1, "a chain is not saved onto the board");
    assert.deepEqual(page.consoleErrors, []);
  });

  await test("X randomizers go on and come off a board, and a deleted one is named", async (page) => {
    await open(page, "", { fresh: true });
    const listPath = await createList(page, "Encounters", [{ label: "Goblins", weight: 1 }, { label: "Nothing", weight: 1 }]);
    const id = await page.evaluate(`return window.orangey.state.library.find(${JSON.stringify(listPath)}).randomizer.id`);
    const path = await createBoard(page, "Tonight", []);
    await open(page, `#/r/${encodeURIComponent(path)}`);
    await page.waitForFunction(`document.querySelector(".add-to-board")`);

    await page.click(".add-to-board");
    await page.waitForFunction(`document.querySelector(".picker-dialog[open]")`);
    await page.click(".picker-choice");
    await page.waitForFunction(`document.querySelectorAll(".cell-holder").length === 1`);
    const saved = await page.evaluate(`
      const { state } = window.orangey;
      await state.library.flush();
      return JSON.parse(await state.library.backend.read(${JSON.stringify(path)})).randomizer.entries;
    `);
    assert.deepEqual(saved, [{ id, name: "Encounters" }], "the board should be saved with what was added");

    await page.evaluate(`await window.orangey.state.library.remove(${JSON.stringify(listPath)})`);
    await open(page, `#/r/${encodeURIComponent(path)}`);
    await page.waitForFunction(`document.querySelector(".cell-missing")`);
    const text = await page.evaluate(`return document.querySelector(".cell-missing").textContent`);
    assert.match(text, /Encounters/);
    assert.match(text, /not in your library/);

    // A board with something on it opens in play mode, where a stray click cannot
    // take anything off; Edit board brings out the ✕s, and Undo puts back what one
    // took.
    const visible = (sel) => page.evaluate(`const e = document.querySelector(${JSON.stringify(sel)}); return !!e && e.offsetParent !== null`);
    assert.equal(await visible(".cell-holder > .cell-remove"), false, "no ✕ in play mode");
    assert.equal(await visible(".add-to-board"), false, "no Add… in play mode");
    await page.click(".edit-board");
    await page.waitForFunction(`document.querySelector(".cell-holder > .cell-remove").offsetParent !== null`);
    await page.click(".cell-remove");
    await page.waitForFunction(`document.querySelectorAll(".cell-holder").length === 0`);
    await page.evaluate(`[...document.querySelectorAll(".toast button")].find((b) => b.textContent === "Undo").click()`);
    await page.waitForFunction(`document.querySelectorAll(".cell-holder").length === 1`);
    await page.click(".cell-remove");
    await page.waitForFunction(`document.querySelectorAll(".cell-holder").length === 0`);
    assert.deepEqual(page.consoleErrors, []);
  });

  await test("X a board is shared as a file, with a link that opens it in this library", async (page) => {
    await open(page, "", { fresh: true });
    const listPath = await createList(page, "Encounters", [{ label: "Goblins", weight: 1 }, { label: "Nothing", weight: 1 }]);
    const id = await page.evaluate(`return window.orangey.state.library.find(${JSON.stringify(listPath)}).randomizer.id`);
    const path = await createBoard(page, "Tonight", [id]);
    await open(page, `#/r/${encodeURIComponent(path)}`);
    await page.waitForFunction(`document.querySelector(".share-button")`);
    await page.click(".share-button");
    await page.waitForFunction(`document.querySelector(".share-dialog[open]")`);

    // The link is the library one: a board is several randomizers, so there is
    // no version that carries it inside the address.
    const link = await page.evaluate(`return document.querySelector(".share-dialog input[type=text]").value`);
    assert.match(link, /#\/id\/Tonight/);
    assert.ok(!link.includes("w="), `a board link must not try to carry the board: ${link}`);
    assert.equal(await page.evaluate(`return Boolean(document.querySelector(".export-board"))`), true);
    await page.evaluate(`document.querySelector(".share-dialog").close()`);

    await page.goto(`${server.origin}/index.html?debug&noseed#/id/Tonight`);
    await page.waitForFunction(`document.querySelector(".board-grid")`);
    assert.equal(await page.evaluate(`return document.querySelectorAll(".cell-holder").length`), 1);
    assert.deepEqual(page.consoleErrors, []);
  });

  // ---- Y: an outcome that opens another randomizer ------------------------

  /** A wheel with one outcome that can come up, which may point somewhere. */
  const pointer = (page, name, label, goesTo) =>
    createList(page, name, [
      goesTo ? { label, weight: 1, goesTo } : { label, weight: 1 },
      { label: "Nothing", weight: 0 },
    ]);

  await test("Y an outcome opens the randomizer it points at, and that one waits for its own roll", async (page) => {
    await open(page, "", { fresh: true });
    const hoard = await pointer(page, "Hoard", "Gold");
    const path = await pointer(page, "Encounters", "The dragon's hoard", "Hoard");
    await open(page, `#/r/${encodeURIComponent(path)}`);
    await page.waitForFunction(`document.querySelector(".roll-button")`);
    await page.evaluate(`window.orangey.state.setFeel({ motion: "instant" })`);

    await page.click(".roll-button");
    await page.waitForFunction(`document.querySelector(".chain-link")`);
    assert.equal(await page.evaluate(`return document.querySelector(".chain-link .cell-name").textContent`), "Hoard");
    assert.equal(await page.evaluate(`return window.orangey.state.history.length`), 1);
    assert.equal(await page.evaluate(`return document.querySelector(".chain-link .result-value").textContent`), "Ready");
    const beside = await page.evaluate(`
      const card = document.querySelector(".play-card").getBoundingClientRect();
      const opened = document.querySelector(".chain-link").getBoundingClientRect();
      return opened.left >= card.right && opened.width > 100;
    `);
    assert.ok(beside, "the randomizer that opened should sit next to the play card");

    await page.click(".chain-roll");
    await page.waitForFunction(`window.orangey.state.history.length === 2`);
    assert.equal(await page.evaluate(`return document.querySelector(".chain-link .result-value").textContent`), "Gold");
    assert.deepEqual(
      await page.evaluate(`return window.orangey.state.history.map((h) => h.randomizerName)`),
      ["Hoard", "Encounters"],
    );
    assert.deepEqual(
      await page.evaluate(`return window.orangey.state.history.map((h) => h.from ?? null)`),
      [{ randomizerName: "Encounters", label: "The dragon's hoard" }, null],
    );
    // Both rolls were made on this screen, so both belong in its Recent rolls,
    // the chained one included.
    await page.waitForFunction(`document.querySelectorAll(".recent-rolls li").length === 2`);
    assert.deepEqual(
      await page.evaluate(`return [...document.querySelectorAll(".recent-rolls li .name")].map((n) => n.textContent)`),
      ["Hoard", "Encounters"],
    );
    await open(page, "#/history");
    await page.waitForFunction(`[...document.querySelectorAll(".history-list .roll-from")].some((e) => e.textContent === "from Encounters → The dragon's hoard")`);

    await page.evaluate(`await window.orangey.state.library.remove(${JSON.stringify(hoard)})`);
    await open(page, `#/r/${encodeURIComponent(path)}`);
    await page.waitForFunction(`document.querySelector(".roll-button")`);
    await page.evaluate(`window.orangey.state.setFeel({ motion: "instant" })`);
    await page.click(".roll-button");
    await page.waitForFunction(`document.querySelector(".chain-link.cell-missing")`);
    const gap = await page.evaluate(`return document.querySelector(".chain-link.cell-missing").textContent`);
    assert.match(gap, /The dragon's hoard/);
    assert.match(gap, /not in your library/);
    assert.deepEqual(page.consoleErrors, []);
  });

  await test("Y a third randomizer iconizes the first, a chain that circles stops, and the icon comes back", async (page) => {
    await open(page, "", { fresh: true });
    await pointer(page, "Gems", "Back to the forest", "Encounters");
    await pointer(page, "Hoard", "A bag of gems", "Gems");
    const path = await pointer(page, "Encounters", "The dragon's hoard", "Hoard");
    await open(page, `#/r/${encodeURIComponent(path)}`);
    await page.waitForFunction(`document.querySelector(".roll-button")`);
    await page.evaluate(`window.orangey.state.setFeel({ motion: "instant" })`);

    await page.click(".roll-button");
    await page.waitForFunction(`document.querySelectorAll(".chain-link").length === 1`);
    assert.equal(await page.evaluate(`return document.querySelectorAll(".chain-icon").length`), 0);
    assert.equal(await page.evaluate(`return document.querySelector(".play-card").hidden`), false);

    // Hoard opens Gems: three, so Encounters goes to the strip with its answer.
    await page.click(".chain-roll");
    await page.waitForFunction(`document.querySelectorAll(".chain-link").length === 2`);
    const icon = await page.evaluate(`return document.querySelector(".chain-icon").textContent`);
    assert.match(icon, /Encounters/);
    assert.match(icon, /The dragon's hoard/, `the icon should carry the answer it gave: ${icon}`);
    assert.equal(await page.evaluate(`return document.querySelector(".play-card").hidden`), true);

    // Gems points back at Encounters, which is already in this chain.
    await page.evaluate(`document.querySelectorAll(".chain-roll")[1].click()`);
    await page.waitForFunction(`window.orangey.state.history.length === 3`);
    await page.waitForFunction(`!document.querySelector(".chain-note").hidden`);
    assert.match(
      await page.evaluate(`return document.querySelector(".chain-note").textContent`),
      /Encounters is already open here/,
    );
    assert.equal(await page.evaluate(`return document.querySelectorAll(".chain-link").length`), 2, "nothing should have opened a fourth time");

    await page.click(".chain-icon");
    await page.waitForFunction(`!document.querySelector(".play-card").hidden`);
    assert.equal(await page.evaluate(`return document.querySelectorAll(".chain-link").length`), 0);
    assert.equal(await page.evaluate(`return document.querySelectorAll(".chain-icon").length`), 2);
    assert.deepEqual(page.consoleErrors, []);
  });

  // ---- Z: pictures on outcomes -------------------------------------------

  /** A one-pixel PNG is enough: these tests are about layout, not pixels. */
  const ONE_PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  await test("Z a picture shows on the slice and in the answer, and never travels in a link", async (page) => {
    await open(page, "", { fresh: true });
    const path = await page.evaluate(`
      const { state } = window.orangey;
      const now = new Date().toISOString();
      const id = await window.orangey.images.putImageData(${JSON.stringify(ONE_PIXEL)});
      return await state.library.create("", { id: "pics", type: "list", name: "Portraits", view: "wheel",
        created: now, modified: now,
        items: [{ id: "a", label: "Owlbear", weight: 1, image: id }, { id: "b", label: "Nothing", weight: 1 }] });
    `);
    await open(page, `#/r/${encodeURIComponent(path)}`);
    await page.waitForFunction(`document.querySelector(".wheel-svg")`);
    // The picture is drawn one refresh after the wheel: its bytes are read
    // asynchronously, so counting the moment the wheel appears is a race.
    await page.waitForFunction(`document.querySelector(".wheel-rotor image")`);
    const drawn = await page.evaluate(`
      const img = document.querySelector(".wheel-rotor image");
      return { count: document.querySelectorAll(".wheel-rotor image").length, clipped: Boolean(img && img.getAttribute("clip-path")) };
    `);
    assert.equal(drawn.count, 1, "only the outcome with a picture should have one");
    assert.equal(drawn.clipped, true);
    const labelled = () => page.evaluate(`return [...document.querySelectorAll(".wheel-rotor .wheel-label")].map((l) => l.dataset.index)`);
    assert.deepEqual(await labelled(), ["1"], "the pictured slice should carry no name, the other its name");

    await open(page, `#/edit/${encodeURIComponent(path)}`);
    await page.waitForFunction(`document.querySelector(".slices-field") && !document.querySelector(".slices-field").hidden`);
    await page.waitForFunction(`document.querySelector(".wheel-rotor image")`);
    const choose = (name) => page.evaluate(`
      [...document.querySelectorAll(".slices-field button")].find((b) => b.textContent === ${JSON.stringify(name)}).click();
    `);
    const stored = () => page.evaluate(`
      await window.orangey.state.library.flush();
      return JSON.parse(await window.orangey.state.library.backend.read(${JSON.stringify(path)})).randomizer.slices ?? null;
    `);
    await choose("Both");
    await page.waitForFunction(`document.querySelectorAll(".wheel-rotor .wheel-label").length === 2`);
    const apart = await page.evaluate(`
      const svg = document.querySelector(".wheel-svg");
      const c = svg.viewBox.baseVal.width / 2;
      const img = document.querySelector(".wheel-rotor image");
      const side = Number(img.getAttribute("width"));
      const ix = Number(img.getAttribute("x")) + side / 2, iy = Number(img.getAttribute("y")) + side / 2;
      const label = document.querySelector('.wheel-rotor .wheel-label[data-index="0"]');
      const lx = Number(label.getAttribute("x")), ly = Number(label.getAttribute("y"));
      return { nameEnds: Math.hypot(lx - c, ly - c), pictureStarts: Math.hypot(ix - c, iy - c) - side / 2 };
    `);
    assert.ok(apart.nameEnds <= apart.pictureStarts, `the name reaches ${apart.nameEnds}, the picture starts at ${apart.pictureStarts}`);
    assert.equal(await stored(), "both");
    await choose("Names");
    await page.waitForFunction(`!document.querySelector(".wheel-rotor image")`);
    assert.deepEqual(await labelled(), ["0", "1"]);
    assert.equal(await stored(), "names");
    // Back to the default takes the key out of the file again.
    await choose("Pictures");
    await page.waitForFunction(`document.querySelector(".wheel-rotor image")`);
    assert.equal(await stored(), null, "the default should not be written to the file");
    await open(page, `#/r/${encodeURIComponent(path)}`);
    await page.waitForFunction(`document.querySelector(".wheel-rotor image")`);

    assert.equal(await page.evaluate(`return document.querySelector(".result-picture").hidden`), true);
    await page.evaluate(`window.orangey.state.setFeel({ motion: "instant" })`);
    for (let i = 0; i < 40; i++) {
      await page.click(".roll-button");
      await page.waitForFunction(`document.querySelector(".result-value").textContent !== "Ready"`);
      const text = await page.evaluate(`return document.querySelector(".result-value").textContent`);
      const shown = await page.evaluate(`return !document.querySelector(".result-picture").hidden`);
      assert.equal(shown, text === "Owlbear", `${text}: picture ${shown ? "shown" : "hidden"}`);
      if (text === "Owlbear") break;
    }

    // A link carries the wheel but never the picture, which keeps a shared link
    // short enough for a slide.
    const link = await makeLink(page, path);
    // Decode what the link carries. It has a ? before the hash too (?debug), so
    // read the route's query, not the page's.
    const payload = new URLSearchParams(link.slice(link.lastIndexOf("?") + 1)).get("w");
    const carried = await page.evaluate(`return await window.orangey.decodeRandomizer(${JSON.stringify(payload)})`);
    assert.ok(link.length < 2000, `${link.length} characters`);
    assert.deepEqual(carried.items.map((i) => i.image ?? null), [null, null], "a link must not carry pictures");
    assert.deepEqual(carried.items.map((i) => i.label), ["Owlbear", "Nothing"]);
    assert.deepEqual(page.consoleErrors, []);
  });

  await test("Z full screen with a picture: the wheel, the picture, the answer and the button do not overlap", async (page) => {
    await open(page, "", { fresh: true });
    const path = await page.evaluate(`
      const { state } = window.orangey;
      const now = new Date().toISOString();
      const id = await window.orangey.images.putImageData(${JSON.stringify(ONE_PIXEL)});
      return await state.library.create("", { id: "proj", type: "list", name: "Projector", view: "wheel",
        created: now, modified: now,
        items: [{ id: "a", label: "Young green dragon", weight: 1, image: id }, { id: "b", label: "Nothing", weight: 1, image: id }] });
    `);
    await open(page, `#/r/${encodeURIComponent(path)}`);
    await page.waitForFunction(`document.querySelector(".play-card")`);
    await page.evaluate(`window.orangey.state.setFeel({ motion: "instant" })`);
    await page.click(".present-button");
    await page.waitForFunction(`document.body.classList.contains("presenting")`);
    for (const [w, h] of [[900, 640], [1280, 800], [1920, 1080]]) {
      await page.setViewport(w, h);
      await page.click(".roll-button");
      await page.waitForFunction(`document.querySelector(".result-value").textContent !== "Rolling…"`);
      const box = await page.evaluate(`
        const rect = (sel) => { const el = document.querySelector(sel); return el ? el.getBoundingClientRect() : null; };
        const wheel = rect(".wheel-svg"), picture = rect(".result-picture"), slot = rect(".result-slot"), roll = rect(".roll-button");
        return { wheelBottom: wheel.bottom, pictureTop: picture.top, pictureBottom: picture.bottom,
                 slotTop: slot.top, rollTop: roll.top, height: window.innerHeight, wheelHeight: wheel.height };
      `);
      assert.ok(box.wheelBottom <= box.pictureTop + 1, `${w}×${h}: the wheel reaches ${box.wheelBottom}, the picture starts at ${box.pictureTop}`);
      assert.ok(box.pictureBottom <= box.slotTop + 1, `${w}×${h}: the picture reaches ${box.pictureBottom}, the answer starts at ${box.slotTop}`);
      assert.ok(box.rollTop + 52 <= box.height + 1, `${w}×${h}: the button is off the bottom`);
      assert.ok(box.wheelHeight > 100, `${w}×${h}: the wheel was squeezed to ${box.wheelHeight}px`);
    }
    await page.setViewport(1280, 900);
    assert.deepEqual(page.consoleErrors, []);
  });

  // ---- AA: choosing from the library ------------------------------------

  await test("AA an outcome's target is chosen by browsing the library, or by searching it", async (page) => {
    await open(page, "", { fresh: true });
    const target = await createList(page, "Which dragon", [{ label: "Young green", weight: 1 }, { label: "Ancient red", weight: 1 }]);
    const wheel = await createList(page, "Encounters", [{ label: "A dragon!", weight: 1 }, { label: "Nothing", weight: 1 }]);
    await page.evaluate(`await window.orangey.state.library.createFolder("", "Monsters")`);
    await page.evaluate(`await window.orangey.state.library.move(${JSON.stringify(target)}, "Monsters")`);

    await open(page, `#/edit/${encodeURIComponent(wheel)}`);
    await page.waitForFunction(`document.querySelector(".goes-to-button")`);
    assert.equal(await page.evaluate(`return document.querySelector(".goes-to-button").textContent`), "—");
    await page.click(".outcomes tbody tr:first-child .goes-to-button");
    await page.waitForFunction(`document.querySelector(".picker-dialog[open]")`);

    const folders = await page.evaluate(`return [...document.querySelectorAll(".picker-folder")].map((e) => e.textContent.trim())`);
    assert.ok(folders.some((f) => f.includes("Monsters")), `folders: ${folders.join(", ")}`);

    await page.type(".picker-dialog input[type=search]", "dragon");
    // Search matches outcomes as well as names, so the wheel being edited (it has
    // "A dragon!") is listed too, greyed out: pointing at itself would be a circle.
    await page.waitForFunction(`[...document.querySelectorAll(".picker-choice")].some((e) => e.textContent.startsWith("Which dragon"))`);
    const hits = await page.evaluate(`return [...document.querySelectorAll(".picker-choice")].map((e) => [e.textContent, e.disabled])`);
    assert.ok(hits.some(([text]) => text === "Which dragon — Monsters"), `hits: ${JSON.stringify(hits)}`);
    assert.ok(hits.some(([text, disabled]) => text.startsWith("Encounters") && disabled), `the wheel being edited should be greyed: ${JSON.stringify(hits)}`);
    await page.evaluate(`[...document.querySelectorAll(".picker-choice")].find((e) => e.textContent.startsWith("Which dragon")).click()`);

    await page.waitForFunction(`document.querySelector(".goes-to-button").textContent === "Which dragon"`);
    const saved = await page.evaluate(`
      const { state } = window.orangey;
      await state.library.flush();
      const r = JSON.parse(await state.library.backend.read(${JSON.stringify(wheel)})).randomizer;
      return state.library.findById(r.items[0].goesTo)?.randomizer?.name ?? null;
    `);
    assert.equal(saved, "Which dragon");
    assert.deepEqual(page.consoleErrors, []);
  });

  await test("AA right-clicking in the library offers the same menu, with a link to copy", async (page) => {
    await open(page, "", { fresh: true });
    const path = await createList(page, "Encounters", [{ label: "Goblins", weight: 1 }, { label: "Nothing", weight: 1 }]);
    const id = await page.evaluate(`return window.orangey.state.library.find(${JSON.stringify(path)}).randomizer.id`);
    await open(page, "#/library");
    await page.waitForFunction(`document.querySelector(".tree-row")`);
    await page.evaluate(`
      const row = [...document.querySelectorAll(".tree-row")].find((r) => r.textContent.includes("Encounters"));
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    `);
    await page.waitForFunction(`document.querySelector(".menu")`);
    const items = await page.evaluate(`return [...document.querySelectorAll(".menu button")].map((b) => b.textContent.trim())`);
    assert.ok(items.includes("Copy link"), `menu: ${items.join(", ")}`);
    assert.ok(items.includes("Play") && items.includes("Delete…"), "right-click should open the row's own menu, not a second one");

    // The clipboard is not reachable in this harness, so check what is copied:
    // the link by id, which survives renaming and moving.
    const link = await page.evaluate(`
      const { appBase, slideLink } = window.orangey;
      return slideLink(appBase(), ${JSON.stringify(id)}, { roll: false, present: false });
    `);
    assert.match(link, new RegExp(`#/id/${id}$`));
    assert.deepEqual(page.consoleErrors, []);
  });

  await test("AA a board can be given a randomizer that does not exist yet", async (page) => {
    await open(page, "", { fresh: true });
    const path = await createBoard(page, "Tonight", []);
    await open(page, `#/r/${encodeURIComponent(path)}`);
    await page.waitForFunction(`document.querySelector(".add-to-board")`);
    await page.click(".add-to-board");
    await page.waitForFunction(`document.querySelector(".picker-dialog[open]")`);
    await page.evaluate(`[...document.querySelectorAll(".picker-new-button")].find((b) => b.textContent === "New wheel").click()`);
    // The picker is still open behind the name dialog, and it has a text field
    // of its own, so this has to be the newest dialog rather than the first.
    await page.waitForFunction(`[...document.querySelectorAll("dialog[open]")].length === 2`);
    await page.evaluate(`
      const dialog = [...document.querySelectorAll("dialog[open]")].at(-1);
      const input = dialog.querySelector('input[type=text]');
      input.value = "Weather";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      [...dialog.querySelectorAll("button")].find((b) => /create/i.test(b.textContent)).click();
    `);

    await page.waitForFunction(`location.hash.startsWith("#/edit/")`);
    const entries = await page.evaluate(`
      const { state } = window.orangey;
      await state.library.flush();
      return JSON.parse(await state.library.backend.read(${JSON.stringify(path)})).randomizer.entries.map((e) => e.name);
    `);
    assert.deepEqual(entries, ["Weather"]);
    await page.waitForFunction(`!document.querySelector(".topbar .back").hidden`);
    await page.click(".topbar .back");
    await page.waitForFunction(`location.hash === ${JSON.stringify(`#/r/${encodeURIComponent(path)}`)}`);
    await page.waitForFunction(`window.orangey.state.prefs.lastPath === ${JSON.stringify(path)}`);

    const typeNotation = async (text) => {
      await page.waitForFunction(`document.querySelector(".edit-board")`);
      // Adding is an edit; a board with something on it opens in play mode.
      if (await page.evaluate(`return document.querySelector(".add-to-board").hidden`)) await page.click(".edit-board");
      await page.click(".add-to-board");
      await page.waitForFunction(`document.querySelector(".picker-dialog[open] input[type=search]")`);
      await page.evaluate(`
        const search = document.querySelector(".picker-dialog[open] input[type=search]");
        search.value = ${JSON.stringify(text)};
        search.dispatchEvent(new Event("input", { bubbles: true }));
        search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      `);
      await page.waitForFunction(`!document.querySelector(".picker-dialog[open]")`);
    };
    const quickDice = () => page.evaluate(`
      const { state } = window.orangey;
      await state.library.flush();
      return (state.library.find("Dice")?.children ?? []).map((c) => c.randomizer.name);
    `);
    await typeNotation("2D6+3");
    await page.waitForFunction(`document.querySelectorAll(".cell-holder").length === 2`);
    assert.equal(await page.evaluate(`return location.hash`), `#/r/${encodeURIComponent(path)}`);
    assert.deepEqual(await quickDice(), ["2d6 + 3"]);
    const other = await createBoard(page, "Tomorrow", []);
    await open(page, `#/r/${encodeURIComponent(other)}`);
    await typeNotation("2d6 + 3");
    await page.waitForFunction(`document.querySelectorAll(".cell-holder").length === 1`);
    assert.deepEqual(await quickDice(), ["2d6 + 3"]);
    assert.deepEqual(page.consoleErrors, []);
  });

  // ---- AB: bags, hidden rolls and boards of dice ---------------------------

  await test("AB two wireframe dice trays on one board both tumble, and Fate dice land", async (page) => {
    await open(page, "", { fresh: true });
    const dicePath = (name, expression) =>
      page.evaluate(`
        const { state } = window.orangey;
        const now = new Date().toISOString();
        return await state.library.create("", { id: ${JSON.stringify(name)}, type: "dice",
          name: ${JSON.stringify(name)}, expression: ${JSON.stringify(expression)}, created: now, modified: now });
      `);
    await dicePath("Exploding", "3d6!");
    await dicePath("Fate", "4dF");
    const board = await createBoard(page, "Both", ["Exploding", "Fate"]);

    await page.evaluate(`window.orangey.state.setFeel({ dice: { style: "wireframe" } })`);
    await open(page, `#/r/${encodeURIComponent(board)}`);
    await page.waitForFunction(`document.querySelectorAll(".cell-holder").length === 2`);

    await page.click(".roll-all");
    // Both trays must be drawing: every tray on the page shares one animation loop,
    // and one tray starting a roll must not freeze the other's dice.
    await page.waitForFunction(`document.querySelectorAll(".die-canvas").length >= 7`);
    const sample = () => page.evaluate(`
      return [...document.querySelectorAll(".cell")].map((cell) => {
        const c = cell.querySelector("canvas");
        return c ? c.toDataURL().length + ":" + c.toDataURL().slice(-40) : "none";
      });
    `);
    const first = await sample();
    await new Promise((r) => setTimeout(r, 100));
    const second = await sample();
    assert.equal(first.length, 2);
    assert.notDeepEqual(first[0], second[0], "the first tray stopped tumbling");
    assert.notDeepEqual(first[1], second[1], "the second tray stopped tumbling");

    // Wait for the dice themselves to settle: a cell's result panel says
    // "Rolling…" while the tray is still in the air, which is not "Ready" either.
    await page.waitForFunction(`document.querySelectorAll(".die-slot.rolling").length === 0`, 20000);
    // Captions are in the system font: the dice font's old-style 1 and 2
    // are too small to read at caption size.
    const captionFont = await page.evaluate(`return getComputedStyle(document.querySelector(".die-caption")).fontFamily`);
    assert.ok(!captionFont.includes("Orangey Dice"), `die captions are set in ${captionFont}`);
    const faces = await page.evaluate(`
      const cell = [...document.querySelectorAll(".cell")].find((c) => c.textContent.includes("Fate"));
      return [...cell.querySelectorAll(".die-value")].map((v) => v.textContent);
    `);
    assert.equal(faces.length, 4, `the Fate tray showed ${faces.length} dice`);
    for (const f of faces) assert.ok(["+", "0", "−"].includes(f), `unexpected Fate face "${f}"`);
    assert.deepEqual(page.consoleErrors, []);
  });

  await test("AB a bag empties as it is drawn, survives a reload, and refills", async (page) => {
    await open(page, "", { fresh: true });
    const path = await createList(page, "Bag", [
      { label: "One", weight: 1 },
      { label: "Two", weight: 1 },
      { label: "Three", weight: 1 },
    ], "list");
    await page.evaluate(`
      const { state } = window.orangey;
      const node = state.library.find(${JSON.stringify(path)});
      state.library.save(node.path, { ...node.randomizer, withoutReplacement: true });
      await state.library.flush();
      state.setFeel({ motion: "instant" });
    `);

    await open(page, `#/r/${encodeURIComponent(path)}`);
    await page.waitForFunction(`document.querySelector(".bag-count") && document.querySelector(".bag-count").textContent === "3 of 3 left"`);

    const seen = [];
    for (let n = 0; n < 3; n++) {
      const left = 2 - n;
      await page.click(".roll-button");
      await page.waitForFunction(`document.querySelector(".bag-count").textContent === "${left} of 3 left"`);
      seen.push(await page.evaluate(`return document.querySelector(".result-value").textContent`));
    }
    assert.equal(new Set(seen).size, 3, `the same outcome came up twice: ${seen.join(", ")}`);
    await page.waitForFunction(`document.querySelector(".bag-count").textContent === "0 of 3 left"`);

    await page.click(".roll-button");
    await page.waitForFunction(`/bag is empty/i.test(document.querySelector(".result-value").textContent)`);

    // The bag is per device, so it is still empty after a reload.
    await open(page, `#/r/${encodeURIComponent(path)}`);
    await page.waitForFunction(`document.querySelector(".bag-count").textContent === "0 of 3 left"`);

    await page.click(".refill-bag");
    await page.waitForFunction(`document.querySelector(".bag-count").textContent === "3 of 3 left"`);
    await page.click(".roll-button");
    await page.waitForFunction(`document.querySelector(".bag-count").textContent === "2 of 3 left"`);

    // On a board the cell draws from the same bag, shows its count and Refill, and
    // a drawn outcome leaves the wheel as the next roll starts.
    const bagId = await page.evaluate(`
      const { state } = window.orangey;
      const node = state.library.find(${JSON.stringify(path)});
      state.library.save(node.path, { ...node.randomizer, view: "wheel" });
      await state.library.flush();
      return node.randomizer.id;
    `);
    const bagBoard = await createBoard(page, "Bag board", [bagId]);
    await open(page, `#/r/${encodeURIComponent(bagBoard)}`);
    await page.waitForFunction(`document.querySelector(".cell .bag-count")?.textContent === "2 of 3 left"`);
    const slices = () => page.evaluate(`return [...document.querySelectorAll(".cell .wheel-rotor > text")].map((t) => t.textContent)`);
    assert.equal((await slices()).length, 2, "the cell's wheel leaves out what was drawn before the board opened");
    await page.click(".cell-roll");
    await page.waitForFunction(`document.querySelector(".cell .bag-count").textContent === "1 of 3 left"`);
    const drawnHere = await page.evaluate(`return document.querySelector(".cell .result-value").textContent`);
    await page.click(".cell-roll");
    await page.waitForFunction(`document.querySelector(".cell .bag-count").textContent === "0 of 3 left"`);
    const left = await slices();
    assert.equal(left.length, 1, `the wheel still shows ${left.join(", ")}`);
    assert.ok(!left.includes(drawnHere), `${drawnHere} was drawn but is still on the wheel`);
    await page.click(".cell .refill-bag");
    await page.waitForFunction(`document.querySelector(".cell .bag-count").textContent === "3 of 3 left"`);
    assert.equal((await slices()).length, 3, "Refill puts everything back on the wheel");
    assert.deepEqual(page.consoleErrors, []);
  });

  await test("AB a hidden roll shows nothing until it is revealed", async (page) => {
    await open(page, "", { fresh: true });
    const path = await createList(page, "Behind the screen", [
      { label: "Ambush", weight: 1 },
      { label: "Nothing", weight: 1 },
    ], "list");
    await page.evaluate(`window.orangey.state.setFeel({ motion: "instant" })`);
    await open(page, `#/r/${encodeURIComponent(path)}`);
    await page.waitForFunction(`document.querySelector(".hidden-box")`);
    // The ×N field sits on one line with its ×, not stretched to full width by the
    // general rule for number inputs.
    const count = await page.evaluate(`
      const field = document.querySelector(".roll-count-field"), input = field.querySelector("input");
      return { width: input.getBoundingClientRect().width, field: field.getBoundingClientRect().height, input: input.getBoundingClientRect().height };
    `);
    assert.ok(count.width < 80, `the count field is ${count.width}px wide`);
    assert.ok(count.field < count.input * 1.5, `the × and its field take ${count.field}px for a ${count.input}px field`);

    const rows = () => page.evaluate(`return window.orangey.state.history.length`);
    // Diagnostic for a leak seen only on Windows: name what is there and when it
    // was written, relative to the wipe this test started with.
    const leaked = await page.evaluate(`return window.orangey.state.history.map((h) => ({ name: h.randomizerName, result: h.resultText, at: h.at }))`);
    assert.equal(leaked.length, 0, [
      `${leaked.length} history row(s) before the first roll; storage was wiped at ${new Date(page.wipedAt).toISOString()}`,
      ...leaked.map((r) => `  "${r.name}" → "${r.result}" at ${new Date(r.at).toISOString()} (${r.at < page.wipedAt ? "BEFORE" : "AFTER"} the wipe by ${Math.abs(r.at - page.wipedAt)} ms)`),
      `  library files at start: ${JSON.stringify(await page.evaluate(`return window.orangey.state.library.files().map((f) => f.path)`))}`,
    ].join("\n"));

    await page.click(".hidden-box");
    await page.click(".roll-button");
    await page.waitForFunction(`document.querySelector(".roll-button").textContent === "Reveal"`);

    const held = await page.evaluate(`return document.querySelector(".result-value").textContent`);
    assert.doesNotMatch(held, /Ambush|Nothing/, `the answer leaked: "${held}"`);
    assert.equal(await rows(), 0, "a hidden roll was recorded before it was revealed");

    await page.click(".roll-button");
    await page.waitForFunction(`/Ambush|Nothing/.test(document.querySelector(".result-value").textContent)`);
    await page.waitForFunction(`window.orangey.state.history.length === 1`);
    assert.equal(await rows(), 1, "revealing should write exactly one row");
    assert.deepEqual(page.consoleErrors, []);
  });

  // ---- AD–AG: quick wheel, your own theme, a board's temporary cells ---------

  await test("AD a quick wheel rolls as it is typed, comes back after a reload, offers a choice, and saves", async (page) => {
    await open(page, "", { fresh: true });
    await page.evaluate(`window.orangey.state.setFeel({ motion: "instant" })`);
    await page.setViewport(375, 740);

    await page.click(".quick-wheel-toggle");
    await page.type(".quick-wheel textarea", "Ambush\nMerchant | 2\n- Storm x3");
    await page.waitForFunction(`document.querySelector(".play-card h1").textContent === "Quick wheel" && document.querySelector(".wheel-svg")`);
    await page.click(".roll-button");
    await page.waitForFunction(`/^(Ambush|Merchant|Storm)$/.test(document.querySelector(".result-value").textContent)`);
    await page.waitForFunction(`/[?&]quick=1/.test(location.hash)`);

    // A reload stands in for the phone locking: the address brings the wheel and
    // its text back.
    await open(page, await page.evaluate(`return location.hash`));
    await page.waitForFunction(`document.querySelector(".quick-wheel textarea")?.value.length > 0`);
    assert.equal(await page.evaluate(`return document.querySelector(".quick-wheel textarea").value`), "Ambush\nMerchant | 2\nStorm | 3");
    assert.equal(await page.evaluate(`return document.querySelector(".quick-wheel").hidden`), false);

    await page.evaluate(`window.orangey.state.setFeel({ motion: "instant" })`);
    const before = await page.evaluate(`return window.orangey.state.history.length`);
    await page.type(".quick-offer", "2");
    await page.waitForFunction(`document.querySelector(".roll-count-field").hidden`);
    await page.click(".roll-button");
    await page.waitForFunction(`document.querySelectorAll("button.offer-card").length === 2`);
    const cards = await page.evaluate(`return [...document.querySelectorAll("button.offer-card .offer-text")].map((c) => c.textContent)`);
    assert.equal(new Set(cards).size, 2, `the same outcome was offered twice: ${cards.join(", ")}`);
    assert.equal(await page.evaluate(`return window.orangey.state.history.length`), before, "an offer was recorded before anything was picked");
    const overflow = await page.evaluate(`return document.documentElement.scrollWidth - document.documentElement.clientWidth`);
    assert.ok(overflow <= 0, `the page scrolls sideways by ${overflow}px at 375px with the cards out`);
    await page.click(".present-button");
    const shown = await page.evaluate(`return [".quick-wheel", ".play-card", "button.offer-card"].map((s) => getComputedStyle(document.querySelector(s)).display !== "none")`);
    assert.deepEqual(shown, [false, true, true], "full screen: quick box hidden, play card and cards shown");
    await page.click(".leave-presenting");

    await page.click("button.offer-card:nth-child(2)");
    await page.waitForFunction(`document.querySelector(".result-value").textContent === ${JSON.stringify(cards[1])}`);
    await page.waitForFunction(`window.orangey.state.history.length === ${before + 1}`);
    const row = await page.evaluate(`return window.orangey.state.history[0]`);
    assert.equal(row.resultText, cards[1]);
    assert.ok(row.parts?.some((p) => p.includes(cards[0]) && p.includes(cards[1])), `the row does not say what was offered: ${JSON.stringify(row.parts)}`);

    await page.click(".save-randomizer");
    await page.waitForFunction(`location.hash.startsWith("#/r/")`);
    const saved = await page.evaluate(`return window.orangey.state.library.files().map((f) => [f.randomizer.name, f.randomizer.offer ?? null])`);
    assert.deepEqual(saved, [["Quick wheel", 2]]);

    // Unsaved, a preset throws it away and the address goes home. (With no hash at
    // all the app reopens the last randomizer played, hence "#/".)
    await open(page, "#/");
    await page.click(".quick-wheel-toggle");
    await page.type(".quick-wheel textarea", "Left\nRight");
    await page.waitForFunction(`/[?&]quick=1/.test(location.hash)`);
    await page.click(".quickbar .preset");
    await page.waitForFunction(`location.hash === "#/" || location.hash === ""`);
    assert.equal(await page.evaluate(`return document.querySelector(".quick-wheel textarea").value`), "");
    assert.deepEqual(page.consoleErrors, []);
  });

  await test("AE your own theme paints the app and its wheels, suggests a readable version, and a wheel's own palette wins", async (page) => {
    await open(page, "#/settings", { fresh: true });
    await page.waitForFunction(`document.querySelector(".theme-card")`);
    const setHex = async (key, hex) => page.type(`.theme-card [data-field="${key}"] .colour-hex`, hex);
    const failing = () => page.evaluate(`return [...document.querySelectorAll(".theme-problems li.warning")].map((li) => li.textContent)`);
    const readable = { bg: "#1b2230", ink: "#e8e2d6", accent: "#e0862f", wheel0: "#c2412f", wheel1: "#d9a441", wheel2: "#3d7c8a", wheel3: "#6b8e4e" };
    for (const [key, hex] of Object.entries(readable)) await setHex(key, hex);
    assert.deepEqual(await failing(), []);
    await page.click(".use-theme");
    await page.waitForFunction(`document.documentElement.dataset.scheme === "custom"`);

    await setHex("ink", "#888888");
    await page.waitForFunction(`document.querySelector(".theme-suggestion") && !document.querySelector(".theme-suggestion").hidden`);
    assert.ok((await failing()).some((line) => line.startsWith("Text on the background")));
    await page.click(".use-suggestion");
    await page.waitForFunction(`getComputedStyle(document.documentElement).getPropertyValue("--ink").trim() !== "#888888"`);

    await setHex("ink", readable.ink);
    await page.click(".use-theme");
    const bg = () => page.evaluate(`return getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()`);
    await page.waitForFunction(`getComputedStyle(document.documentElement).getPropertyValue("--ink").trim() === "#e8e2d6"`);
    assert.equal(await bg(), "#1b2230");

    const path = await createList(page, "Weather", [{ label: "Rain", weight: 1 }, { label: "Sun", weight: 1 }, { label: "Fog", weight: 1 }]);
    const firstSlice = () => page.evaluate(`return document.querySelector('.wheel-rotor path[data-index="0"]').getAttribute("fill")`);
    await open(page, `#/r/${encodeURIComponent(path)}`);
    await page.waitForFunction(`document.querySelector('.wheel-rotor path[data-index="0"]')`);
    assert.equal(await firstSlice(), "#c2412f");
    assert.equal(await bg(), "#1b2230");

    await page.evaluate(`await window.orangey.state.savePrefs({ scheme: "night" })`);
    assert.equal(await page.evaluate(`return document.documentElement.style.getPropertyValue("--bg")`), "");

    await open(page, `#/edit/${encodeURIComponent(path)}`);
    await page.waitForFunction(`document.querySelector(".palette-own")`);
    await page.click(".palette-own");
    for (const [i, hex] of ["#111111", "#eeeeee", "#3d7c8a"].entries()) await page.type(`[data-field="palette${i}"] .colour-hex`, hex);
    await page.evaluate(`await window.orangey.state.library.flush()`);
    await open(page, `#/r/${encodeURIComponent(path)}`);
    await page.waitForFunction(`document.querySelector('.wheel-rotor path[data-index="0"]')`);
    assert.equal(await firstSlice(), "#111111");
    assert.equal(await page.evaluate(`return document.documentElement.dataset.scheme`), "night");
    assert.deepEqual(page.consoleErrors, []);
  });

  // Temporary cells are per device: the board file changes only when one is
  // saved onto it.
  await test("AG a board takes dice and a quick wheel for now, keeps them over a reload, and saves one onto the board", async (page) => {
    await open(page, "", { fresh: true });
    const boardPath = await page.evaluate(`
      const { state } = window.orangey;
      state.setFeel({ motion: "instant" });
      const now = new Date().toISOString();
      await state.library.create("", { id: "weather", type: "list", name: "Weather", view: "wheel", created: now, modified: now,
        items: [{ id: "r", label: "Rain", weight: 1 }, { id: "s", label: "Sun", weight: 1 }] });
      return await state.library.create("", { id: "tonight", type: "board", name: "Tonight", entries: [{ id: "weather", name: "Weather" }], created: now, modified: now });
    `);
    await open(page, `#/r/${encodeURIComponent(boardPath)}`);
    await page.waitForFunction(`document.querySelector(".board-dice")`);

    await page.type(".board-dice", "3d20");
    await page.key("Enter");
    await page.click(".board-quick-wheel");
    await page.waitForFunction(`document.querySelectorAll(".cell-temp").length === 2`);
    await page.type(".cell-temp .temp-options", "Goblins\nBandits | 2");
    await page.waitForFunction(`document.querySelector(".cell-temp .wheel-svg")`);

    await page.click(".roll-all");
    await page.waitForFunction(`window.orangey.state.history.length === 3`);
    assert.deepEqual(
      (await page.evaluate(`return window.orangey.state.history.map((h) => h.randomizerName)`)).sort(),
      ["3d20", "Quick wheel", "Weather"],
    );
    const entries = () => page.evaluate(`return window.orangey.state.library.findById("tonight").randomizer.entries.map((e) => e.name)`);
    assert.deepEqual(await entries(), ["Weather"]);

    await open(page, `#/r/${encodeURIComponent(boardPath)}`);
    await page.waitForFunction(`document.querySelectorAll(".cell-temp").length === 2`);
    assert.equal(await page.evaluate(`return document.querySelector(".cell-temp .temp-options").value`), "Goblins\nBandits | 2");

    await page.click(".cell-temp:has(.temp-options) .temp-save");
    await page.waitForFunction(`document.querySelectorAll(".cell-temp").length === 1`);
    await page.waitForFunction(`window.orangey.state.library.findById("tonight").randomizer.entries.length === 2`);
    assert.deepEqual(await entries(), ["Weather", "Quick wheel"]);

    await page.click(".cell-temp .temp-close");
    await page.waitForFunction(`document.querySelectorAll(".cell-temp").length === 0`);
    await open(page, `#/r/${encodeURIComponent(boardPath)}`);
    await page.waitForFunction(`document.querySelectorAll(".board-grid .cell").length === 2`);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await page.evaluate(`return document.querySelectorAll(".cell-temp").length`), 0);
    assert.deepEqual(page.consoleErrors, []);
  });

  // ---- AH: the pop-out window ------------------------------------------------

  await test("AH a randomizer and a board pop out into a window of their own, roll where they are clicked, fill it, and follow a chain in place", async (page) => {
    await open(page, "", { fresh: true });
    await createList(page, "Hoard", [{ label: "Gold", weight: 1 }]);
    const encounters = await createList(page, "Encounters", [{ label: "Dragon", weight: 1, goesTo: "Hoard" }]);
    const boardPath = await page.evaluate(`
      const { state } = window.orangey;
      state.setFeel({ motion: "instant" });
      const now = new Date().toISOString();
      await state.library.create("", { id: "Damage", type: "dice", name: "Damage", expression: "2d6", created: now, modified: now });
      return await state.library.create("", { id: "Tonight", type: "board", name: "Tonight", created: now, modified: now,
        entries: [{ id: "Encounters", name: "Encounters" }, { id: "Damage", name: "Damage" }] });
    `);
    // The window opens only in answer to a user gesture, so the click is sent as one.
    const press = (selector) => page.send("Runtime.evaluate", {
      expression: `document.querySelector(${JSON.stringify(selector)}).click()`,
      userGesture: true,
    });
    const pip = (js) => page.evaluate(`const d = documentPictureInPicture.window.document; ${js}`);
    const rows = () => page.evaluate(`return window.orangey.state.history.length`);

    await open(page, `#/r/${encodeURIComponent(encounters)}`);
    await page.waitForFunction(`document.querySelector(".popout-button")`);
    await press(".popout-button");
    await page.waitForFunction(`documentPictureInPicture.window?.document.querySelector(".popout-single .cell")`);
    assert.equal(
      await pip(`return getComputedStyle(d.body).backgroundColor`),
      await page.evaluate(`return getComputedStyle(document.body).backgroundColor`),
    );

    assert.equal(await pip(`return d.querySelectorAll(".popout-roll, .cell-roll, .chain-roll").length`), 0);
    assert.equal(await pip(`return d.querySelector(".result-value").textContent`), "Click to roll");
    const fit = await pip(`
      const w = d.querySelector(".wheel-svg").getBoundingClientRect();
      const win = documentPictureInPicture.window;
      return { wheel: w.width, width: win.innerWidth, height: win.innerHeight, scrolls: d.documentElement.scrollHeight > win.innerHeight };
    `);
    assert.ok(fit.wheel > Math.min(fit.width, fit.height) * 0.6, `the wheel is ${Math.round(fit.wheel)}px in a ${fit.width}x${fit.height} window`);
    assert.ok(fit.wheel <= fit.width && !fit.scrolls, "the wheel spills out of the window");

    // A wheel rolls from its hub; a click on a slice is left for a double-click,
    // which edits it.
    await pip(`d.querySelector(".wheel-rotor path[data-index]").dispatchEvent(new MouseEvent("click", { bubbles: true }))`);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(await rows(), 0, "a click on a slice in the pop-out rolled the wheel");
    await pip(`d.querySelector(".wheel-hub").dispatchEvent(new MouseEvent("click", { bubbles: true }))`);
    await page.waitForFunction(`window.orangey.state.history.length === 1`);
    assert.equal(await pip(`return d.querySelector(".result-value").textContent`), "Dragon");
    assert.equal(await pip(`return d.querySelector(".popout-next").textContent`), "→ Hoard");
    await pip(`d.querySelector(".popout-next").click()`);
    await pip(`d.querySelector(".chain-link .cell").click()`);
    await page.waitForFunction(`window.orangey.state.history.length === 2`);
    const chained = await page.evaluate(`const h = window.orangey.state.history[0]; return [h.randomizerName, h.resultText, h.from?.randomizerName, h.from?.label]`);
    assert.deepEqual(chained, ["Hoard", "Gold", "Encounters", "Dragon"]);
    assert.equal(await pip(`return d.querySelector(".popout-back").textContent`), "← Encounters");
    await pip(`d.querySelector(".popout-back").click()`);
    assert.equal(await pip(`return d.querySelector(".result-value").textContent`), "Dragon", "going back shows the answer it left");
    assert.equal(await pip(`return d.querySelector(".popout-next").hidden`), false, "and still offers the way forward");
    await pip(`d.body.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }))`);
    await page.waitForFunction(`window.orangey.state.history.length === 3`);
    await page.evaluate(`documentPictureInPicture.window.close()`);
    await page.waitForFunction(`!documentPictureInPicture.window`);

    await open(page, `#/r/${encodeURIComponent(boardPath)}`);
    await page.waitForFunction(`document.querySelector(".popout-button")`);
    await press(".popout-button");
    await page.waitForFunction(`documentPictureInPicture.window?.document.querySelector(".popout-roll-all")`);
    assert.equal(await pip(`return d.querySelectorAll(".popout-slot").length`), 2);
    const before = await rows();
    await pip(`d.querySelectorAll(".popout-slot .cell")[1].click()`);
    await page.waitForFunction(`window.orangey.state.history.length === ${before + 1}`);
    assert.equal(await page.evaluate(`return window.orangey.state.history[0].randomizerName`), "Damage");
    await pip(`d.querySelector(".popout-roll-all").click()`);
    await page.waitForFunction(`window.orangey.state.history.length === ${before + 3}`);
    await page.evaluate(`documentPictureInPicture.window.close()`);
    await page.waitForFunction(`!documentPictureInPicture.window`);
    assert.deepEqual(page.consoleErrors, []);

    // A browser without Document Picture-in-Picture gets no button rather than one
    // that fails.
    await page.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `Object.defineProperty(window, "documentPictureInPicture", { value: undefined })`,
    });
    await open(page, `#/r/${encodeURIComponent(boardPath)}`);
    await page.waitForFunction(`document.querySelector(".present-button")`);
    assert.equal(await page.evaluate(`return document.querySelector(".popout-button")`), null);
  });

  await test("AI a list is picked from as well as rolled, and a wheel's slice is weighted where it is played", async (page) => {
    await open(page, "", { fresh: true });
    await createList(page, "Hoard", [{ label: "Gold", weight: 1 }]);
    const path = await createList(page, "Encounters", [
      { label: "Goblins", weight: 1 }, { label: "Dragon", weight: 1, goesTo: "Hoard" }, { label: "Nothing", weight: 1 },
    ], "list");
    await createList(page, "Weather", [{ label: "Sun", weight: 1 }, { label: "Rain", weight: 1 }]);
    const rows = () => page.evaluate(`return window.orangey.state.history.length`);
    const pick = (scope, label) => page.evaluate(`
      [...document.querySelectorAll(${JSON.stringify(`${scope} .outcome-pick`)})].find((b) => b.textContent.includes(${JSON.stringify(label)})).click()`);

    await open(page, `#/r/${encodeURIComponent(path)}`);
    await page.waitForFunction(`document.querySelectorAll(".outcome-pick").length === 3`);
    await page.evaluate(`window.orangey.state.setFeel({ motion: "instant" })`);
    assert.equal(await page.evaluate(`return getComputedStyle(document.querySelector(".outcome-list")).overflowY`), "auto", "a long list scrolls within itself");
    await pick(".play-card", "Dragon");
    await page.waitForFunction(`window.orangey.state.history.length === 1`);
    assert.deepEqual(
      await page.evaluate(`const h = window.orangey.state.history[0]; return [h.resultText, h.parts]`),
      ["Dragon", ["picked, not rolled"]],
    );
    assert.equal(await page.evaluate(`return document.querySelector(".outcome-pick[aria-current=true] .outcome-label").textContent`), "Dragon");
    await page.waitForFunction(`document.querySelector(".chain-link")`);
    assert.equal(await page.evaluate(`return document.querySelector(".chain-link .cell-name").textContent`), "Hoard");
    assert.match(await page.evaluate(`return document.querySelector(".chain-from").textContent`), /picked Dragon/);

    const board = await createBoard(page, "Tonight", ["Weather", "Encounters"]);
    await open(page, `#/r/${encodeURIComponent(board)}`);
    await page.waitForFunction(`document.querySelector('[data-entry="Weather"] .wheel-hub') && document.querySelector('[data-entry="Encounters"] .outcome-pick')`);
    await page.evaluate(`window.orangey.state.setFeel({ motion: "instant" })`);
    assert.equal(await page.evaluate(`return document.querySelector(".edit-board").getAttribute("aria-pressed")`), "false");
    const before = await rows();
    await pick('[data-entry="Encounters"]', "Goblins");
    await page.waitForFunction(`window.orangey.state.history.length === ${before + 1}`);
    // A wheel's slice does not roll it; its hub does.
    await page.evaluate(`document.querySelector('[data-entry="Weather"] .wheel-rotor path[data-index]').dispatchEvent(new MouseEvent("click", { bubbles: true }))`);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(await rows(), before + 1, "a click on a slice rolled the wheel");
    await page.evaluate(`document.querySelector('[data-entry="Weather"] .wheel-hub').dispatchEvent(new MouseEvent("click", { bubbles: true }))`);
    await page.waitForFunction(`window.orangey.state.history.length === ${before + 2}`);
    const answers = () => page.evaluate(`return [...document.querySelectorAll(".cell .result-value")].map((e) => e.textContent)`);
    const shown = await answers();
    assert.equal(shown[1], "Goblins");

    const tap = (times) => page.evaluate(`
      const el = document.querySelector('[data-entry="Weather"] .wheel-rotor path[data-index="0"]');
      const r = el.getBoundingClientRect();
      for (let k = 0; k < ${times}; k++) {
        el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
      }`);
    await tap(1);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(await page.evaluate(`return document.querySelector(".weight-editor")`), null, "one tap opened the weight box");
    await tap(2);
    await page.waitForFunction(`document.querySelector(".weight-editor .weight-input")`);
    assert.equal(await page.evaluate(`return document.querySelector(".weight-editor .weight-label").textContent`), "Sun");
    await page.evaluate(`
      const input = document.querySelector(".weight-input");
      input.value = "4";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));`);
    await page.waitForFunction(`!document.querySelector(".weight-editor")`);
    const weights = () => page.evaluate(`
      const { state } = window.orangey;
      await state.library.flush();
      return JSON.parse(await state.library.backend.read(state.library.findById("Weather").path)).randomizer.items.map((i) => i.weight);`);
    for (let i = 0; i < 20 && (await weights())[0] !== 4; i++) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(await weights(), [4, 1]);
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(await answers(), shown, "an edit wiped the board's answers");
    assert.deepEqual(page.consoleErrors, []);
  });

  await test("AJ several randomizers go on a board at once, from the Add… window and from the library", async (page) => {
    await open(page, "", { fresh: true });
    await page.setViewport(1280, 800);
    const board = await page.evaluate(`
      const { state } = window.orangey;
      const now = new Date().toISOString();
      const folder = await state.library.createFolder("", "Tables");
      for (const name of ["Alpha", "Bravo", "Charlie", "Delta"]) {
        await state.library.create(folder, { id: name, type: "list", name, view: "list", created: now, modified: now,
          items: [{ id: "a", label: "A", weight: 1 }] });
      }
      await state.library.flush();
      await state.savePrefs({ expandedFolders: [folder] });
      return await state.library.create("", { id: "Tonight", type: "board", name: "Tonight", entries: [], created: now, modified: now });
    `);
    const click = (selector, text, mods = {}) => page.evaluate(`
      const row = [...document.querySelectorAll(${JSON.stringify(selector)})].find((r) => r.textContent.includes(${JSON.stringify(text)}));
      row.dispatchEvent(new MouseEvent("click", { bubbles: true, ...${JSON.stringify(mods)} }));`);
    const entries = () => page.evaluate(`return window.orangey.state.library.findById("Tonight").randomizer.entries.map((e) => e.name)`);

    await open(page, `#/r/${encodeURIComponent(board)}`);
    await page.waitForFunction(`document.querySelector(".add-to-board")`);
    await page.click(".add-to-board");
    await page.waitForFunction(`document.querySelector(".picker-dialog[open]")`);
    await click(".picker-folder", "Tables");
    await page.waitForFunction(`document.querySelectorAll(".picker-choice").length === 4`);
    await click(".picker-choice", "Alpha", { ctrlKey: true });
    await click(".picker-choice", "Charlie", { shiftKey: true });
    assert.deepEqual(await page.evaluate(`return [...document.querySelectorAll(".picker-chosen")].map((e) => e.textContent)`), ["Alpha", "Bravo", "Charlie"]);
    assert.equal(await page.evaluate(`return document.querySelector(".picker-add").textContent`), "Add 3");
    await page.click(".picker-add");
    await page.waitForFunction(`document.querySelectorAll(".cell-holder").length === 3`);
    assert.deepEqual(await entries(), ["Alpha", "Bravo", "Charlie"]);

    await page.click(".add-to-board");
    await page.waitForFunction(`document.querySelector(".picker-dialog[open]")`);
    await page.evaluate(`[...document.querySelectorAll(".picker-folder")].find((r) => r.textContent.includes("Tables"))
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))`);
    assert.deepEqual(await page.evaluate(`return [...document.querySelectorAll(".picker-chosen")].map((e) => e.textContent)`), ["Delta"]);
    await page.click(".picker-close");
    await page.waitForFunction(`!document.querySelector(".picker-dialog[open]")`);

    await click(".library .tree-row", "Bravo", { ctrlKey: true });
    await click(".library .tree-row", "Delta", { ctrlKey: true });
    assert.equal(await page.evaluate(`return location.hash`), `#/r/${encodeURIComponent(board)}`, "a Ctrl-click opened the randomizer");
    assert.equal(await page.evaluate(`return document.querySelectorAll(".library .tree-row.selected").length`), 2);
    await page.evaluate(`
      const data = new DataTransfer();
      const row = [...document.querySelectorAll(".library .tree-row")].find((r) => r.textContent.includes("Delta"));
      const grid = document.querySelector(".board-grid");
      row.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: data }));
      grid.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: data }));
      grid.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
      row.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: data }));`);
    await page.waitForFunction(`document.querySelectorAll(".cell-holder").length === 4`);
    assert.deepEqual(await entries(), ["Alpha", "Bravo", "Charlie", "Delta"]);
    await page.waitForFunction(`[...document.querySelectorAll(".toast")].some((t) => t.textContent.includes("1 was already on it"))`);

    await page.evaluate(`[...document.querySelectorAll(".library .folder-row")].find((r) => r.textContent.includes("Tables"))
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))`);
    await page.waitForFunction(`document.querySelector(".menu-item")`);
    await page.evaluate(`[...document.querySelectorAll(".menu-item")].find((m) => m.textContent === "Select all in this folder").click()`);
    await page.waitForFunction(`document.querySelectorAll(".library .tree-row.selected").length === 4`);
    await page.evaluate(`document.querySelector(".library .tree-row.selected").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    assert.equal(await page.evaluate(`return document.querySelectorAll(".library .tree-row.selected").length`), 0);
    assert.equal(await page.evaluate(`return document.querySelector(".library-selection").hidden`), true);
    await click(".library .tree-row", "Alpha");
    await page.waitForFunction(`location.hash.includes("alpha")`);
    assert.deepEqual(page.consoleErrors, []);
  });

  await test("AK a folder or a selection goes out as one readable library file, and comes back in with its folders and links", async (page) => {
    await open(page, "", { fresh: true });
    await page.setViewport(1280, 800);
    await page.evaluate(`
      const { state } = window.orangey;
      const now = new Date().toISOString();
      const forest = await state.library.createFolder("", "Forest");
      const treasure = await state.library.createFolder("", "Treasure");
      await state.library.create(forest, { id: "enc", type: "list", name: "Encounters", view: "wheel", created: now, modified: now,
        items: [{ id: "a", label: "Dragon", weight: 1, goesTo: "hoard" }, { id: "b", label: "Nothing", weight: 3 }] });
      await state.library.create(treasure, { id: "hoard", type: "list", name: "Hoard", view: "wheel", created: now, modified: now,
        items: [{ id: "g", label: "Gold", weight: 1, image: "picture-of-gold" }] });
      await state.library.create("", { id: "weather", type: "coin", name: "Weather", faces: ["Rain", "Sun"], created: now, modified: now });
      await state.library.flush();
      await state.savePrefs({ expandedFolders: [forest, treasure] });
    `);
    await open(page, "#/");
    // Downloads are caught rather than saved: the name, and the text.
    await page.evaluate(`
      window.__saved = [];
      HTMLAnchorElement.prototype.click = function () {
        const href = this.href;
        window.__saved.push(fetch(href).then((r) => r.text()).then((text) => ({ name: this.download, text })));
      };`);
    const saved = () => page.evaluate(`return await Promise.all(window.__saved)`);
    const nameDialog = async (value) => {
      await page.waitForFunction(`document.querySelector("dialog[open] input[type=text]")`);
      assert.equal(await page.evaluate(`return document.querySelector("dialog[open] input[type=text]").value`), value.expect);
      await page.evaluate(`
        document.querySelector("dialog[open] input[type=text]").value = ${JSON.stringify(value.type)};
        document.querySelector("dialog[open] button[type=submit]").click();`);
    };

    await page.waitForFunction(`document.querySelector(".library .folder-row")`);
    await page.evaluate(`[...document.querySelectorAll(".library .folder-row")].find((r) => r.textContent.includes("Forest"))
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))`);
    await page.waitForFunction(`[...document.querySelectorAll(".menu-item")].some((m) => m.textContent === "Export folder as a text file…")`);
    await page.evaluate(`[...document.querySelectorAll(".menu-item")].find((m) => m.textContent === "Export folder as a text file…").click()`);
    await nameDialog({ expect: "Forest", type: "Forest tables" });
    await page.waitForFunction(`window.__saved.length === 1`);
    const [folderFile] = await saved();
    assert.equal(folderFile.name, "forest-tables.orangey-library.json");
    const doc = JSON.parse(folderFile.text);
    assert.equal(doc.format, "orangey-library");
    assert.equal(doc.name, "Forest tables");
    assert.deepEqual(doc.randomizers.map((r) => r.path), ["Forest/encounters.orangey.json", "Treasure/hoard.orangey.json"]);
    assert.ok(!folderFile.text.includes("picture-of-gold"), "a picture reached the text file");
    assert.ok(folderFile.text.includes("\n  "), "the file is laid out to be read");
    await page.waitForFunction(`[...document.querySelectorAll(".toast")].some((t) => /1 of them because something chosen goes to it.*1 picture was left out/.test(t.textContent))`);

    await page.evaluate(`
      for (const name of ["Encounters", "Weather"]) {
        [...document.querySelectorAll(".library .tree-row")].find((r) => r.textContent.includes(name))
          .dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
      }`);
    await page.click(".export-selection");
    await nameDialog({ expect: "My library", type: "Tonight" });
    await page.waitForFunction(`window.__saved.length === 2`);
    const selectionFile = (await saved())[1];
    assert.equal(selectionFile.name, "tonight.orangey-library.json");
    assert.deepEqual(JSON.parse(selectionFile.text).randomizers.map((r) => r.path),
      ["Forest/encounters.orangey.json", "weather.orangey.json", "Treasure/hoard.orangey.json"]);

    await open(page, "#/import", { fresh: true });
    await page.waitForFunction(`document.querySelector(".importer textarea")`);
    await page.evaluate(`
      const area = document.querySelector(".importer textarea");
      area.value = ${JSON.stringify(folderFile.text)};
      area.dispatchEvent(new Event("paste", { bubbles: true }));`);
    await page.waitForFunction(`document.querySelector(".import-library")`);
    assert.equal(await page.evaluate(`return document.querySelector(".library-summary").textContent`), "2 randomizers in 2 folders");
    await page.click(".import-library");
    await page.waitForFunction(`location.hash === "#/library" && window.orangey.state.library.files().length === 2`);
    const arrived = await page.evaluate(`
      const { state } = window.orangey;
      const enc = state.library.find("Forest/encounters.orangey.json").randomizer;
      return [enc.id, enc.items[0].goesTo, state.library.findById(enc.items[0].goesTo)?.path, enc.items.map((i) => i.weight)];`);
    assert.deepEqual(arrived, ["enc", "hoard", "Treasure/hoard.orangey.json", [1, 3]]);

    await open(page, "#/import");
    await page.waitForFunction(`document.querySelector(".importer textarea")`);
    await page.evaluate(`
      const data = new DataTransfer();
      data.items.add(new File([${JSON.stringify(folderFile.text)}], "forest-tables.orangey-library.json", { type: "application/json" }));
      document.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));`);
    for (let i = 0; i < 2; i++) {
      await page.waitForFunction(`[...document.querySelectorAll("dialog[open] button")].some((b) => b.textContent === "Keep both")`);
      await page.evaluate(`[...document.querySelectorAll("dialog[open] button")].find((b) => b.textContent === "Keep both").click()`);
    }
    await page.waitForFunction(`window.orangey.state.library.files().length === 4`);
    const copies = await page.evaluate(`
      const { state } = window.orangey;
      const enc = state.library.files().find((f) => f.path.startsWith("Forest/") && f.randomizer.id !== "enc").randomizer;
      const target = state.library.findById(enc.items[0].goesTo);
      return [enc.items[0].goesTo === "hoard", target.path.startsWith("Treasure/"), target.randomizer.id === "hoard"];`);
    assert.deepEqual(copies, [false, true, false]);
    assert.deepEqual(page.consoleErrors, []);
  });

  await test("AL an inkblot is generated with a link, lands as a picture, can be downloaded, and history keeps its number", async (page) => {
    await open(page, "", { fresh: true });
    const [path, boardPath] = await page.evaluate(`
      const { state } = window.orangey;
      await state.setFeel({ motion: "instant" });
      const now = new Date().toISOString();
      const ink = await state.library.create("", { id: "ink", type: "inkblot", name: "Inkblot", created: now, modified: now });
      const board = await state.library.create("", { id: "board", type: "board", name: "Table", created: now, modified: now, entries: [{ id: "ink", name: "Inkblot" }] });
      return [ink, board];`);
    await open(page, `#/r/${encodeURIComponent(path)}`);
    await page.waitForFunction(`document.querySelector(".roll-button")?.textContent === "Generate"`);
    const before = await page.evaluate(`
      const b = document.querySelector(".roll-button");
      const d = document.querySelector(".inkblot-download");
      return [b.classList.contains("generate"), !!d && !d.hidden && d.disabled, document.querySelector(".hidden-toggle").hidden];`);
    assert.deepEqual(before, [true, true, true], "Generate is a link, Download waits for a blot, no hidden roll");
    await page.click(".roll-button");
    await page.waitForFunction(`(() => { const i = document.querySelector(".inkblot-picture"); return i && !i.hidden && i.src.startsWith("blob:"); })()`);
    const after = await page.evaluate(`
      const row = window.orangey.state.history[0];
      return [document.querySelector(".inkblot-download").disabled, row.type, row.resultText, (row.parts ?? []).join("|")];`);
    assert.equal(after[0], false, "Download is offered once the blot has landed");
    assert.equal(after[1], "inkblot");
    assert.equal(after[2], "generated");
    assert.match(after[3], /^blot \d+$/);
    // A board cell generates too, with the same link instead of Roll.
    await open(page, `#/r/${encodeURIComponent(boardPath)}`);
    await page.waitForFunction(`document.querySelector(".cell-roll")?.textContent === "Generate"`);
    await page.click(".cell-roll");
    await page.waitForFunction(`(() => { const i = document.querySelector(".cell .inkblot-picture"); return i && !i.hidden; })()`);
    assert.deepEqual(page.consoleErrors, []);
  });

  await test("AM a folder is published as a pack, installed locked with its credit, copied to edit, and updated from a link", async (page) => {
    await open(page, "", { fresh: true });
    await page.setViewport(1280, 800);
    await page.evaluate(`
      const { state } = window.orangey;
      const now = new Date().toISOString();
      const delve = await state.library.createFolder("", "Delve");
      await state.library.create(delve, { id: "theme", type: "list", name: "Theme", view: "wheel", created: now, modified: now,
        items: [{ id: "a", label: "Ancient", weight: 1, goesTo: "feature" }, { id: "b", label: "Hallowed", weight: 1 }] });
      await state.library.create(delve, { id: "feature", type: "list", name: "Feature", view: "list", created: now, modified: now,
        items: [{ id: "c", label: "Altar", weight: 1 }] });
      await state.library.flush();
    `);
    await open(page, "#/");
    await page.evaluate(`
      window.__saved = [];
      HTMLAnchorElement.prototype.click = function () {
        const href = this.href;
        window.__saved.push(fetch(href).then((r) => r.text()).then((text) => ({ name: this.download, text })));
      };`);
    await page.waitForFunction(`document.querySelector(".library .folder-row")`);
    const folderMenu = (name) => page.evaluate(`[...document.querySelectorAll(".library .folder-row")].find((r) => r.textContent.includes(${JSON.stringify(name)}))
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))`);
    const menu = async (label) => {
      await page.waitForFunction(`[...document.querySelectorAll(".menu-item")].some((m) => m.textContent === ${JSON.stringify(label)})`);
      await page.evaluate(`[...document.querySelectorAll(".menu-item")].find((m) => m.textContent === ${JSON.stringify(label)}).click()`);
    };
    await folderMenu("Delve");
    await menu("Publish as a pack…");
    await page.waitForFunction(`document.querySelector("dialog.pack-dialog[open]")`);
    // Without an author it says so, and stays open.
    await page.click("dialog.pack-dialog[open] button[type=submit]");
    await page.waitForFunction(`/author is needed/.test(document.querySelector(".form-problem").textContent)`);
    await page.evaluate(`
      const f = document.querySelector("dialog.pack-dialog[open] form");
      f.author.value = "A. Writer";
      f.licence.value = "CC BY 4.0";
      f.homepage.value = "https://example.org/delve";
      f.querySelector("button[type=submit]").click();`);
    await page.waitForFunction(`window.__saved.length === 1`);
    const [packFile] = await page.evaluate(`return await Promise.all(window.__saved)`);
    assert.equal(packFile.name, "delve-1.0.orangey-library.json");
    const doc = JSON.parse(packFile.text);
    assert.deepEqual([doc.pack.title, doc.pack.author, doc.pack.version, doc.pack.licence], ["Delve", "A. Writer", "1.0", "CC BY 4.0"]);
    assert.deepEqual(doc.randomizers.map((r) => r.path).sort(), ["feature.orangey.json", "theme.orangey.json"]);
    // The author's folder keeps the details, stays editable, and offers the next version.
    assert.equal(await page.evaluate(`return window.orangey.state.library.isLocked("Delve")`), false);
    await folderMenu("Delve");
    await page.waitForFunction(`[...document.querySelectorAll(".menu-item")].some((m) => m.textContent === "Publish the next version (after 1.0)…")`);
    await page.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);

    // A player's library: the file dropped on Import shows the pack, and installs it.
    await open(page, "#/import", { fresh: true });
    await page.waitForFunction(`document.querySelector(".importer textarea")`);
    await page.evaluate(`
      const data = new DataTransfer();
      data.items.add(new File([${JSON.stringify(packFile.text)}], ${JSON.stringify(packFile.name)}, { type: "application/json" }));
      document.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));`);
    await page.waitForFunction(`location.hash === "#/install" && document.querySelector(".install-button")`);
    assert.equal(await page.evaluate(`return document.querySelector(".install-pack .pack-credit").textContent`), "Delve by A. Writer · v1.0 · CC BY 4.0 · web page");
    await page.click(".install-button");
    await page.waitForFunction(`location.hash === "#/library" && document.querySelector(".pack-badge")`);
    assert.equal(await page.evaluate(`return document.querySelector(".pack-badge").textContent`), "pack 1.0");
    const themePath = await page.evaluate(`return window.orangey.state.library.findById("theme").path`);
    assert.equal(themePath, "Delve/theme.orangey.json");

    // Playing it shows the credit and no Edit; the editor offers an editable copy instead.
    await open(page, `#/r/${encodeURIComponent(themePath)}`);
    await page.waitForFunction(`document.querySelector(".pack-credit")`);
    assert.equal(await page.evaluate(`return getComputedStyle(document.querySelector(".edit-link")).display`), "none");
    await open(page, `#/edit/${encodeURIComponent(themePath)}`);
    await page.waitForFunction(`document.querySelector(".locked-pack")`);
    await page.evaluate(`[...document.querySelectorAll(".locked-pack button")].find((b) => b.textContent.startsWith("Make an editable copy")).click()`);
    await page.waitForFunction(`location.hash.startsWith("#/edit/Delve%20(copy)")`);
    const copy = await page.evaluate(`
      const { state } = window.orangey;
      const t = state.library.find("Delve (copy)/theme.orangey.json").randomizer;
      return [t.id !== "theme", state.library.findById(t.items[0].goesTo).path, state.library.isLocked("Delve (copy)")];`);
    assert.deepEqual(copy, [true, "Delve (copy)/feature.orangey.json", false]);

    // Version 1.1, put on a web page: the install link offers the update, with what changes.
    const v2 = JSON.parse(packFile.text);
    v2.pack.version = "1.1";
    v2.randomizers.find((r) => r.randomizer.id === "feature").randomizer.items.push({ id: "pit", label: "Pit", weight: 1 });
    v2.randomizers.push({ path: "danger.orangey.json", randomizer: { id: "danger", type: "list", name: "Danger", view: "list", created: "2026-10-02T00:00:00.000Z", modified: "2026-10-02T00:00:00.000Z", items: [{ id: "trap", label: "Trap", weight: 1 }] } });
    writeFileSync(join(dist, "test-delve.orangey-library.json"), JSON.stringify(v2));
    try {
      await open(page, `#/install?from=${encodeURIComponent(`${server.origin}/test-delve.orangey-library.json`)}`);
      await page.waitForFunction(`document.querySelector(".update-button")`);
      assert.equal(await page.evaluate(`return document.querySelector(".update-button").textContent`), "Update to 1.1");
      assert.match(await page.evaluate(`return document.querySelector(".install-pack").textContent`), /You have version 1\.0 in “Delve”\. This is 1\.1\.New: Danger\./);
      await page.click(".update-button");
      await page.waitForFunction(`location.hash === "#/library" && document.querySelector(".pack-badge")?.textContent === "pack 1.1"`);
      const after = await page.evaluate(`
        const { state } = window.orangey;
        return [state.library.findById("feature").randomizer.items.length, !!state.library.findById("danger"), state.library.findPack(${JSON.stringify(doc.pack.id)}).pack.source.endsWith("test-delve.orangey-library.json")];`);
      assert.deepEqual(after, [2, true, true]);
    } finally {
      rmSync(join(dist, "test-delve.orangey-library.json"), { force: true });
    }
    assert.deepEqual(page.consoleErrors, []);
  });

  await test("AN {@ in an outcome picks a table to roll there; the editor shows names, the file keeps ids, and a roll fills it in", async (page) => {
    await open(page, "", { fresh: true });
    await page.setViewport(1280, 800);
    const path = await page.evaluate(`
      const { state } = window.orangey;
      const now = new Date().toISOString();
      const list = (id, name, labels) => ({ id, type: "list", name, view: "list", created: now, modified: now,
        items: labels.map((label, i) => ({ id: id + i, label, weight: 1 })) });
      await state.library.create("", list("w1", "Weather", ["fog", "rain"]));
      const beasts = await state.library.createFolder("", "Beasts");
      await state.library.create(beasts, list("b1", "Beast", ["wolf", "bear"]));
      const path = await state.library.create("", list("m1", "Morning", ["A {@Weather|w1} morning", "Quiet"]));
      await state.library.flush();
      return path;`);
    await open(page, `#/edit/${encodeURIComponent(path)}`);
    await page.waitForFunction(`document.querySelectorAll(".label-cell input").length === 2`);
    assert.equal(await page.evaluate(`return document.querySelector(".label-cell input").value`), "A {@Weather} morning");
    await page.evaluate(`
      const input = document.querySelectorAll(".label-cell input")[1];
      input.focus();
      input.value = "Quiet, then {@bea";
      input.setSelectionRange(input.value.length, input.value.length);
      input.dispatchEvent(new Event("input", { bubbles: true }));`);
    await page.waitForFunction(`document.querySelector(".ref-picker li")`);
    assert.equal(await page.evaluate(`return document.querySelector(".ref-picker .ref-name").textContent`), "Beast");
    await page.evaluate(`document.querySelectorAll(".label-cell input")[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))`);
    await page.waitForFunction(`document.querySelectorAll(".label-cell input")[1].value === "Quiet, then {@Beast}"`);
    await page.evaluate(`await window.orangey.state.library.flush()`);
    assert.equal(await page.evaluate(`return (await window.orangey.state.library.backend.read(${JSON.stringify(path)})).includes('"Quiet, then {@Beast|b1}"')`), true, "the file does not keep the id");

    // Rolled, the references are filled in.
    await open(page, `#/r/${encodeURIComponent(path)}`);
    for (let i = 0; i < 4; i++) {
      await page.waitForFunction(`document.querySelector(".roll-button") && !document.querySelector(".roll-button").disabled`);
      await page.click(".roll-button");
      await page.waitForFunction(`window.orangey.state.history.length === ${i + 1}`);
    }
    const texts = await page.evaluate(`return window.orangey.state.history.map((h) => h.resultText)`);
    for (const t of texts) assert.match(t, /^(A (fog|rain) morning|Quiet, then (wolf|bear))$/);
    assert.deepEqual(page.consoleErrors, []);
  });

  await test("AO a backup leaves installed packs out and lists them; restoring it offers to install them again", async (page) => {
    await open(page, "", { fresh: true });
    await page.setViewport(1280, 800);
    const at = "2026-10-02T00:00:00.000Z";
    const packFile = JSON.stringify({
      format: "orangey-library", version: 1, name: "Delve", exported: at, folders: [],
      pack: { id: "pack-delve", title: "Delve", author: "A. Writer", version: "1.0" },
      randomizers: [{ path: "theme.orangey.json", randomizer: { id: "theme", type: "list", name: "Theme", view: "list", created: at, modified: at, items: [{ id: "t0", label: "Ancient", weight: 1 }] } }],
    });
    writeFileSync(join(dist, "test-backup-delve.orangey-library.json"), packFile);
    const source = `${server.origin}/test-backup-delve.orangey-library.json`;
    try {
      // Installed through the app itself: the install screen, from its link.
      await open(page, `#/install?from=${encodeURIComponent(source)}`);
      await page.waitForFunction(`document.querySelector(".install-button")`);
      await page.click(".install-button");
      await page.waitForFunction(`location.hash === "#/library" && document.querySelector(".pack-badge")`);
      await page.evaluate(`
        const { state } = window.orangey;
        const now = new Date().toISOString();
        await state.library.create("", { id: "mine", type: "list", name: "Mine", view: "list", created: now, modified: now,
          items: [{ id: "m0", label: "Into the delve", weight: 1, goesTo: "theme" }] });
        await state.library.flush();`);

      await open(page, "#/settings");
      await page.waitForFunction(`document.querySelector(".export-library")`);
      await page.evaluate(`
        window.__downloads = [];
        const real = URL.createObjectURL.bind(URL);
        URL.createObjectURL = (blob) => { window.__downloads.push(blob); return real(blob); };`);
      await page.click(".export-library");
      await page.waitForFunction(`window.__downloads.length === 1`);
      const zip = await page.evaluate(`
        const bytes = new Uint8Array(await window.__downloads[0].arrayBuffer());
        let s = ""; for (const b of bytes) s += String.fromCharCode(b);
        return btoa(s);`);
      const raw = Buffer.from(zip, "base64").toString("latin1");
      assert.ok(raw.includes("orangey-packs.json"), "the backup does not list the pack");
      assert.ok(raw.includes("mine.orangey.json"), "the backup lost my own table");
      assert.ok(!raw.includes("Delve/theme.orangey.json"), "the pack's table went into the backup");

      // A new computer: restoring offers the pack, from its link.
      await open(page, "#/import", { fresh: true });
      await page.waitForFunction(`document.querySelector(".importer textarea")`);
      await page.evaluate(`
        const bin = atob(${JSON.stringify(zip)});
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const data = new DataTransfer();
        data.items.add(new File([bytes], "orangey-library.zip", { type: "application/zip" }));
        document.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));`);
      await page.waitForFunction(`document.querySelector(".needed-packs .install-needed")`);
      assert.match(await page.evaluate(`return document.querySelector(".needed-packs").textContent`), /Delve by A\. Writer · v1\.0/);
      assert.equal(await page.evaluate(`return !!window.orangey.state.library.findById("mine")`), true);
      await page.click(".install-needed");
      await page.waitForFunction(`document.querySelector(".install-button")`);
      await page.click(".install-button");
      await page.waitForFunction(`location.hash === "#/library" && document.querySelector(".pack-badge")`);
      // The same id as before, so my table's link works again.
      assert.equal(await page.evaluate(`return window.orangey.state.library.findById("theme")?.path`), "Delve/theme.orangey.json");
    } finally {
      rmSync(join(dist, "test-backup-delve.orangey-library.json"), { force: true });
    }
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