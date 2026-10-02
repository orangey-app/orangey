/**
 * Actions on where the library is kept, shared by the library's storage badge
 * and Settings. Nothing here draws: each returns whether something changed.
 */

import { serialize, slugify, wrap } from "../model/file.ts";
import type { BoardRandomizer, Randomizer } from "../model/randomizer.ts";
import { IMAGE_DIR, LibraryService } from "../storage/library.ts";
import { canPickFolder, forgetFolder, pickFolder } from "../storage/fsdir.ts";
import { imageBytes, imageDataUrl, imageStoredName, putImageData } from "../storage/images.ts";
import { createZip, type ZipEntry } from "../storage/zip.ts";
import { parent, segments } from "../storage/paths.ts";
import { LIBRARY_FILE_SUFFIX, planExport, serializeLibrary } from "../storage/libraryfile.ts";
import { neededFrom, PACKS_FILE, serializePackList, type NeededPack } from "../model/pack.ts";
import { askConfirm, askText, download, downloadBytes } from "./dom.ts";
import { state } from "./state.ts";


/** Whether this browser lets the library be a real folder (Chrome and Edge do). */
export function canUseFolder(): boolean {
  return canPickFolder();
}

export type StorageKind = "opfs" | "idb" | "fsa" | "memory";

/** One sentence about where the library is, for a tooltip or a settings line. */
export function describeStorage(kind: string): string {
  switch (kind) {
    case "fsa":
      return "A folder on this computer. The files there are the library, so they are yours to back up, sync or keep in Git.";
    case "memory":
      return "Nothing is being saved. This browser gave Orangey no storage, so the library goes when the page closes.";
    case "idb":
      return "This browser's own storage (IndexedDB). It survives reloads and works offline, and goes if you clear this site's data.";
    default:
      return "This browser's own storage. It survives reloads and works offline, and goes if you clear this site's data.";
  }
}

/**
 * Whether the browser has promised to keep this site's data. Asking is separate
 * (`askToPersist`) because Firefox shows a prompt for it.
 */
export async function isPersisted(): Promise<boolean | null> {
  try {
    if (!navigator.storage?.persisted) return null;
    return await navigator.storage.persisted();
  } catch {
    return null;
  }
}

export async function askToPersist(): Promise<boolean | null> {
  try {
    if (!navigator.storage?.persist) return null;
    return await navigator.storage.persist();
  } catch {
    return null;
  }
}

/**
 * Point the library at a folder on this computer, offering to copy what is
 * already there into it when the folder is empty.
 */
export async function useFolder(): Promise<boolean> {
  const backend = await pickFolder().catch(() => null);
  if (!backend) return false;
  const previous = state.library;
  const next = new LibraryService(backend);
  await next.refresh();
  if (next.files().length === 0 && previous.files().length > 0) {
    const copy = await askConfirm(
      "Copy your library into this folder?",
      `The folder is empty. Copy the ${previous.files().length} randomizers you have now into it?`,
      { confirm: "Copy" },
    );
    if (copy) {
      for (const file of previous.files()) {
        if (!file.randomizer) continue;
        const folder = parent(file.path);
        if (folder) await backend.mkdir(folder);
        await backend.write(file.path, serialize(wrap(file.randomizer)));
      }
      // Pictures are not in the tree, so copy them backend to backend, or every wheel
      // with one arrives pointing at nothing.
      const pictures = await previous.backend.list(IMAGE_DIR).catch(() => []);
      if (pictures.length) await backend.mkdir(IMAGE_DIR);
      for (const picture of pictures) {
        if (picture.kind !== "file") continue;
        const at = `${IMAGE_DIR}/${picture.name}`;
        await backend.writeBytes(at, await previous.backend.readBytes(at));
      }
      await next.refresh();
    }
  }
  state.setLibrary(next);
  state.folderNeedsPermission = false;
  void state.savePrefs({ backend: "fsa" });
  state.toast(`Library is now the folder “${backend.label}”`);
  return true;
}

export async function stopUsingFolder(): Promise<void> {
  await forgetFolder();
  state.toast("Reload to go back to browser storage.");
}

/**
 * A copy of a randomizer with its pictures inline, so a single exported file
 * works on a machine that has never seen this library.
 */
export async function portableRandomizer(r: Randomizer): Promise<Randomizer> {
  if (r.type !== "list" || !r.items.some((i) => i.image)) return r;
  const items = await Promise.all(r.items.map(async (item) => {
    if (!item.image) return item;
    const { image: _image, ...rest } = item;
    const inline = await imageDataUrl(item.image);
    // A picture the store has lost drops the reference; it would resolve to
    // nothing there either.
    return inline ? { ...rest, imageData: inline } : rest;
  }));
  return { ...r, items };
}

/**
 * The way back in: pictures a file brought go to the store, and outcomes go
 * back to naming ids.
 */
export async function absorbImages(r: Randomizer): Promise<Randomizer> {
  if (r.type !== "list" || !r.items.some((i) => i.imageData)) return r;
  const items = await Promise.all(r.items.map(async (item) => {
    if (!item.imageData) return item;
    const { imageData, ...rest } = item;
    try {
      return { ...rest, image: await putImageData(imageData) };
    } catch {
      // An unreadable picture costs the outcome only its picture.
      return rest;
    }
  }));
  return { ...r, items };
}

/** Every picture these randomizers point at. */
export function usedImageIds(randomizers: Randomizer[]): Set<string> {
  const ids = new Set<string>();
  for (const r of randomizers) {
    if (r.type !== "list") continue;
    for (const item of r.items) if (item.image) ids.add(item.image);
  }
  return ids;
}

/**
 * Installed packs stay out of every export: they are their authors' to hand
 * out, with their credit and licence, and installing one again keeps its ids,
 * so whatever of yours points at it works again. These say which pack a path
 * is in (null when none, or when it is the author's own folder) and turn the
 * packs left out into the list an export carries instead.
 */
export function installedPackOf(library: LibraryService, path: string): string | null {
  const found = library.packOf(path);
  return found?.pack.installed ? found.pack.id : null;
}

export function neededPacks(library: LibraryService, ids: Iterable<string>): NeededPack[] {
  return [...ids].flatMap((id) => {
    const pack = library.findPack(id)?.pack;
    return pack ? [neededFrom(pack)] : [];
  });
}

/** "Delve Oracles and Ruins": for a toast. */
const packNames = (packs: readonly NeededPack[]) =>
  packs.length <= 2 ? packs.map((p) => p.title).join(" and ") : `${packs.slice(0, 2).map((p) => p.title).join(", ")} and ${packs.length - 2} more`;

/**
 * The pictures for an archive, as files: packed once however many wheels use
 * them, and viewable when the ZIP is opened.
 */
async function pictureEntries(randomizers: Randomizer[]): Promise<ZipEntry[]> {
  const entries: ZipEntry[] = [];
  for (const id of usedImageIds(randomizers)) {
    const bytes = await imageBytes(id);
    if (!bytes) continue;
    // Under its real extension, so the file opens rather than being a JPEG called .png.
    const name = (await imageStoredName(id)) ?? `${id}.png`;
    entries.push({ path: `${IMAGE_DIR}/${name}`, bytes });
  }
  return entries;
}

/**
 * The files a board needs elsewhere: itself and every randomizer it points at.
 * A reference whose randomizer is gone is reported rather than packed.
 */
export function boardBundle(
  library: LibraryService,
  board: BoardRandomizer,
): { entries: { path: string; text: string }[]; missing: string[]; packs: NeededPack[] } {
  const entries: { path: string; text: string }[] = [];
  const missing: string[] = [];
  const packIds = new Set<string>();
  const boardNode = library.findById(board.id);
  if (boardNode) entries.push({ path: boardNode.path, text: serialize(wrap(board)) });
  for (const entry of board.entries) {
    const node = library.findById(entry.id);
    if (!node?.randomizer) {
      missing.push(entry.name);
      continue;
    }
    const pack = installedPackOf(library, node.path);
    if (pack !== null) {
      packIds.add(pack);
      continue;
    }
    entries.push({ path: node.path, text: serialize(wrap(node.randomizer)) });
  }
  return { entries, missing, packs: neededPacks(library, packIds) };
}

/**
 * Boards in the library that point at something no longer there, reported
 * after an archive import.
 */
export function missingOnBoards(library: LibraryService): { name: string; missing: string[] }[] {
  return library
    .files()
    .map((f) => f.randomizer)
    .filter((r): r is BoardRandomizer => Boolean(r) && r!.type === "board")
    .map((board) => ({
      name: board.name,
      missing: board.entries.filter((e) => !library.findById(e.id)).map((e) => e.name),
    }))
    .filter((b) => b.missing.length > 0);
}

export async function exportBoardZip(board: BoardRandomizer): Promise<void> {
  const { entries, missing, packs } = boardBundle(state.library, board);
  const packed = board.entries
    .map((e) => state.library.findById(e.id))
    .filter((n) => n?.randomizer && installedPackOf(state.library, n.path) === null)
    .map((n) => n!.randomizer!);
  const list = packs.length ? [{ path: PACKS_FILE, text: serializePackList(packs) }] : [];
  const zip = await createZip([...entries, ...list, ...(await pictureEntries(packed))]);
  downloadBytes(`${slugify(board.name)}.zip`, zip);
  const count = `${entries.length} file${entries.length === 1 ? "" : "s"}`;
  state.toast(
    (missing.length
      ? `Exported ${count}. Missing from your library: ${missing.join(", ")}.`
      : `Exported ${count}: the board and everything on it.`) +
      (packs.length ? ` Tables from ${packNames(packs)} stay out; the file names the pack${packs.length === 1 ? "" : "s"} to install.` : ""),
  );
}

/** The whole tree as a ZIP: the backup that works in every browser. */
export async function exportLibraryZip(): Promise<void> {
  // Your own work; each installed pack is named in orangey-packs.json instead.
  const own = state.library.files().filter((f) => f.randomizer && installedPackOf(state.library, f.path) === null);
  const randomizers = own.map((f) => f.randomizer!);
  const entries = own.map((f) => ({ path: f.path, text: serialize(wrap(f.randomizer!)) }));
  const packs = state.library.installedPacks().map((p) => neededFrom(p.pack));
  const list = packs.length ? [{ path: PACKS_FILE, text: serializePackList(packs) }] : [];
  const pictures = await pictureEntries(randomizers);
  const zip = await createZip([...entries, ...list, ...pictures]);
  downloadBytes("orangey-library.zip", zip);
  state.toast(
    `Exported ${entries.length} randomizer${entries.length === 1 ? "" : "s"}` +
      `${pictures.length ? ` and ${pictures.length} picture${pictures.length === 1 ? "" : "s"}` : ""}` +
      `${packs.length ? `. Installed packs (${packNames(packs)}) are not copied: the backup lists them, to install again when you restore it` : ""}`,
  );
}

/**
 * Chosen randomizers as one plain-text library file (see
 * `storage/libraryfile.ts`), named each time starting from `defaultName`.
 * `base` is stripped from the front of the chosen paths; `folders` are carried
 * even when empty; linked randomizers come along.
 */
export async function exportLibraryFile(opts: {
  paths: readonly string[];
  defaultName: string;
  base?: string;
  folders?: readonly string[];
  opener?: HTMLElement | null;
}): Promise<void> {
  const name = (await askText("Export as a library file", {
    label: "Name", value: opts.defaultName, confirm: "Export", opener: opts.opener,
  }))?.trim();
  if (!name) return;
  const sources = state.library.files().map((n) => ({ path: n.path, randomizer: n.randomizer ?? undefined }));
  const plan = planExport(sources, opts.paths, opts.base ?? "", (p) => installedPackOf(state.library, p));
  const needs = neededPacks(state.library, plan.leftOut.keys());
  if (plan.entries.length === 0) {
    state.toast(needs.length ? `Those are all in the pack ${packNames(needs)}, which is its author's to share: send them its file or link instead.` : "There is nothing there to export.");
    return;
  }
  // Every folder on the way to a randomizer, and the empty ones asked for.
  const folders = new Set(opts.folders ?? []);
  for (const entry of plan.entries) {
    const parts = segments(parent(entry.path));
    for (let i = 1; i <= parts.length; i++) folders.add(parts.slice(0, i).join("/"));
  }
  folders.delete("");
  const text = serializeLibrary(name, new Date().toISOString(), [...folders].sort(), plan.entries, undefined, needs);
  download(`${slugify(name)}${LIBRARY_FILE_SUFFIX}`, text, "application/json");
  const count = plan.entries.length;
  state.toast(
    `Exported ${count} randomizer${count === 1 ? "" : "s"}` +
      `${plan.linked ? `, ${plan.linked} of them because something chosen goes to ${plan.linked === 1 ? "it" : "them"}` : ""}.` +
      `${plan.pictures ? ` ${plan.pictures} picture${plan.pictures === 1 ? " was" : "s were"} left out; the ZIP export keeps pictures.` : ""}` +
      `${needs.length ? ` Tables from ${packNames(needs)} stay out; the file names the pack${needs.length === 1 ? "" : "s"} to install.` : ""}`,
  );
}
