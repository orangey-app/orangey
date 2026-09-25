import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveTheme, fixTheme, themeProblems, THEME_TOKENS, type CustomScheme } from "../../src/core/theme.ts";
import { WHEEL_COLOURS, WHEEL_SPARE } from "../../src/core/palette-assign.ts";
import { chroma, contrastRatio, hexToOklab, hexToRgb, hueDifference, labelFor } from "../../src/core/color.ts";

const wheel = [WHEEL_COLOURS[0], WHEEL_COLOURS[1], WHEEL_COLOURS[2], WHEEL_SPARE] as CustomScheme["wheel"];
const orangey: CustomScheme = { name: "Orangey", bg: "#fff8ef", ink: "#253122", accent: "#f3a257", wheel };

test("a theme derives every token, button ink that reads, and lifted cards on a dark ground", () => {
  const t = deriveTheme(orangey);
  assert.deepEqual(Object.keys(t).sort(), [...THEME_TOKENS].sort());
  assert.equal(t["--accent-ink"], labelFor(orangey.accent).ink);
  // Orangey's own colours are readable: the built-in schemes are the standard.
  assert.deepEqual(themeProblems(orangey), []);

  const night = deriveTheme({ ...orangey, bg: "#253122", ink: "#fff3e3" });
  const L = (hex: string) => hexToOklab(hex).L;
  assert.ok(L(night["--bg-raised"]) > L(night["--bg"]), "a card on a dark page should be lighter than the page");
  assert.ok(L(night["--bg-sunken"]) < L(night["--bg"]));
  assert.match(night["--shadow"], /rgba\(0, 0, 0/, "a dark page's shadow is black, not a glow");

  // The error red, the warning amber and the success green keep their hues
  // but not their exact values: on a strong magenta page the built-in red
  // was nearly invisible, so it is moved until it reads, and a danger
  // button's label follows it.
  const magenta = deriveTheme({ ...orangey, bg: "#b0005a", ink: "#ffffff" });
  const on = (a: string, b: string) => contrastRatio(hexToRgb(a), hexToRgb(b));
  for (const token of ["--ok", "--warn", "--error"] as const) {
    for (const surface of ["--bg", "--bg-raised", "--bg-sunken"] as const) {
      assert.ok(on(magenta[token], magenta[surface]) >= 4.5, `${token} on ${surface}: ${on(magenta[token], magenta[surface]).toFixed(2)}`);
    }
  }
  assert.ok(hueDifference(hexToOklab(magenta["--error"]), hexToOklab("#d64545")) <= 10, "the error colour should still be a red");
  assert.ok(on(magenta["--error-ink"], magenta["--error"]) >= 4.5);
});

test("problems are named with their numbers, and the suggestion clears them keeping each hue", () => {
  const grey: CustomScheme = { ...orangey, bg: "#999999", ink: "#888888", wheel: ["#e31f26", "#e41f26", "#006eb8", "#008842"] };
  const problems = themeProblems(grey);
  const text = problems.find((p) => p.pair === "Text on the background");
  assert.ok(text && text.ratio! < 4.5 && text.needs === 4.5 && text.fix === "ink", JSON.stringify(problems));
  assert.ok(problems.some((p) => p.pair === "Wheel 1 and Wheel 2 look alike" && !p.note), "two reds should be reported");

  const { scheme, moved } = fixTheme(grey);
  assert.deepEqual(themeProblems(scheme).filter((p) => !p.note), []);
  assert.ok(moved.length > 0);
  const before = [grey.bg, grey.ink, grey.accent, ...grey.wheel];
  const after = [scheme.bg, scheme.ink, scheme.accent, ...scheme.wheel];
  before.forEach((hex, i) => {
    // A grey has no hue to keep; anything with colour keeps its own.
    if (chroma(hexToOklab(hex)) < 0.02) return;
    assert.ok(hueDifference(hexToOklab(hex), hexToOklab(after[i])) <= 2, `${hex} → ${after[i]} changed hue`);
  });

  // The spare only stands in beside wheel colours 3 and 1, and the assigner
  // skips it where it would clash, so a lookalike spare is a note, not a fault.
  const plan = { ...orangey, bg: "#1b2230", ink: "#e8e2d6", accent: "#e0862f", wheel: ["#c2412f", "#d9a441", "#3d7c8a", "#6b8e4e"] } as CustomScheme;
  assert.deepEqual(themeProblems(plan).filter((p) => !p.note), []);
  assert.ok(themeProblems(plan).some((p) => p.note && p.fix === "wheel3"));
});
