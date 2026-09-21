import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  SETTINGS_FORMAT,
  SETTINGS_VERSION,
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
  test("exporting then importing gives back the same settings, and nothing about this device", () => {
    const text = serializeSettings(portableSettings(prefs()));
    const doc = JSON.parse(text);
    assert.equal(doc.format, SETTINGS_FORMAT);
    assert.equal(doc.version, SETTINGS_VERSION);
    assert.deepEqual(Object.keys(doc.settings), ["scheme", "feel", "seed", "reducedMotionOverridden", "colours"]);
    // Which folder was last open, or where this browser keeps its library, is
    // nobody else's business and meaningless on the machine the file lands on.
    assert.ok(!text.includes("lastPath") && !text.includes("favourites") && !text.includes("backend"));
    assert.ok(text.endsWith("}\n") && !text.includes("\r"));

    const back = parseSettings(text);
    assert.equal(back.scheme, "ocean");
    assert.equal(back.feel.wheel.durationMs, 4200);
    assert.equal(back.feel.mascot.presence, "always");
    assert.deepEqual(back.feel.mascot.rules, { "roll-max": false });
    assert.equal(back.seed, "table 7");
    // My colours come back normalised: the hash added, the hex lower-cased.
    assert.deepEqual(back.colours, [{ name: "Campaign red", hex: "#b3202a" }]);
    assert.equal(serializeSettings(back), text, "the file did not survive a second round trip");
  });

  test("a corrupt or unwelcome file is refused, and the message names the part at fault", () => {
    const settings = (s: Record<string, unknown>) => JSON.stringify({ format: SETTINGS_FORMAT, version: 1, settings: s });
    const cases: [string, string, RegExp][] = [
      ["not JSON at all", "{nope", /not JSON/],
      ["some other app's file", JSON.stringify({ format: "orangey", version: 1, settings: {} }), /file\.format/],
      ["a version we cannot read", JSON.stringify({ format: SETTINGS_FORMAT, version: 99, settings: {} }), /newer Orangey/],
      ["a scheme that does not exist", settings({ scheme: "lava" }), /settings\.scheme/],
      ["a colour that is not a hex", settings({ colours: [{ name: "x", hex: "red" }] }), /colours\[0\]\.hex/],
      ["a colour with no name", settings({ colours: [{ name: "", hex: "#fff" }] }), /colours\[0\]\.name/],
      ["a device-only key smuggled in", settings({ lastPath: "x" }), /settings\.lastPath/],
    ];
    for (const [what, text, message] of cases) {
      assert.throws(() => parseSettings(text), (e: unknown) => {
        assert.ok(e instanceof ValidationError, `${what}: threw ${e}`);
        assert.match(e.message, message, `for ${what}`);
        return true;
      }, `${what} should have been refused`);
    }
    // Refusal is all-or-nothing: a file with one bad field changes nothing,
    // rather than leaving half of someone else's settings applied.
    assert.throws(() => parseSettings(settings({ scheme: "lava", seed: "kept?" })));
  });

  test("a hand-written file works: missing sections default, and timings are clamped to their limits", () => {
    const minimal = parseSettings(JSON.stringify({ format: SETTINGS_FORMAT, version: 1, settings: { scheme: "night" } }));
    assert.equal(minimal.scheme, "night");
    assert.deepEqual(minimal.feel, DEFAULT_FEEL);
    assert.equal(minimal.seed, null);
    assert.deepEqual(minimal.colours, []);

    const doc = JSON.parse(serializeSettings(portableSettings(prefs())));
    doc.settings.feel.wheel.durationMs = 999999;
    doc.settings.feel.wheel.turns = 400;
    doc.settings.feel.mascot.wobble = 40;
    const clamped = parseSettings(JSON.stringify(doc));
    assert.equal(clamped.feel.wheel.durationMs, LIMITS.wheelDuration[1]);
    assert.equal(clamped.feel.wheel.turns, LIMITS.turns[1]);
    assert.equal(clamped.feel.mascot.wobble, LIMITS.mascotWobble[1]);
  });
});
