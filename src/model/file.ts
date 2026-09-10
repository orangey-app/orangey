/**
 * The .orangey.json file format (plan C3, decision D10).
 *
 * Rules that the round-trip test enforces:
 *   - UTF-8, LF, two-space indent, keys in a fixed order, so Git diffs stay
 *     readable and a file edited by hand does not churn;
 *   - unknown keys are preserved, so a file written by a newer Orangey and
 *     re-saved by an older one does not silently lose information;
 *   - a file whose version is newer than we know opens read-only rather than
 *     being guessed at.
 */

import { Check, ValidationError } from "./validate.ts";
import { validateRandomizer, type Randomizer } from "./randomizer.ts";

export const FORMAT = "orangey";
export const FORMAT_VERSION = 1;
export const FILE_SUFFIX = ".orangey.json";

export interface OrangeyFile {
  format: typeof FORMAT;
  version: number;
  randomizer: Randomizer;
  /** Anything a newer version wrote that this one does not understand. */
  unknown?: Record<string, unknown>;
}

const RANDOMIZER_KEY_ORDER = [
  "id", "type", "name", "description", "tags", "view", "withoutReplacement",
  "expression", "faces", "faceReactions", "min", "max", "integer", "inclusiveMax", "count", "unique",
  "feel", "created", "modified", "items",
];
const ITEM_KEY_ORDER = ["id", "label", "weight", "disabled", "description", "color", "reaction", "metadata"];

function ordered(obj: Record<string, unknown>, order: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of order) if (obj[k] !== undefined) out[k] = obj[k];
  for (const k of Object.keys(obj)) if (!(k in out) && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

export function serialize(file: OrangeyFile): string {
  const r = file.randomizer as unknown as Record<string, unknown>;
  const body = ordered(r, RANDOMIZER_KEY_ORDER);
  if (Array.isArray(body.items)) {
    body.items = (body.items as Record<string, unknown>[]).map((i) => ordered(i, ITEM_KEY_ORDER));
  }
  const doc: Record<string, unknown> = {
    format: FORMAT,
    version: file.version ?? FORMAT_VERSION,
    ...(file.unknown ?? {}),
    randomizer: body,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export interface ParseOutcome {
  file: OrangeyFile;
  /** True when the file was written by a newer Orangey: open it read-only. */
  readOnly: boolean;
  warnings: string[];
}

export function parseFile(text: string): ParseOutcome {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new ValidationError([{ path: "file", message: `not valid JSON (${(e as Error).message})` }]);
  }
  const check = new Check();
  if (!check.object("file", doc)) check.throwIfFailed();
  const o = doc as Record<string, unknown>;

  if (o.format !== FORMAT) {
    // Be generous about what we accept: a bare randomizer object is a common
    // thing to paste, and rejecting it on a technicality helps nobody.
    if (o.type && o.name) return parseFile(serialize({ format: FORMAT, version: FORMAT_VERSION, randomizer: o as unknown as Randomizer }));
    check.fail("file.format", `expected "${FORMAT}"`);
    check.throwIfFailed();
  }
  if (!check.number("file.version", o.version, { min: 1, integer: true })) check.throwIfFailed();

  const version = o.version as number;
  const readOnly = version > FORMAT_VERSION;
  const warnings: string[] = [];
  if (readOnly) {
    warnings.push(
      `This file was made with a newer Orangey (format version ${version}). It is open for reading only.`,
    );
  }

  const migrated = migrate(o.randomizer, Math.min(version, FORMAT_VERSION));
  if (!validateRandomizer(migrated, check)) check.throwIfFailed();

  const known = new Set(["format", "version", "randomizer"]);
  const unknown: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!known.has(k)) unknown[k] = v;

  return {
    file: {
      format: FORMAT,
      version,
      randomizer: migrated as Randomizer,
      ...(Object.keys(unknown).length ? { unknown } : {}),
    },
    readOnly,
    warnings,
  };
}

/**
 * Version migrations. Version 1 is the first, so there is nothing to do yet;
 * the chain exists so that adding version 2 is a one-line change here rather
 * than a rewrite of the loader.
 */
export function migrate(randomizer: unknown, fromVersion: number): unknown {
  let r = randomizer;
  for (let v = fromVersion; v < FORMAT_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (step) r = step(r);
  }
  return r;
}

const MIGRATIONS: Record<number, (r: unknown) => unknown> = {};

export function wrap(randomizer: Randomizer): OrangeyFile {
  return { format: FORMAT, version: FORMAT_VERSION, randomizer };
}

/** Filename for a randomizer: slug of its name plus the double extension. */
export function slugify(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return s || "untitled";
}

export function fileNameFor(name: string, taken: readonly string[] = []): string {
  const base = slugify(name);
  let candidate = `${base}${FILE_SUFFIX}`;
  let n = 2;
  const lower = new Set(taken.map((t) => t.toLowerCase()));
  while (lower.has(candidate.toLowerCase())) {
    candidate = `${base}-${n}${FILE_SUFFIX}`;
    n++;
  }
  return candidate;
}
