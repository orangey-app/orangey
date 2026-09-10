import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { backTarget, isLinkableBase, parseRoute, slideLink } from "../../src/ui/router.ts";

describe("routes", () => {
  test("the usual routes parse", () => {
    assert.deepEqual(parseRoute(""), { name: "play", params: { roll: false, present: false } });
    assert.deepEqual(parseRoute("#/"), { name: "play", params: { roll: false, present: false } });
    assert.equal(parseRoute("#/library").name, "library");
    assert.equal(parseRoute("#/import").name, "import");
    assert.equal(parseRoute("#/history").name, "history");
    assert.equal(parseRoute("#/settings").name, "settings");
    assert.equal(parseRoute("#/nonsense").name, "play");
  });

  test("paths are decoded, including slashes and ampersands", () => {
    const route = parseRoute("#/r/D%26D%2FEncounters%2Fforest.orangey.json");
    assert.equal(route.name, "randomizer");
    assert.equal(route.name === "randomizer" && route.path, "D&D/Encounters/forest.orangey.json");
  });

  test("an id route addresses a randomizer by its identity", () => {
    const route = parseRoute("#/id/5f1c-abc");
    assert.equal(route.name, "byId");
    assert.equal(route.name === "byId" && route.id, "5f1c-abc");
  });

  test("an empty argument falls back rather than looking things up by nothing", () => {
    assert.equal(parseRoute("#/r/").name, "play");
    assert.equal(parseRoute("#/id/").name, "play");
    assert.equal(parseRoute("#/edit/").name, "library");
  });

  test("link parameters are read, and only when they mean yes", () => {
    assert.deepEqual(parseRoute("#/id/x?roll=1").params, { roll: true, present: false });
    assert.deepEqual(parseRoute("#/id/x?roll=1&present=1").params, { roll: true, present: true });
    assert.deepEqual(parseRoute("#/id/x?roll").params, { roll: true, present: false });
    assert.deepEqual(parseRoute("#/id/x?roll=0").params, { roll: false, present: false });
    assert.deepEqual(parseRoute("#/id/x?roll=false").params, { roll: false, present: false });
    assert.deepEqual(parseRoute("#/id/x?present=no").params, { roll: false, present: false });
  });

  test("a query does not leak into the path", () => {
    const route = parseRoute("#/r/forest.orangey.json?roll=1");
    assert.equal(route.name === "randomizer" && route.path, "forest.orangey.json");
  });
});

describe("links for slides", () => {
  const base = "https://amoghkit.github.io/orangey/";

  test("a link addresses the randomizer by id, so renaming cannot break a deck", () => {
    assert.equal(slideLink(base, "forest-1"), "https://amoghkit.github.io/orangey/#/id/forest-1");
  });

  test("options become query parameters", () => {
    assert.equal(slideLink(base, "a", { roll: true }), `${base}#/id/a?roll=1`);
    assert.equal(slideLink(base, "a", { present: true }), `${base}#/id/a?present=1`);
    assert.equal(slideLink(base, "a", { roll: true, present: true }), `${base}#/id/a?roll=1&present=1`);
  });

  test("an existing fragment on the base is replaced, not appended to", () => {
    assert.equal(slideLink(`${base}#/settings`, "a", { roll: true }), `${base}#/id/a?roll=1`);
  });

  test("ids are escaped", () => {
    assert.equal(slideLink(base, "an id/with slashes"), `${base}#/id/an%20id%2Fwith%20slashes`);
  });

  test("what comes out goes back in", () => {
    for (const id of ["plain", "with space", "with/slash", "with&amp", "5f1c-0000-4000"]) {
      for (const options of [{}, { roll: true }, { present: true }, { roll: true, present: true }]) {
        const link = slideLink(base, id, options);
        const route = parseRoute(link.slice(link.indexOf("#")));
        assert.equal(route.name, "byId");
        assert.equal(route.name === "byId" && route.id, id);
        assert.equal(route.params.roll, options.roll === true);
        assert.equal(route.params.present, options.present === true);
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
  test("an editor goes back to the randomizer it edits, whatever was played last", () => {
    assert.equal(backTarget(parseRoute("#/edit/Games/wheel.orangey.json"), "other.orangey.json", () => true), "#/r/Games%2Fwheel.orangey.json");
  });

  test("elsewhere it goes to the last played randomizer while that still exists, else to play", () => {
    const settings = parseRoute("#/settings");
    assert.equal(backTarget(settings, "a.orangey.json", () => true), "#/r/a.orangey.json");
    assert.equal(backTarget(settings, "a.orangey.json", () => false), "#/");
    assert.equal(backTarget(settings, null, () => true), "#/");
    assert.equal(backTarget(parseRoute("#/history"), "d/e.orangey.json", (p) => p === "d/e.orangey.json"), "#/r/d%2Fe.orangey.json");
  });
});
