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

import { isHex } from "../core/color.ts";
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
}

export interface SettingsFile {
  format: typeof SETTINGS_FORMAT;
  version: number;
  settings: PortableSettings;
}

const KEY_ORDER: (keyof PortableSettings)[] = ["scheme", "feel", "seed", "reducedMotionOverridden", "colours"];

export const SCHEMES = ["system", "orangey", "night", "meadow", "ocean", "berry"] as const;

/** Pick the portable part out of whatever preferences object the app holds. */
export function portableSettings(prefs: {
  scheme?: string;
  feel: FeelSettings;
  seed?: string | null;
  reducedMotionOverridden?: boolean;
  colours?: CustomColour[];
}): PortableSettings {
  return {
    scheme: prefs.scheme ?? "system",
    feel: normalizeFeel(prefs.feel),
    seed: prefs.seed ?? null,
    reducedMotionOverridden: prefs.reducedMotionOverridden ?? false,
    colours: normalizeColours(prefs.colours),
  };
}

export function serializeSettings(settings: PortableSettings): string {
  const ordered: Record<string, unknown> = {};
  for (const k of KEY_ORDER) ordered[k] = settings[k];
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
  for (const k of Object.keys(s)) if (!(KEY_ORDER as string[]).includes(k)) check.fail(`settings.${k}`, "not a setting Orangey knows");
  if (!check.ok) throw new ValidationError(check.issues);

  return {
    scheme: (s.scheme as string | undefined) ?? "system",
    // normalizeFeel clamps every timing into its limits, exactly as on load
    feel: normalizeFeel(s.feel),
    seed: (s.seed as string | null | undefined) ?? null,
    reducedMotionOverridden: (s.reducedMotionOverridden as boolean | undefined) ?? false,
    colours: normalizeColours(s.colours as CustomColour[] | undefined),
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
