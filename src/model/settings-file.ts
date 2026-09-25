/**
 * The `.orangey-settings.json` file: the settings worth carrying to another
 * device, and nothing that belongs to this browser alone.
 *
 * In: colour scheme, every Feel setting (the wheel, dice, coin, Orangey and
 * his rules), the seed, and the colours you added to the palette.
 * Out: which folder the library is in, which folders are open, favourites,
 * the storage backend, and the "starters were added" flag — those describe
 * this device, and loading them elsewhere would only confuse it.
 *
 * Same conventions as the randomizer files: two-space indent, LF, a fixed
 * key order, unknown keys refused rather than guessed at (settings are small
 * and a typo should be told, not silently dropped).
 */

import { hexToRgb, isHex, rgbToHex } from "../core/color.ts";
import { THEME_NAME_MAX, type CustomScheme } from "../core/theme.ts";
import { normalizeFeel, type FeelSettings } from "../ui/feel.ts";
import { Check, ValidationError } from "./validate.ts";

export const SETTINGS_FORMAT = "orangey-settings";
export const SETTINGS_VERSION = 1;
export const SETTINGS_FILE_NAME = "orangey-settings.json";

/** A colour the user added to the palette. */
export interface CustomColour {
  name: string;
  hex: string;
}

export const MAX_CUSTOM_COLOURS = 64;
export const MAX_COLOUR_NAME = 40;

export interface PortableSettings {
  scheme: string;
  feel: FeelSettings;
  seed: string | null;
  reducedMotionOverridden: boolean;
  colours: CustomColour[];
  /** Your own theme, when one has been made. Applied when `scheme` is "custom". */
  customScheme?: CustomScheme;
}

export interface SettingsFile {
  format: typeof SETTINGS_FORMAT;
  version: number;
  settings: PortableSettings;
}

// Appended to, never reordered (P17): a file written by 0.5 loads unchanged.
const KEY_ORDER: (keyof PortableSettings)[] = ["scheme", "feel", "seed", "reducedMotionOverridden", "colours", "customScheme"];

export const SCHEMES = ["system", "orangey", "night", "meadow", "ocean", "berry", "custom"] as const;

/** Pick the portable part out of whatever preferences object the app holds. */
export function portableSettings(prefs: {
  scheme?: string;
  feel: FeelSettings;
  seed?: string | null;
  reducedMotionOverridden?: boolean;
  colours?: CustomColour[];
  customScheme?: CustomScheme;
}): PortableSettings {
  const custom = normalizeCustomScheme(prefs.customScheme);
  return {
    // "custom" with nothing to apply would be refused on the way back in.
    scheme: prefs.scheme === "custom" && !custom ? "system" : prefs.scheme ?? "system",
    feel: normalizeFeel(prefs.feel),
    seed: prefs.seed ?? null,
    reducedMotionOverridden: prefs.reducedMotionOverridden ?? false,
    colours: normalizeColours(prefs.colours),
    ...(custom ? { customScheme: custom } : {}),
  };
}

export function serializeSettings(settings: PortableSettings): string {
  const ordered: Record<string, unknown> = {};
  for (const k of KEY_ORDER) if (settings[k] !== undefined) ordered[k] = settings[k];
  const file: SettingsFile = { format: SETTINGS_FORMAT, version: SETTINGS_VERSION, settings: ordered as unknown as PortableSettings };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/**
 * Parse a settings file. Throws a ValidationError naming every problem. A
 * newer version is refused rather than guessed at — settings are cheap to
 * re-make, and a wrong guess about a timing would be felt on every roll.
 */
export function parseSettings(text: string): PortableSettings {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new ValidationError([{ path: "file", message: "not JSON" }]);
  }
  const check = new Check();
  if (!check.object("file", doc)) throw new ValidationError(check.issues);
  const o = doc as Record<string, unknown>;
  if (o.format !== SETTINGS_FORMAT) check.fail("file.format", `expected "${SETTINGS_FORMAT}"`);
  if (typeof o.version !== "number") check.fail("file.version", "expected a number");
  else if (o.version > SETTINGS_VERSION) check.fail("file.version", `made by a newer Orangey (version ${o.version}); this one reads up to ${SETTINGS_VERSION}`);
  if (!check.object("file.settings", o.settings)) throw new ValidationError(check.issues);
  const s = o.settings as Record<string, unknown>;

  if (s.scheme !== undefined) check.oneOf("settings.scheme", s.scheme, SCHEMES);
  if (s.seed !== undefined && s.seed !== null) check.string("settings.seed", s.seed, { max: 200 });
  if (s.reducedMotionOverridden !== undefined) check.boolean("settings.reducedMotionOverridden", s.reducedMotionOverridden);
  if (s.feel !== undefined && !check.object("settings.feel", s.feel)) { /* reported */ }
  if (s.colours !== undefined && check.array("settings.colours", s.colours)) {
    const cs = s.colours as unknown[];
    if (cs.length > MAX_CUSTOM_COLOURS) check.fail("settings.colours", `at most ${MAX_CUSTOM_COLOURS} colours`);
    cs.forEach((c, i) => {
      const p = `settings.colours[${i}]`;
      if (!check.object(p, c)) return;
      const cc = c as Record<string, unknown>;
      check.string(`${p}.name`, cc.name, { min: 1, max: MAX_COLOUR_NAME });
      if (!isHex(cc.hex)) check.fail(`${p}.hex`, "expected a colour like #a33a30");
    });
  }
  if (s.customScheme !== undefined) checkCustomScheme(check, s.customScheme);
  if (s.scheme === "custom" && s.customScheme === undefined) {
    check.fail("settings.scheme", "says to use your own theme, but the file has none");
  }
  for (const k of Object.keys(s)) if (!(KEY_ORDER as string[]).includes(k)) check.fail(`settings.${k}`, "not a setting Orangey knows");
  if (!check.ok) throw new ValidationError(check.issues);

  return {
    scheme: (s.scheme as string | undefined) ?? "system",
    // normalizeFeel clamps every timing into its limits, exactly as on load
    feel: normalizeFeel(s.feel),
    seed: (s.seed as string | null | undefined) ?? null,
    reducedMotionOverridden: (s.reducedMotionOverridden as boolean | undefined) ?? false,
    colours: normalizeColours(s.colours as CustomColour[] | undefined),
    ...(s.customScheme !== undefined ? { customScheme: normalizeCustomScheme(s.customScheme) } : {}),
  };
}

function checkCustomScheme(check: Check, raw: unknown): void {
  const p = "settings.customScheme";
  if (!check.object(p, raw)) return;
  const c = raw as Record<string, unknown>;
  check.string(`${p}.name`, c.name, { min: 1, max: THEME_NAME_MAX });
  for (const key of ["bg", "ink", "accent"] as const) {
    if (!isHex(c[key])) check.fail(`${p}.${key}`, "expected a colour like #a33a30");
  }
  if (check.array(`${p}.wheel`, c.wheel)) {
    const wheel = c.wheel as unknown[];
    if (wheel.length !== 4) check.fail(`${p}.wheel`, "three wheel colours and a spare");
    wheel.forEach((w, i) => {
      if (!isHex(w)) check.fail(`${p}.wheel[${i}]`, "expected a colour like #a33a30");
    });
  }
}

/** A colour as the app writes it: lower-case, six digits, with its #. */
function canonicalHex(hex: string): string {
  return rgbToHex(hexToRgb(hex));
}

/** A theme that can be applied as it stands, or undefined when there is none. */
export function normalizeCustomScheme(raw: unknown): CustomScheme | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const c = raw as Record<string, unknown>;
  const wheel = Array.isArray(c.wheel) ? c.wheel : [];
  if (!isHex(c.bg) || !isHex(c.ink) || !isHex(c.accent) || wheel.length !== 4 || !wheel.every(isHex)) return undefined;
  const name = typeof c.name === "string" && c.name.trim() ? c.name.trim().slice(0, THEME_NAME_MAX) : "My theme";
  return {
    name,
    bg: canonicalHex(c.bg),
    ink: canonicalHex(c.ink),
    accent: canonicalHex(c.accent),
    wheel: wheel.map((w) => canonicalHex(w as string)) as CustomScheme["wheel"],
  };
}

/** Keep only well-formed colours, lower-case hex, no duplicates, capped. */
export function normalizeColours(raw: unknown): CustomColour[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomColour[] = [];
  const seen = new Set<string>();
  for (const c of raw) {
    if (typeof c !== "object" || c === null) continue;
    const { name, hex } = c as Record<string, unknown>;
    if (typeof name !== "string" || !name.trim() || !isHex(hex)) continue;
    const h = (hex.startsWith("#") ? hex : `#${hex}`).toLowerCase();
    if (seen.has(h)) continue;
    seen.add(h);
    out.push({ name: name.trim().slice(0, MAX_COLOUR_NAME), hex: h });
    if (out.length >= MAX_CUSTOM_COLOURS) break;
  }
  return out;
}
