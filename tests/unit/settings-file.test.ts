import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CUSTOM_COLOURS,
  SETTINGS_FORMAT,
  SETTINGS_VERSION,
  normalizeColours,
  parseSettings,
  portableSettings,
  serializeSettings,
} from "../../src/model/settings-file.ts";
import { DEFAULT_FEEL, LIMITS } from "../../src/ui/feel.ts";
import { ValidationError } from "../../src/model/validate.ts";

const prefs = () => ({
  scheme: "ocean",
  feel: { ...DEFAULT_FEEL, wheel: { ...DEFAULT_FEEL.wheel, durationMs: 4200 }, mascot: { ...DEFAULT_FEEL.mascot, presence: "always" as const, rules: { "roll-max": false } } },
  seed: "table 7",
  reducedMotionOverridden: true,
  colours: [{ name: "Campaign red", hex: "#B3202A" }],
  // device-only things that must not travel
  lastPath: "x.orangey.json",
  favourites: ["a"],
  backend: "opfs" as const,
});

describe("settings file", () => {
  test("carries scheme, feel, seed, the reduced-motion choice and my colours — and nothing about this device", () => {
    const text = serializeSettings(portableSettings(prefs()));
    const doc = JSON.parse(text);
    assert.equal(doc.format, SETTINGS_FORMAT);
    assert.equal(doc.version, SETTINGS_VERSION);
    assert.deepEqual(Object.keys(doc.settings), ["scheme", "feel", "seed", "reducedMotionOverridden", "colours"]);
    assert.equal(doc.settings.scheme, "ocean");
    assert.equal(doc.settings.feel.wheel.durationMs, 4200);
    assert.equal(doc.settings.feel.mascot.presence, "always");
    assert.deepEqual(doc.settings.feel.mascot.rules, { "roll-max": false });
    assert.equal(doc.settings.seed, "table 7");
    assert.deepEqual(doc.settings.colours, [{ name: "Campaign red", hex: "#b3202a" }]);
    assert.ok(!text.includes("lastPath") && !text.includes("favourites") && !text.includes("backend"));
    assert.ok(text.endsWith("}\n") && !text.includes("\r"));
  });

  test("round-trips byte for byte", () => {
    const text = serializeSettings(portableSettings(prefs()));
    assert.equal(serializeSettings(parseSettings(text)), text);
  });

  test("loading clamps every timing into its limits, exactly as the app does on start", () => {
    const doc = JSON.parse(serializeSettings(portableSettings(prefs())));
    doc.settings.feel.wheel.durationMs = 999999;
    doc.settings.feel.wheel.turns = 400;
    doc.settings.feel.mascot.wobble = 40;
    const s = parseSettings(JSON.stringify(doc));
    assert.equal(s.feel.wheel.durationMs, LIMITS.wheelDuration[1]);
    assert.equal(s.feel.wheel.turns, LIMITS.turns[1]);
    assert.equal(s.feel.mascot.wobble, LIMITS.mascotWobble[1]);
  });

  test("a missing section falls back to the defaults, so a hand-written minimal file works", () => {
    const s = parseSettings(JSON.stringify({ format: SETTINGS_FORMAT, version: 1, settings: { scheme: "night" } }));
    assert.equal(s.scheme, "night");
    assert.deepEqual(s.feel, DEFAULT_FEEL);
    assert.equal(s.seed, null);
    assert.deepEqual(s.colours, []);
  });

  test("refuses: not JSON, the wrong format, a newer version, an unknown scheme, a bad colour, an unknown key — each named", () => {
    const refuse = (text: string, re: RegExp) =>
      assert.throws(() => parseSettings(text), (e: unknown) => {
        assert.ok(e instanceof ValidationError, `not a ValidationError: ${e}`);
        assert.match(e.message, re);
        return true;
      });
    refuse("{nope", /not JSON/);
    refuse(JSON.stringify({ format: "orangey", version: 1, settings: {} }), /file\.format/);
    refuse(JSON.stringify({ format: SETTINGS_FORMAT, version: 99, settings: {} }), /newer Orangey/);
    refuse(JSON.stringify({ format: SETTINGS_FORMAT, version: 1, settings: { scheme: "lava" } }), /settings\.scheme/);
    refuse(JSON.stringify({ format: SETTINGS_FORMAT, version: 1, settings: { colours: [{ name: "x", hex: "red" }] } }), /colours\[0\]\.hex/);
    refuse(JSON.stringify({ format: SETTINGS_FORMAT, version: 1, settings: { colours: [{ name: "", hex: "#fff" }] } }), /colours\[0\]\.name/);
    refuse(JSON.stringify({ format: SETTINGS_FORMAT, version: 1, settings: { lastPath: "x" } }), /settings\.lastPath/);
  });

  test("a refused file changes nothing: parse throws before anything is returned", () => {
    assert.throws(() => parseSettings(JSON.stringify({ format: SETTINGS_FORMAT, version: 1, settings: { scheme: "lava", seed: "kept?" } })));
  });
});

describe("my colours", () => {
  test("normalising lower-cases hex, adds the hash, trims names, drops junk and duplicates, and caps the list", () => {
    const raw = [
      { name: "  Campaign red ", hex: "B3202A" },
      { name: "Again", hex: "#b3202a" },
      { name: "", hex: "#123456" },
      { name: "No hex", hex: "reddish" },
      "nonsense",
      { name: "Swamp", hex: "#5A6B2F" },
    ];
    assert.deepEqual(normalizeColours(raw), [
      { name: "Campaign red", hex: "#b3202a" },
      { name: "Swamp", hex: "#5a6b2f" },
    ]);
    const many = Array.from({ length: MAX_CUSTOM_COLOURS + 10 }, (_, i) => ({ name: `c${i}`, hex: `#${(i * 2654435).toString(16).padStart(6, "0").slice(-6)}` }));
    assert.equal(normalizeColours(many).length, MAX_CUSTOM_COLOURS);
    assert.deepEqual(normalizeColours(undefined), []);
  });
});
