/**
 * Your own theme: four choices in, every colour the app paints with out.
 *
 * A person picks a background, a text colour, an accent and the wheel's
 * colours; the thirteen tokens a scheme defines are derived from those, the
 * way the built-in schemes relate theirs — borders are the background moved
 * toward the text, faint text is the text moved toward the background, and so
 * on. Pure and DOM-free (P20): the settings screen and `state.applyTheme()`
 * call it, and it is tested under `node --test`.
 *
 * Readability is checked, not assumed. `themeProblems` names every pair that
 * fails and which of the four inputs to move; `fixTheme` proposes the closest
 * readable version — the same hues, each nudged in lightness as little as
 * will do — which the person may take or leave.
 */

import { contrastRatio, hexToOklab, hexToRgb, labelFor, mix, oklabToRgb, rgbToHex, type Oklab } from "./color.ts";
import { DEFAULT_THRESHOLDS, distinct, toCandidate } from "./palette-assign.ts";

export interface CustomScheme {
  /** What it is called on its card in Settings. 1..40 characters. */
  name: string;
  bg: string;
  ink: string;
  accent: string;
  /** The wheel's colours: three in turn, then the spare. */
  wheel: [string, string, string, string];
}

export const THEME_NAME_MAX = 40;

/** The custom properties a scheme defines, in `ui/styles/tokens.css`. */
export const THEME_TOKENS = [
  "--bg", "--bg-raised", "--bg-sunken", "--border", "--border-strong",
  "--ink", "--ink-soft", "--ink-faint",
  "--accent", "--accent-ink", "--accent-soft", "--accent-strong",
  "--shadow",
  "--ok", "--warn", "--error", "--error-ink",
] as const;
export type ThemeToken = (typeof THEME_TOKENS)[number];

/** The input a problem is solved by moving. */
export type ThemeInput = "bg" | "ink" | "accent" | "wheel0" | "wheel1" | "wheel2" | "wheel3";

export interface ThemeProblem {
  /** The pair, in words: "Text on the background". */
  pair: string;
  /** The contrast it has, for a contrast rule; absent for "too alike". */
  ratio?: number;
  /** The contrast it needs. */
  needs?: number;
  /** Which of the person's colours to move. */
  fix: ThemeInput;
  /** For two wheel colours alike: the one it is too like. */
  against?: ThemeInput;
  /**
   * Worth knowing, not a failure: a spare that looks like a wheel colour it
   * may sit beside is simply skipped there, so nothing on screen clashes.
   */
  note?: true;
}

const WHITE_HEX = "#ffffff";
const BLACK_HEX = "#000000";

/** Is this a dark background? The one white text reads better on. */
function isDark(bg: string): boolean {
  const rgb = hexToRgb(bg);
  return contrastRatio(rgb, hexToRgb(WHITE_HEX)) > contrastRatio(rgb, hexToRgb(BLACK_HEX));
}

function ratio(a: string, b: string): number {
  return contrastRatio(hexToRgb(a), hexToRgb(b));
}

/**
 * The thirteen tokens, from the four choices.
 *
 * Raised surfaces are lighter and sunken ones darker on either kind of ground,
 * as in both Orangey and Night; how far differs, because a light page wants
 * nearly white cards and a dark one only a slightly lifted shade. The
 * proportions are the built-in schemes' own, measured: borders 12 % and 28 %
 * toward the text, soft and faint text 25 % and 50 % toward the background.
 */
export function deriveTheme(s: CustomScheme): Record<ThemeToken, string> {
  const dark = isDark(s.bg);
  const { r, g, b } = hexToRgb(s.ink);
  const shade = (a: number) => `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`;
  const raised = mix(s.bg, WHITE_HEX, dark ? 0.06 : 0.75);
  const sunken = mix(s.bg, BLACK_HEX, dark ? 0.17 : 0.04);
  // Warnings and errors are read on the page, on cards and on sunken panels.
  const surfaces = [s.bg, raised, sunken];
  const lighter = hexToOklab(s.ink).L > hexToOklab(s.bg).L;
  const error = statusColour(STATUS_BASE["--error"], surfaces, lighter);
  return {
    "--bg": s.bg,
    "--bg-raised": raised,
    "--bg-sunken": sunken,
    "--border": mix(s.bg, s.ink, 0.12),
    "--border-strong": mix(s.bg, s.ink, 0.28),
    "--ink": s.ink,
    "--ink-soft": mix(s.ink, s.bg, 0.25),
    "--ink-faint": mix(s.ink, s.bg, 0.5),
    "--accent": s.accent,
    "--accent-ink": labelFor(s.accent).ink,
    "--accent-soft": mix(s.accent, s.bg, 0.75),
    "--accent-strong": mix(s.accent, s.ink, 0.1),
    // Night's shadow is black and deeper, Orangey's the text colour and
    // faint: a light "shadow" on a dark page would read as a glow.
    "--shadow": dark
      ? "0 1px 2px rgba(0, 0, 0, 0.45), 0 6px 18px rgba(0, 0, 0, 0.35)"
      : `0 1px 2px ${shade(0.08)}, 0 6px 18px ${shade(0.07)}`,
    "--ok": statusColour(STATUS_BASE["--ok"], surfaces, lighter),
    "--warn": statusColour(STATUS_BASE["--warn"], surfaces, lighter),
    "--error": error,
    // A danger button is filled with the error colour, and its label must
    // read on that too: a red lightened for a dark page takes dark ink.
    "--error-ink": labelFor(error).ink,
  };
}

/** The built-in status colours, whose hues a theme keeps. */
const STATUS_BASE = { "--ok": "#3f9c5a", "--warn": "#d38b1f", "--error": "#d64545" } as const;
/** Status colours are read as text — "Clear", a warning, a failed import — so they need what body text needs. */
const STATUS_RATIO = 4.5;

/**
 * A status colour that reads on every surface of this theme.
 *
 * The same green, amber and red as the built-in schemes, kept exactly where
 * they already read, and otherwise moved in lightness just far enough — the
 * way the theme's own text lies from the page, lighter or darker, since that
 * is the side known to read. A red is still a red; it is only never lost on a
 * strong background of its own kind.
 */
function statusColour(base: string, surfaces: readonly string[], lighter: boolean): string {
  const worst = (hex: string) => Math.min(...surfaces.map((s) => ratio(hex, s)));
  let best = base;
  let hex = base;
  for (let k = 0; k < 60 && worst(hex) < STATUS_RATIO; k++) {
    const next = withLightness(hex, hexToOklab(hex).L + (lighter ? 0.01 : -0.01));
    if (next === hex) break;
    hex = next;
    if (worst(hex) > worst(best)) best = hex;
  }
  return worst(hex) >= STATUS_RATIO ? hex : best;
}

/** The contrast a wheel colour's label reaches with whichever ink suits it. */
function labelRatio(fill: string): number {
  return labelFor(fill, 0, 0).ratio;
}

/** Wheel colours a label is read on need this much, like large text. */
export const WHEEL_LABEL_RATIO = 3;

/**
 * The wheel's colours on their own, for the theme and for a wheel's own
 * palette alike.
 *
 * The three in turn must each carry a readable label and be told apart from
 * the one after it, including the third from the first — a wheel is a cycle.
 * The spare only ever stands in between the third and the first, when the
 * turn's own colour would look like a neighbour; if it looks like one of
 * those, the colour assigner skips it there, so that is a note, not a fault.
 */
export function wheelProblems(wheel: readonly string[]): ThemeProblem[] {
  const out: ThemeProblem[] = [];
  const names = ["Wheel 1", "Wheel 2", "Wheel 3", "Spare"];
  wheel.forEach((hex, i) => {
    const got = labelRatio(hex);
    if (got < WHEEL_LABEL_RATIO) {
      out.push({ pair: `Labels on ${names[i]}`, ratio: got, needs: WHEEL_LABEL_RATIO, fix: `wheel${i}` as ThemeInput });
    }
  });
  const cands = wheel.map(toCandidate);
  for (const [i, j] of [[0, 1], [1, 2], [2, 0]] as const) {
    // Move the later of the pair, and for the wrap-around the third: the first
    // colour is the one a wheel is most recognised by.
    if (!distinct(cands[i], cands[j], DEFAULT_THRESHOLDS)) {
      const moved = j === 0 ? i : j;
      const other = moved === i ? j : i;
      out.push({ pair: `${names[i]} and ${names[j]} look alike`, fix: `wheel${moved}` as ThemeInput, against: `wheel${other}` as ThemeInput });
    }
  }
  if (cands.length > 3) {
    for (const i of [2, 0]) {
      if (!distinct(cands[3], cands[i], DEFAULT_THRESHOLDS)) {
        out.push({ pair: `Spare and ${names[i]} look alike`, fix: "wheel3", against: `wheel${i}` as ThemeInput, note: true });
      }
    }
  }
  return out;
}

/** Every pair that matters, with its numbers. An empty list is a readable theme. */
export function themeProblems(s: CustomScheme): ThemeProblem[] {
  const t = deriveTheme(s);
  const out: ThemeProblem[] = [];
  const need = (pair: string, a: string, b: string, needs: number, fix: ThemeInput) => {
    const got = ratio(a, b);
    if (got < needs) out.push({ pair, ratio: got, needs, fix });
  };
  need("Text on the background", t["--ink"], t["--bg"], 4.5, "ink");
  need("Soft text on the background", t["--ink-soft"], t["--bg"], 4.5, "ink");
  need("Faint text on the background", t["--ink-faint"], t["--bg"], 3, "ink");
  need("Button text on the accent", t["--accent-ink"], t["--accent"], 4.5, "accent");
  // Not checked: the accent against the page. Every built-in light scheme
  // would fail 3 : 1 there (Orangey's orange on cream is about 2), and a
  // button is known by its text, which the line above checks.
  return [...out, ...wheelProblems(s.wheel)];
}

// ---- the suggestion ---------------------------------------------------------

/** A colour at this lightness, same hue; chroma comes down only if the colour would not exist. */
function withLightness(hex: string, L: number): string {
  const lab = hexToOklab(hex);
  const target: Oklab = { L: Math.min(1, Math.max(0, L)), a: lab.a, b: lab.b };
  for (let k = 0; k < 24; k++) {
    const rgb = oklabToRgb(target);
    const inside = [rgb.r, rgb.g, rgb.b].every((v) => v >= -0.0005 && v <= 1.0005);
    if (inside) return rgbToHex(rgb);
    target.a *= 0.9;
    target.b *= 0.9;
  }
  return rgbToHex(oklabToRgb(target));
}

function getInput(s: CustomScheme, key: ThemeInput): string {
  return key.startsWith("wheel") ? s.wheel[Number(key.slice(5))] : s[key as "bg" | "ink" | "accent"];
}

function setInput(s: CustomScheme, key: ThemeInput, hex: string): CustomScheme {
  if (!key.startsWith("wheel")) return { ...s, [key]: hex };
  const wheel = [...s.wheel] as CustomScheme["wheel"];
  wheel[Number(key.slice(5))] = hex;
  return { ...s, wheel };
}

/** Is this particular problem still there? Found again by what it says, since the numbers move. */
function stillFails(s: CustomScheme, p: ThemeProblem): boolean {
  return themeProblems(s).some((q) => q.pair === p.pair && !q.note);
}

/**
 * The ways out of a problem, tried in order from where the scheme stands; the
 * first that clears it is taken. Each way is a sequence of moves: the text
 * away from the background, and only if that is not enough the background
 * away from the text; a colour towards the extreme its label is not, or else
 * the other way, because a colour already near white cannot get lighter.
 */
function waysOut(s: CustomScheme, p: ThemeProblem): { key: ThemeInput; step: number }[][] {
  const L = (hex: string) => hexToOklab(hex).L;
  const STEP = 0.02;
  if (p.fix === "ink") {
    const up = L(s.ink) >= L(s.bg) ? STEP : -STEP;
    return [[{ key: "ink", step: up }], [{ key: "ink", step: up }, { key: "bg", step: -up }]];
  }
  const own = getInput(s, p.fix);
  let first: number;
  if (p.fix === "accent" || p.ratio !== undefined) {
    first = labelFor(own).ink === WHITE_HEX ? -STEP : STEP;
  } else {
    // Two wheel colours alike: away from the other one's lightness.
    const partner = getInput(s, p.against ?? p.fix);
    first = L(own) >= L(partner) ? STEP : -STEP;
  }
  return [[{ key: p.fix, step: first }], [{ key: p.fix, step: -first }]];
}

/** How many real problems a scheme has; notes do not count. */
function failing(s: CustomScheme): number {
  return themeProblems(s).filter((q) => !q.note).length;
}

/**
 * Follow one way out, at most 30 steps a move, and stop at the first point
 * where this problem is gone and nothing new has gone wrong. A wheel colour
 * nudged clear of one neighbour can land on the other; stopping there would
 * only hand the next pass a problem to undo this one. If no such point comes,
 * the first point where this problem is gone will do.
 */
function walk(s: CustomScheme, p: ThemeProblem, way: { key: ThemeInput; step: number }[]): CustomScheme {
  const before = failing(s);
  let scheme = s;
  let cleared: CustomScheme | null = null;
  for (const { key, step } of way) {
    for (let k = 0; k < 30; k++) {
      if (!stillFails(scheme, p)) {
        cleared ??= scheme;
        if (failing(scheme) < before) return scheme;
      }
      const hex = getInput(scheme, key);
      const next = withLightness(hex, hexToOklab(hex).L + step);
      if (next === hex) break;
      scheme = setInput(scheme, key, next);
    }
    if (!stillFails(scheme, p) && failing(scheme) < before) return scheme;
  }
  return cleared ?? scheme;
}

const MOVED_WORDS: Record<ThemeInput, string> = {
  bg: "Background",
  ink: "Text",
  accent: "Accent",
  wheel0: "Wheel 1",
  wheel1: "Wheel 2",
  wheel2: "Wheel 3",
  wheel3: "Spare",
};

/**
 * The closest readable version of a scheme: the suggestion shown beside the
 * person's own when theirs fails.
 *
 * Every hue is kept. For each problem the named colour's lightness moves away
 * from what it is measured against, 0.02 at a time and at most 30 steps; only
 * if that is not enough does the other colour of the pair move. Chroma gives
 * way only where a lighter or darker version of a colour cannot exist. It
 * runs until nothing is left or a pass changes nothing, and says what moved.
 */
export function fixTheme(s: CustomScheme): { scheme: CustomScheme; moved: string[] } {
  let scheme = s;
  for (let pass = 0; pass < 8; pass++) {
    const problems = themeProblems(scheme).filter((p) => !p.note);
    if (problems.length === 0) break;
    const before = JSON.stringify(scheme);
    for (const p of problems) {
      if (!stillFails(scheme, p)) continue;
      const tries = waysOut(scheme, p).map((way) => walk(scheme, p, way));
      // The way that leaves least wrong; the first of them on a tie.
      scheme = tries.reduce((a, b) => (failing(b) < failing(a) ? b : a));
    }
    if (JSON.stringify(scheme) === before) break;
  }
  const keys: ThemeInput[] = ["bg", "ink", "accent", "wheel0", "wheel1", "wheel2", "wheel3"];
  const words = keys.filter((key) => getInput(s, key) !== getInput(scheme, key)).map((key) => {
    const was = hexToOklab(getInput(s, key)).L;
    const now = hexToOklab(getInput(scheme, key)).L;
    return `${MOVED_WORDS[key]} ${now > was ? "lightened" : "darkened"}`;
  });
  return { scheme, moved: words };
}
