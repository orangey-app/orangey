/**
 * Take the README's screenshots from the built app.
 *
 *   npm run build:single && node scripts/screenshots.mjs
 *
 * Writes docs/screenshot-*.png. Every shot starts from empty storage, builds
 * its own library through the app's debug handle, and rolls with a fixed
 * seed (or the first of a fixed series that shows what the picture is for),
 * so running it twice gives the same pictures and a change to the app
 * shows up as a change in the images rather than in what happened to come up.
 * It drives Chrome the way the browser tests do (tests/browser/cdp.mjs), so
 * CHROME_PATH works here too.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, serve } from "../tests/browser/cdp.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const example = (path) => JSON.parse(readFileSync(join(root, "examples", path), "utf8")).randomizer;

let server;

/** A page with an empty library, at the given size. */
async function fresh(browser, width, height) {
  const page = await browser.newPage();
  await page.setViewport(width, height);
  await page.goto(`${server.origin}/index.html?debug&noseed`);
  await page.waitForFunction("window.orangey");
  await page.clearStorage(server.origin);
  await page.goto(`${server.origin}/index.html?debug&noseed`);
  await page.waitForFunction("window.orangey");
  return page;
}

/** Store randomizers (whole objects, as in a file) and return their paths. */
const store = (page, folder, randomizers) =>
  page.evaluate(`
    const { state } = window.orangey;
    const paths = [];
    const folder = ${JSON.stringify(folder)};
    if (folder && !state.library.find(folder)) await state.library.createFolder("", folder);
    for (const r of ${JSON.stringify(randomizers)}) paths.push(await state.library.create(${JSON.stringify(folder)}, r));
    await state.library.flush();
    return paths;
  `);

const now = "2026-09-24T12:00:00.000Z";
const wheel = (id, name, items, extra = {}) => ({
  id, type: "list", name, view: "wheel", created: now, modified: now,
  items: items.map(([label, weight, more], n) => ({ id: `${id}-${n}`, label, weight, ...more })),
  ...extra,
});
const dice = (id, name, expression, extra = {}) => ({ id, type: "dice", name, expression, created: now, modified: now, ...extra });
const board = (id, name, entries, extra = {}) => ({ id, type: "board", name, created: now, modified: now, entries, ...extra });

/** A few folders, so the library panel looks like someone's library. */
async function furnish(page) {
  await store(page, "Board games", [example("boardgames/who-goes-first.orangey.json")]);
  await store(page, "Dice", [example("dnd/advantage.orangey.json"), example("dnd/attack-roll.orangey.json")]);
  await store(page, "Encounters", [example("dnd/minor-treasure.orangey.json")]);
  await store(page, "", [example("generic/yes-no.orangey.json")]);
}

/** Seed the next rolls, so every run shows the same answers. */
const seed = (page, value) =>
  page.evaluate(`
    const { state } = window.orangey;
    await state.savePrefs({ seed: ${JSON.stringify(value)} });
    state.resetSeedSequence();
  `);

/**
 * Navigate, once everything written so far is stored. `debug: false` loads
 * the app without its test handle, for a shot where the address shows.
 */
async function go(page, hash, { debug = true } = {}) {
  await page.evaluate(`await window.orangey?.state.library.flush(); await window.orangey?.storageSettled()`);
  // Without the debug handle nothing can seed the library behind our back
  // any more (it is only seeded when empty), so no ?noseed either.
  await page.goto(`${server.origin}/index.html${debug ? "?debug&noseed" : ""}${hash}`);
  await page.waitForFunction(debug ? "window.orangey" : `document.querySelector(".topbar")`);
  // The fonts are embedded, but a face is only decoded once something asks
  // for it. Headless Chrome draws scrollbars; a README picture does not want them.
  await page.evaluate(`
    await document.fonts.ready;
    const style = document.createElement("style");
    // The seed line under an answer is for whoever set a seed; in a README
    // picture it only raises a question.
    style.textContent = "html, body, * { scrollbar-width: none; } .result-meta { visibility: hidden; }";
    document.head.append(style);
  `);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Press `press` (one selector or several, in turn) with seed readme-1,
 * readme-2, … until `check` holds, and leave the page
 * showing that roll. The seeds are tried in order, so the same app always
 * stops at the same one; a change to the app that moves the answer only
 * moves which seed is used.
 */
async function rollUntil(page, hash, { press, settled, check }) {
  for (let n = 1; n <= 100; n++) {
    await seed(page, `readme-${n}`);
    await go(page, hash);
    for (const selector of [press].flat()) {
      await page.click(selector);
      await page.waitForFunction(settled);
      await sleep(300);
    }
    if (await page.evaluate(`return Boolean(${check})`)) return n;
  }
  throw new Error(`no seed up to readme-100 gave ${check}`);
}

const open = (page, path) => go(page, `#/r/${encodeURIComponent(path)}`);

/** Let the last frame paint, then write the page as it stands. */
async function shoot(page, name) {
  await new Promise((r) => setTimeout(r, 400));
  const { data } = await page.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(root, "docs", `screenshot-${name}.png`), Buffer.from(data, "base64"));
  if (page.consoleErrors.length) throw new Error(`${name}: page errors: ${page.consoleErrors.join(" | ")}`);
  console.log(`docs/screenshot-${name}.png`);
}

const landed = (selector = ".result-value") =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].every((e) => e.textContent.trim() && e.textContent !== "Ready")`;

const twelve = wheel("twelve", "Twelve encounters", [
  ["Goblin patrol", 30], ["Wolf pack", 12], ["Merchant", 12], ["Nothing", 9], ["Bandits", 7], ["Owlbear", 6],
  ["Lost travellers", 5], ["Ruined shrine", 3], ["Fairy ring", 2], ["Hunters", 2], ["Will-o'-wisp", 1], ["Young green dragon", 1],
]);

const SHOTS = {
  async play(browser) {
    const page = await fresh(browser, 1100, 860);
    await furnish(page);
    const [path] = await store(page, "", [twelve]);
    await page.evaluate(`window.orangey.state.setFeel({ motion: "instant" })`);
    await seed(page, "readme");
    await open(page, path);
    await page.click(".roll-button");
    await page.waitForFunction(landed());
    await shoot(page, "play");
    await page.close();
  },

  async editor(browser) {
    const page = await fresh(browser, 1280, 860);
    await furnish(page);
    const forest = example("dnd/forest-encounters.orangey.json");
    // The editor's Orangey column, filled in the way a game master would.
    forest.items.find((i) => i.label === "Nothing").reaction = "cheer";
    forest.items.find((i) => i.label.includes("dragon")).reaction = "wince";
    const [path] = await store(page, "Encounters", [forest]);
    await go(page, `#/edit/${encodeURIComponent(path)}`);
    await page.waitForFunction(`document.querySelector(".editor")`);
    await shoot(page, "editor");
    await page.close();
  },

  async dice(browser) {
    const page = await fresh(browser, 900, 700);
    const [path] = await store(page, "", [dice("all-dice", "Every die", "d4 + d6 + d8 + d10 + d12 + d20 + d100", { description: "One of each" })]);
    await page.evaluate(`window.orangey.state.setFeel({ motion: "instant", dice: { style: "wireframe" } })`);
    await seed(page, "readme");
    await open(page, path);
    await page.click(".roll-button");
    await page.waitForFunction(landed());
    await shoot(page, "dice");
    await page.close();
  },

  async board(browser) {
    const page = await fresh(browser, 1440, 900);
    await furnish(page);
    const forest = wheel("forest", "Forest encounters", [
      ["Goblin patrol", 30], ["Wolf pack", 20], ["Merchant", 20], ["Bandits", 15], ["Nothing", 15],
    ], { description: "Daytime, levels 1–4" });
    // Anyone met on the road sends the table on to what they carry, which is
    // what puts a chain on the board.
    for (const item of forest.items) if (["Goblin patrol", "Merchant", "Bandits"].includes(item.label)) item.goesTo = "loot";
    const loot = wheel("loot", "What they carry", [["Copper and lint", 5], ["A silver ring", 3], ["A map", 2]]);
    const weather = wheel("weather", "Weather", [["Clear", 40], ["Rain", 30], ["Fog", 20], ["Storm", 10]]);
    const ability = example("dnd/ability-score.orangey.json");
    await store(page, "Encounters", [forest, loot, weather]);
    await store(page, "Dice", [ability]);
    const [path] = await store(page, "", [board("tonight", "Tonight's table", [
      { id: "forest", name: forest.name }, { id: "weather", name: weather.name }, { id: ability.id, name: ability.name },
    ], { description: "What the forest does while they walk" })]);
    await page.evaluate(`window.orangey.state.setFeel({ motion: "instant" })`);
    await rollUntil(page, `#/r/${encodeURIComponent(path)}`, {
      // Roll all answers everything but follows no links; the encounter
      // cell's own Roll is what opens one.
      press: [".roll-all", ".cell-holder .cell-roll"],
      settled: `${landed(".cell-holder:not(.board-chain) .result-value")} && !document.querySelector(".die-slot.rolling")`,
      check: `document.querySelector(".board-chain")`,
    });
    await shoot(page, "board");
    await page.close();
  },

  async pictures(browser) {
    const page = await fresh(browser, 1280, 1040);
    await furnish(page);
    // Small painted scenes, drawn here so the repository carries no image
    // files of its own for the README.
    const ids = await page.evaluate(`
      const scene = (sky, ground, figure, shape) => {
        const c = document.createElement("canvas");
        c.width = 240; c.height = 180;
        const g = c.getContext("2d");
        g.fillStyle = sky; g.fillRect(0, 0, 240, 180);
        g.fillStyle = ground; g.fillRect(0, 118, 240, 62);
        g.fillStyle = "rgba(0,0,0,0.35)";
        for (let x = 10; x < 240; x += 38) { g.beginPath(); g.moveTo(x, 118); g.lineTo(x + 16, 60); g.lineTo(x + 32, 118); g.fill(); }
        g.fillStyle = figure;
        if (shape === "wide") { g.beginPath(); g.ellipse(120, 104, 58, 26, 0, 0, Math.PI * 2); g.fill(); g.beginPath(); g.arc(170, 84, 18, 0, Math.PI * 2); g.fill(); }
        else if (shape === "cart") { g.fillRect(70, 84, 100, 34); g.beginPath(); g.arc(90, 124, 12, 0, Math.PI * 2); g.arc(150, 124, 12, 0, Math.PI * 2); g.fill(); }
        else if (shape === "many") { for (const x of [70, 120, 170]) { g.beginPath(); g.arc(x, 82, 12, 0, Math.PI * 2); g.fill(); g.fillRect(x - 9, 94, 18, 30); } }
        else { g.beginPath(); g.arc(120, 72, 22, 0, Math.PI * 2); g.fill(); g.fillRect(106, 94, 28, 40); }
        return c.toDataURL("image/png");
      };
      const put = (d) => window.orangey.images.putImageData(d);
      return {
        goblins: await put(scene("#9fb6c8", "#4f6b3a", "#6f8f3a", "many")),
        merchant: await put(scene("#e8d8b0", "#8a6a44", "#b0843c", "cart")),
        wolves: await put(scene("#7b8aa0", "#3d4a58", "#2b3038", "wide")),
        dragon: await put(scene("#c9876c", "#6e4436", "#8f2f24", "figure")),
      };
    `);
    const forest = wheel("pictured", "Forest encounters", [
      ["Goblin patrol", 30, { image: ids.goblins }], ["Merchant", 25, { image: ids.merchant }],
      ["Wolf pack", 25, { image: ids.wolves }], ["A dragon!", 10, { image: ids.dragon, goesTo: "dragons" }], ["Nothing", 10],
    ], { description: "With a portrait on each encounter" });
    const dragons = wheel("dragons", "Which dragon", [["Young green", 6], ["Adult red", 3], ["Ancient black", 1]]);
    const [path] = await store(page, "Encounters", [forest, dragons]);
    await page.evaluate(`window.orangey.state.setFeel({ motion: "instant" })`);
    await rollUntil(page, `#/r/${encodeURIComponent(path)}`, {
      press: ".roll-button",
      // Only the wheel's own answer: a randomizer the chain opens waits at Ready.
      settled: `!["", "Ready"].includes(document.querySelector(".result-value").textContent.trim())`,
      check: `document.querySelector(".result-value").textContent === "A dragon!" && document.querySelector(".chain-link")`,
    });
    await shoot(page, "pictures");
    await page.close();
  },

  async link(browser) {
    const page = await fresh(browser, 900, 640);
    const [path] = await store(page, "", [example("dnd/forest-encounters.orangey.json")]);
    // Without ?debug, which would otherwise show in the link being built.
    await go(page, `#/r/${encodeURIComponent(path)}`, { debug: false });
    await page.waitForFunction(`document.querySelector(".link-button")`);
    await page.click(".link-button");
    await page.waitForFunction(`document.querySelector("dialog[open]")`);
    await shoot(page, "link");
    await page.close();
  },

  async presenting(browser) {
    const page = await fresh(browser, 900, 640);
    const forest = example("dnd/forest-encounters.orangey.json");
    await store(page, "", [forest]);
    await page.evaluate(`window.orangey.state.setFeel({ motion: "instant" })`);
    await seed(page, "readme");
    // Exactly the link a slide would carry.
    await go(page, `#/id/${encodeURIComponent(forest.id)}?roll=1&present=1`);
    await page.waitForFunction(landed());
    await shoot(page, "presenting");
    await page.close();
  },
};

async function main() {
  const only = process.argv.slice(2);
  server = await serve(join(root, "dist"));
  const browser = await launch();
  try {
    for (const [name, take] of Object.entries(SHOTS)) {
      if (only.length && !only.includes(name)) continue;
      await take(browser);
    }
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
