/**
 * A pack: a folder of randomizers an author publishes, with who made it, its
 * version and its licence (format in FORMAT.md).
 *
 * A pack travels as a library file with a `pack` block. In a library it is a
 * folder holding `orangey-pack.json`:
 * - in the author's own folder the file has no `installed`, and only remembers
 *   the details for publishing the next version; the folder stays editable;
 * - in a folder a pack was installed into, `installed` is set, and the folder
 *   is locked, so an update can replace it without losing anyone's edits.
 *   "Make an editable copy" gives a free copy instead.
 */

import { Check, ValidationError } from "./validate.ts";

export const PACK_FILE = "orangey-pack.json";
export const PACK_FORMAT = "orangey-pack";
export const PACK_FORMAT_VERSION = 1;

export interface PackManifest {
  /** Made once, when the pack is first published; every version keeps it. */
  id: string;
  title: string;
  author: string;
  /** Numbers with dots, as the author counts: "1", "1.2", "2.0.3". */
  version: string;
  licence?: string;
  homepage?: string;
  description?: string;
  /**
   * May an app (Sekwe) keep a copy of these tables inside a player's
   * journal, so it rolls without the pack installed? Yes unless set to false.
   */
  allowSnapshots?: boolean;
}

/** What the library keeps beside an installed pack. */
export interface InstalledPack extends PackManifest {
  /** When it was installed or last updated. */
  installed?: string;
  /** Where it was installed from, when that was a link: updates are fetched from here. */
  source?: string;
  /**
   * The pack's randomizer ids that had to take another id here (one was
   * taken already), pack id → id here. Kept so an update lands on the same ids
   * and nothing that points at them breaks.
   */
  ids?: Record<string, string>;
}

export const VERSION_PATTERN = /^\d{1,6}(\.\d{1,6}){0,3}$/;
const MAX_TEXT = 200;
const MAX_DESCRIPTION = 2000;

/**
 * Checks a pack block (from a library file, or `orangey-pack.json`) and gives
 * back a clean one: unknown keys dropped, text trimmed. Throws a
 * ValidationError naming what is wrong.
 */
export function readManifest(raw: unknown, path = "pack"): InstalledPack {
  const check = new Check();
  if (!check.object(path, raw)) check.throwIfFailed();
  const o = raw as Record<string, unknown>;
  const text = (key: string, required: boolean, max = MAX_TEXT): string | undefined => {
    const v = o[key];
    if (v === undefined || v === null || v === "") {
      if (required) check.fail(`${path}.${key}`, "is needed");
      return undefined;
    }
    if (typeof v !== "string") {
      check.fail(`${path}.${key}`, "expected text");
      return undefined;
    }
    // One line, except a description, which may keep its paragraphs.
    const t = (key === "description" ? v.replace(/\r\n?/g, "\n") : v.replace(/\s+/g, " ")).trim();
    if (required && !t) check.fail(`${path}.${key}`, "is needed");
    if (t.length > max) check.fail(`${path}.${key}`, `longer than ${max} characters`);
    return t || undefined;
  };
  const id = text("id", true);
  const title = text("title", true);
  const author = text("author", true);
  const version = text("version", true);
  if (version && !VERSION_PATTERN.test(version)) check.fail(`${path}.version`, `expected numbers with dots, like "1.2"`);
  const licence = text("licence", false);
  const homepage = text("homepage", false, 500);
  if (homepage && !/^https?:\/\//i.test(homepage)) check.fail(`${path}.homepage`, "expected an address starting with https://");
  const description = text("description", false, MAX_DESCRIPTION);
  if (o.allowSnapshots !== undefined && typeof o.allowSnapshots !== "boolean") check.fail(`${path}.allowSnapshots`, "expected true or false");
  const installed = text("installed", false);
  const source = text("source", false, 2000);
  let ids: Record<string, string> | undefined;
  if (o.ids !== undefined) {
    if (check.object(`${path}.ids`, o.ids)) {
      ids = {};
      for (const [k, v] of Object.entries(o.ids as Record<string, unknown>)) if (typeof v === "string") ids[k] = v;
    }
  }
  check.throwIfFailed();
  const m: InstalledPack = { id: id!, title: title!, author: author!, version: version! };
  if (licence) m.licence = licence;
  if (homepage) m.homepage = homepage;
  if (description) m.description = description;
  if (o.allowSnapshots === false) m.allowSnapshots = false;
  if (installed) m.installed = installed;
  if (source) m.source = source;
  if (ids && Object.keys(ids).length) m.ids = ids;
  return m;
}

/** The parts that travel with the pack: what an install adds is left behind. */
export function publicManifest(m: InstalledPack): PackManifest {
  const { installed: _i, source: _s, ids: _ids, ...rest } = m;
  return rest;
}

/** The text of `orangey-pack.json`. */
export function serializeManifest(m: InstalledPack): string {
  return `${JSON.stringify({ format: PACK_FORMAT, version: PACK_FORMAT_VERSION, pack: m }, null, 2)}\n`;
}

/** Reads `orangey-pack.json`. Throws a ValidationError when it is not one. */
export function parseManifestFile(text: string): InstalledPack {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new ValidationError([{ path: PACK_FILE, message: `not valid JSON (${(e as Error).message})` }]);
  }
  const o = (doc ?? {}) as Record<string, unknown>;
  if (o.format !== PACK_FORMAT) throw new ValidationError([{ path: `${PACK_FILE}.format`, message: `expected "${PACK_FORMAT}"` }]);
  return readManifest(o.pack, PACK_FILE);
}

/**
 * Compares two versions number by number: "1.10" is newer than "1.9", and
 * "1.2" is the same as "1.2.0". Negative when a is older.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** The version after this one, for the publish form: "1.2" → "1.3". */
export function nextVersion(v: string): string {
  if (!VERSION_PATTERN.test(v)) return "1.0";
  const parts = v.split(".").map(Number);
  parts[parts.length - 1]++;
  return parts.join(".");
}

/** "Ironsworn Delve by Shawn · v1.2 · CC BY 4.0": one line of credit. */
export function creditLine(m: PackManifest): string {
  return [`${m.title} by ${m.author}`, `v${m.version}`, m.licence].filter(Boolean).join(" · ");
}

/** Whether apps may keep a copy of this pack's tables in a player's file. */
export const snapshotsAllowed = (m: PackManifest | null | undefined): boolean => m?.allowSnapshots !== false;

// ---- packs a backup or export needs ------------------------------------------------

/**
 * Exports leave installed packs out (they are their authors' to hand out, with
 * their credit), and say instead which packs they needed, so the import can
 * offer to install them again. In a ZIP this is a file at the top:
 */
export const PACKS_FILE = "orangey-packs.json";

/** A pack an export needed: who made it, its version, and where it came from when known. */
export interface NeededPack extends PackManifest {
  source?: string;
}

export function neededFrom(m: InstalledPack): NeededPack {
  const out: NeededPack = publicManifest(m);
  if (m.source) out.source = m.source;
  return out;
}

export function serializePackList(packs: readonly NeededPack[]): string {
  return `${JSON.stringify({ format: "orangey-packs", version: 1, packs }, null, 2)}\n`;
}

/** The list back; anything that is not a readable pack is left out rather than refusing the rest. */
export function readPackList(raw: unknown): NeededPack[] {
  if (!Array.isArray(raw)) return [];
  const out: NeededPack[] = [];
  for (const item of raw) {
    try {
      const m = readManifest(item);
      const n = neededFrom(m);
      if (n.source && !/^https?:\/\//i.test(n.source)) delete n.source;
      out.push(n);
    } catch {
      // Not a pack: skipped.
    }
  }
  return out;
}

export function parsePackList(text: string): NeededPack[] {
  try {
    const doc = JSON.parse(text) as { format?: unknown; packs?: unknown };
    return doc?.format === "orangey-packs" ? readPackList(doc.packs) : [];
  } catch {
    return [];
  }
}
