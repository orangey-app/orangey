/**
 * A library, or part of one, as one plain-text file:
 * `<name>.orangey-library.json` (format in FORMAT.md).
 *
 * Unlike a ZIP, it can be read before it is trusted and pasted into a forum
 * post. Randomizers keep their ids, so the links between them travel; pictures
 * are left out, since inline they would make the file unreadable.
 */

import { FILE_SUFFIX, FORMAT, FORMAT_VERSION, fileNameFor, parseFile, serialize, wrap, type OrangeyFile } from "../model/file.ts";
import type { Randomizer } from "../model/randomizer.ts";
import { Check, ValidationError } from "../model/validate.ts";
import { basename, join, parent, sanitizeName } from "./paths.ts";

export const LIBRARY_FORMAT = "orangey-library";
export const LIBRARY_FORMAT_VERSION = 1;
export const LIBRARY_FILE_SUFFIX = ".orangey-library.json";

/** One randomizer in the file, at its path in the library. */
export interface LibraryFileEntry {
  path: string;
  randomizer: Randomizer;
}

/** What a library file holds once read: ready for `LibraryService.importLibrary`. */
export interface ReadLibraryFile {
  name: string;
  folders: string[];
  entries: { path: string; file: OrangeyFile }[];
  /** Randomizers that could not be read, by path, with the reason. */
  failed: { path: string; message: string }[];
}

/**
 * The text of a library file. Two-space indent and the randomizer's usual key
 * order, so it reads like a `.orangey.json` and diffs like one.
 */
export function serializeLibrary(name: string, exported: string, folders: readonly string[], entries: readonly LibraryFileEntry[]): string {
  const doc = {
    format: LIBRARY_FORMAT,
    version: LIBRARY_FORMAT_VERSION,
    name,
    exported,
    folders: [...folders],
    randomizers: entries.map((e) => ({
      path: e.path,
      // Through the file serializer, for its key order; then back to an object.
      randomizer: (JSON.parse(serialize(wrap(e.randomizer))) as { randomizer: unknown }).randomizer,
    })),
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** Whether pasted text is meant as a library file, before deciding whether it is a good one. */
export function isLibraryText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.includes(`"${LIBRARY_FORMAT}"`)) return false;
  try {
    return (JSON.parse(trimmed) as { format?: unknown }).format === LIBRARY_FORMAT;
  } catch {
    // Mangled on the way (a forum ate a quote): it was still meant as one, and
    // reading it will say what is wrong rather than treating it as a table.
    return /"format"\s*:\s*"orangey-library"/.test(trimmed);
  }
}

/**
 * Read a library file. The document as a whole must be one (else a
 * `ValidationError`); each randomizer inside is checked on its own, and one
 * that fails is reported in `failed` rather than stopping the rest.
 */
export function parseLibrary(text: string): ReadLibraryFile {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new ValidationError([{ path: "library", message: `not valid JSON (${(e as Error).message})` }]);
  }
  const check = new Check();
  if (!check.object("library", doc)) check.throwIfFailed();
  const o = doc as Record<string, unknown>;
  if (o.format !== LIBRARY_FORMAT) check.fail("library.format", `expected "${LIBRARY_FORMAT}"`);
  check.number("library.version", o.version, { min: 1, integer: true });
  check.array("library.randomizers", o.randomizers);
  check.throwIfFailed();
  if ((o.version as number) > LIBRARY_FORMAT_VERSION) {
    // Unlike one randomizer, a library cannot open read-only: it is written
    // into yours or not at all, so a newer one is refused, not guessed at.
    throw new ValidationError([{
      path: "library.version",
      message: `made with a newer Orangey (library format version ${o.version as number}); update Orangey to import it`,
    }]);
  }

  const name = typeof o.name === "string" && o.name.trim() ? o.name.trim().slice(0, 200) : "Library";
  const folders = Array.isArray(o.folders)
    ? [...new Set(o.folders.filter((f): f is string => typeof f === "string").map(safeFolder).filter(Boolean))]
    : [];

  const entries: ReadLibraryFile["entries"] = [];
  const failed: ReadLibraryFile["failed"] = [];
  const used = new Set<string>();
  (o.randomizers as unknown[]).forEach((raw, i) => {
    const record = (raw ?? {}) as Record<string, unknown>;
    const given = typeof record.path === "string" ? record.path : "";
    let file: OrangeyFile;
    try {
      // The same checks and migrations as a `.orangey.json` on its own.
      file = parseFile(JSON.stringify({ format: FORMAT, version: FORMAT_VERSION, randomizer: record.randomizer })).file;
    } catch (e) {
      failed.push({ path: given || `randomizer ${i + 1}`, message: (e as Error).message });
      return;
    }
    const randomizer = withoutPictures(file.randomizer).randomizer;
    let path = safeFilePath(given, randomizer.name);
    // Two entries at one path (a file edited by hand): the second is renamed
    // beside the first rather than written over it.
    if (used.has(path.toLowerCase())) {
      const siblings = [...used].filter((p) => parent(p) === parent(path).toLowerCase()).map(basename);
      path = join(parent(path), fileNameFor(randomizer.name, siblings));
    }
    used.add(path.toLowerCase());
    entries.push({ path, file: { ...file, randomizer } });
  });
  return { name, folders, entries, failed };
}

/**
 * A folder path from someone else's file, each segment sanitised as a name.
 * `..`, drive letters, backslashes and leading slashes come out, so nothing
 * lands outside the folder it is imported into.
 */
export function safeFolder(raw: string): string {
  return raw.split(/[\\/]+/).map(sanitizeName).filter(Boolean).slice(0, 16).join("/");
}

/** A file path from someone else's file: a safe folder and a real `.orangey.json` name. */
export function safeFilePath(raw: string, name: string): string {
  const folder = safeFolder(parent(raw.replace(/\\/g, "/")));
  const file = sanitizeName(basename(raw.replace(/\\/g, "/")));
  return join(folder, file.toLowerCase().endsWith(FILE_SUFFIX) && file.length > FILE_SUFFIX.length ? file : fileNameFor(name));
}

/** A randomizer with its outcomes' pictures taken off, and how many there were. */
export function withoutPictures(r: Randomizer): { randomizer: Randomizer; pictures: number } {
  if (r.type !== "list") return { randomizer: r, pictures: 0 };
  let pictures = 0;
  const items = r.items.map((item) => {
    if (item.image === undefined && item.imageData === undefined) return item;
    pictures++;
    const { image: _image, imageData: _data, ...rest } = item;
    return rest;
  });
  return { randomizer: pictures ? { ...r, items } : r, pictures };
}

/** The ids a randomizer points at: its outcomes' "Goes to", a board's entries. */
export function linkedIds(r: Randomizer): string[] {
  if (r.type === "list") return r.items.flatMap((i) => (i.goesTo ? [i.goesTo] : []));
  if (r.type === "board") return r.entries.map((e) => e.id);
  return [];
}

/**
 * The same randomizer with its links sent where `ids` says. An id not in it,
 * or mapped to itself, is left alone, and when nothing moves the very same
 * object comes back — which is how an import knows a file needs no rewrite.
 */
export function relink(r: Randomizer, ids: ReadonlyMap<string, string>): Randomizer {
  const moved = (id: string | undefined): id is string => id !== undefined && ids.has(id) && ids.get(id) !== id;
  if (r.type === "list" && r.items.some((i) => moved(i.goesTo))) {
    return { ...r, items: r.items.map((i) => (moved(i.goesTo) ? { ...i, goesTo: ids.get(i.goesTo)! } : i)) };
  }
  if (r.type === "board" && r.entries.some((e) => moved(e.id))) {
    return { ...r, entries: r.entries.map((e) => (moved(e.id) ? { ...e, id: ids.get(e.id)! } : e)) };
  }
  return r;
}

/** Something in the library, as far as choosing what to export needs to know. */
export interface ExportSource {
  path: string;
  randomizer?: Randomizer;
}

export interface ExportPlan {
  entries: LibraryFileEntry[];
  /** Randomizers put in because something chosen links to them. */
  linked: number;
  /** Pictures left out. */
  pictures: number;
}

/**
 * What goes in the file: the chosen randomizers, then everything they link to,
 * followed as far as the links go, so nothing arrives pointing at nothing.
 *
 * `base` is taken off the chosen ones' paths, so an exported folder arrives as
 * itself; a randomizer brought in by a link keeps its whole path.
 */
export function planExport(all: readonly ExportSource[], chosen: readonly string[], base = ""): ExportPlan {
  const byPath = new Map(all.map((s) => [s.path, s]));
  const byId = new Map<string, ExportSource>();
  for (const s of all) if (s.randomizer && !byId.has(s.randomizer.id)) byId.set(s.randomizer.id, s);
  const included = new Set<string>();
  const entries: LibraryFileEntry[] = [];
  let linked = 0;
  let pictures = 0;
  const queue: { source: ExportSource; fromLink: boolean }[] = chosen
    .map((p) => byPath.get(p))
    .filter((s): s is ExportSource => !!s?.randomizer)
    .map((source) => ({ source, fromLink: false }));
  while (queue.length) {
    const { source, fromLink } = queue.shift()!;
    if (included.has(source.path)) continue;
    included.add(source.path);
    const stripped = withoutPictures(source.randomizer!);
    pictures += stripped.pictures;
    const relative = !fromLink && base && source.path.startsWith(`${base}/`) ? source.path.slice(base.length + 1) : source.path;
    entries.push({ path: relative, randomizer: stripped.randomizer });
    if (fromLink) linked++;
    for (const id of linkedIds(source.randomizer!)) {
      const target = byId.get(id);
      if (target && !included.has(target.path)) queue.push({ source: target, fromLink: true });
    }
  }
  return { entries, linked, pictures };
}
