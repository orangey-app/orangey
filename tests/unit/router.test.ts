import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { backTarget, isLinkableBase, parseRoute, slideLink, wheelLink } from "../../src/ui/router.ts";

describe("routes", () => {
  test("every route shape parses", () => {
    const cases: [string, string, Record<string, unknown>][] = [
      ["an empty hash is the play screen", "", { name: "play" }],
      ["a bare hash is too", "#/", { name: "play" }],
      ["the library", "#/library", { name: "library" }],
      ["the importer", "#/import", { name: "import" }],
      ["the history", "#/history", { name: "history" }],
      ["the settings", "#/settings", { name: "settings" }],
      // an unknown route is a typo or an old link, not an error page
      ["anything unknown", "#/nonsense", { name: "play" }],
      ["a randomizer by path", "#/r/forest.orangey.json", { name: "randomizer", path: "forest.orangey.json" }],
      // a path may carry the separators that a folder name is made of
      ["a path with slashes and ampersands", "#/r/D%26D%2FEncounters%2Fforest.orangey.json", { name: "randomizer", path: "D&D/Encounters/forest.orangey.json" }],
      ["a randomizer by identity", "#/id/5f1c-abc", { name: "byId", id: "5f1c-abc" }],
      ["an editor", "#/edit/Games%2Fwheel.orangey.json", { name: "edit", path: "Games/wheel.orangey.json" }],
      // the whole randomizer travels inside the link itself
      ["a linked randomizer", "#/roll?w=0abc-_123", { name: "linked", payload: "0abc-_123" }],
      ["a linked randomizer that rolls and presents", "#/roll?w=0abc&roll=1&present=1", { name: "linked", payload: "0abc" }],
      ["a roll route carrying nothing", "#/roll?w=", { name: "play" }],
      // a query must never be mistaken for part of what it qualifies
      ["a query beside a path", "#/r/forest.orangey.json?roll=1", { name: "randomizer", path: "forest.orangey.json" }],
      // an empty argument means look nothing up, so fall back rather than 404
      ["a path route with no path", "#/r/", { name: "play" }],
      ["an id route with no id", "#/id/", { name: "play" }],
      ["an editor with nothing to edit", "#/edit/", { name: "library" }],
    ];
    for (const [what, hash, expected] of cases) {
      const route = parseRoute(hash) as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(expected)) assert.equal(route[key], value, `${what}: ${key}`);
    }
    assert.deepEqual(parseRoute("#/roll?w=0abc&roll=1&present=1").params, { roll: true, present: true });
  });

  test("link parameters are read, and only when they mean yes", () => {
    const cases: [string, { roll: boolean; present: boolean }][] = [
      ["#/id/x", { roll: false, present: false }],
      ["#/id/x?roll=1", { roll: true, present: false }],
      ["#/id/x?roll=1&present=1", { roll: true, present: true }],
      // a bare flag is a yes: a deck author writing ?roll meant it
      ["#/id/x?roll", { roll: true, present: false }],
      ["#/id/x?roll=0", { roll: false, present: false }],
      ["#/id/x?roll=false", { roll: false, present: false }],
      ["#/id/x?present=no", { roll: false, present: false }],
    ];
    for (const [hash, expected] of cases) assert.deepEqual(parseRoute(hash).params, expected, hash);
  });
});

describe("links for slides", () => {
  const base = "https://amoghkit.github.io/orangey/";

  test("a slide link addresses the randomizer by id, escaped, with its options as a query", () => {
    // By id rather than by path, so renaming or moving a wheel cannot break a
    // deck that was built months ago.
    assert.equal(slideLink(base, "forest-1"), "https://amoghkit.github.io/orangey/#/id/forest-1");
    assert.equal(slideLink(base, "a", { roll: true }), `${base}#/id/a?roll=1`);
    assert.equal(slideLink(base, "a", { present: true }), `${base}#/id/a?present=1`);
    assert.equal(slideLink(base, "a", { roll: true, present: true }), `${base}#/id/a?roll=1&present=1`);
    assert.equal(slideLink(base, "an id/with slashes"), `${base}#/id/an%20id%2Fwith%20slashes`);
    // The base may already be sitting on a route; that fragment is replaced.
    assert.equal(slideLink(`${base}#/settings`, "a", { roll: true }), `${base}#/id/a?roll=1`);
  });

  test("what comes out of a link builder goes back into the router", () => {
    for (const id of ["plain", "with space", "with/slash", "with&amp", "5f1c-0000-4000"]) {
      for (const options of [{}, { roll: true }, { present: true }, { roll: true, present: true }]) {
        const link = slideLink(base, id, options);
        const route = parseRoute(link.slice(link.indexOf("#")));
        assert.equal(route.name, "byId");
        assert.equal(route.name === "byId" && route.id, id);
        assert.equal(route.params.roll, options.roll === true);
        assert.equal(route.params.present, options.present === true);

        const carried = wheelLink(base, "0payload-_9", options);
        const inside = parseRoute(carried.slice(carried.indexOf("#")));
        assert.equal(inside.name, "linked");
        assert.equal(inside.name === "linked" && inside.payload, "0payload-_9");
        assert.equal(inside.params.roll, options.roll === true);
        assert.equal(inside.params.present, options.present === true);
      }
    }
  });

  test("only an http address can be linked to from a slide", () => {
    // Browsers refuse to follow a link from a web page to a local file, so a
    // deck cannot open a downloaded copy of Orangey.
    assert.equal(isLinkableBase("https://example.test/orangey/"), true);
    assert.equal(isLinkableBase("http://127.0.0.1:8080/index.html"), true);
    assert.equal(isLinkableBase("file:///home/amogh/orangey.html"), false);
    assert.equal(isLinkableBase("about:blank"), false);
  });
});

describe("back", () => {
  test("an editor goes back to what it edits; elsewhere, to the last played randomizer that still exists", () => {
    const settings = parseRoute("#/settings");
    assert.equal(
      backTarget(parseRoute("#/edit/Games/wheel.orangey.json"), "other.orangey.json", () => true),
      "#/r/Games%2Fwheel.orangey.json",
      "an editor ignores whatever was played last",
    );
    assert.equal(backTarget(settings, "a.orangey.json", () => true), "#/r/a.orangey.json");
    assert.equal(backTarget(settings, "a.orangey.json", () => false), "#/", "a deleted randomizer is not a place to go back to");
    assert.equal(backTarget(settings, null, () => true), "#/");
    assert.equal(backTarget(parseRoute("#/history"), "d/e.orangey.json", (p) => p === "d/e.orangey.json"), "#/r/d%2Fe.orangey.json");
  });
});
