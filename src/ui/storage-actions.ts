/**
 * The things you can do to where the library is kept.
 *
 * Both the library's storage badge and the Storage card in Settings offer
 * these, so they live here rather than in either view. Nothing here draws
 * anything: each returns whether something changed, and the caller re-renders.
 */

import { serialize, slugify, wrap } from "../model/file.ts";
import type { BoardRandomizer, Randomizer } from "../model/randomizer.ts";
import { IMAGE_DIR, LibraryService } from "../storage/library.ts";
import { canPickFolder, forgetFolder, pickFolder } from "../storage/fsdir.ts";
import { imageBytes, imageDataUrl, imageStoredName, putImageData } from "../storage/images.ts";
import { createZip, type ZipEntry } from "../storage/zip.ts";
import { parent } from "../storage/paths.ts";
import { askConfirm, downloadBytes } from "./dom.ts";
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
 * Whether the browser has promised to keep this site's data.
 *
 * Without it a browser may evict the library when the disk gets tight. Asking
 * is a separate step (`askToPersist`) because Firefox prompts for it, and a
 * permission prompt nobody asked for is worse than the risk.
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
      // The pictures go too, or every wheel that has one arrives in the new
      // folder pointing at nothing. They are not in the tree, so they are
      // copied straight from one backend to the other.
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
 * A copy of a randomizer that carries its pictures inside it.
 *
 * A bare .orangey.json has nowhere to put a picture except in itself, so the
 * outcomes swap their `image` id for the picture inline. That is what makes a
 * single exported file work on a machine that has never seen this library.
 */
export async function portableRandomizer(r: Randomizer): Promise<Randomizer> {
  if (r.type !== "list" || !r.items.some((i) => i.image)) return r;
  const items = await Promise.all(r.items.map(async (item) => {
    if (!item.image) return item;
    const { image: _image, ...rest } = item;
    const inline = await imageDataUrl(item.image);
    // A picture the store has lost takes the reference with it: an id that
    // resolves to nothing here will resolve to nothing there either.
    return inline ? { ...rest, imageData: inline } : rest;
  }));
  return { ...r, items };
}

/**
 * And the way back in: the pictures a file brought with it go to the store,
 * and the outcomes go back to naming ids.
 */
export async function absorbImages(r: Randomizer): Promise<Randomizer> {
  if (r.type !== "list" || !r.items.some((i) => i.imageData)) return r;
  const items = await Promise.all(r.items.map(async (item) => {
    if (!item.imageData) return item;
    const { imageData, ...rest } = item;
    try {
      return { ...rest, image: await putImageData(imageData) };
    } catch {
      // A picture that cannot be read loses the outcome nothing else: the
      // wheel still rolls, with one segment short of a picture.
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
 * The pictures for an archive, one entry each.
 *
 * An archive has room for files of its own, so it keeps them as pictures
 * rather than inlining them: the same picture on four wheels is packed once,
 * and anyone who opens the ZIP finds PNGs they can look at.
 */
async function pictureEntries(randomizers: Randomizer[]): Promise<ZipEntry[]> {
  const entries: ZipEntry[] = [];
  for (const id of usedImageIds(randomizers)) {
    const bytes = await imageBytes(id);
    if (!bytes) continue;
    // Its real name, so what comes out of the archive is a file the person's
    // computer will open rather than a JPEG called .png.
    const name = (await imageStoredName(id)) ?? `${id}.png`;
    entries.push({ path: `${IMAGE_DIR}/${name}`, bytes });
  }
  return entries;
}

/**
 * The files a board needs to work somewhere else: the board itself, and every
 * randomizer it points at.
 *
 * A board refers to randomizers by id rather than carrying copies, so it
 * travels as an archive: a link can hold one randomizer, not a table's worth.
 * A reference whose randomizer is gone is reported rather than packed, because
 * the person receiving it should know what is missing before they open it.
 */
export function boardBundle(
  library: LibraryService,
  board: BoardRandomizer,
): { entries: { path: string; text: string }[]; missing: string[] } {
  const entries: { path: string; text: string }[] = [];
  const missing: string[] = [];
  const boardNode = library.findById(board.id);
  if (boardNode) entries.push({ path: boardNode.path, text: serialize(wrap(board)) });
  for (const entry of board.entries) {
    const node = library.findById(entry.id);
    if (!node?.randomizer) {
      missing.push(entry.name);
      continue;
    }
    entries.push({ path: node.path, text: serialize(wrap(node.randomizer)) });
  }
  return { entries, missing };
}

/**
 * Boards in the library that point at something no longer there.
 *
 * Used after importing an archive: someone who is handed a board and opens it
 * should be told a piece is missing then, not when the board draws a gap.
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
  const { entries, missing } = boardBundle(state.library, board);
  const packed = board.entries
    .map((e) => state.library.findById(e.id)?.randomizer)
    .filter((r): r is Randomizer => Boolean(r));
  const zip = await createZip([...entries, ...(await pictureEntries(packed))]);
  downloadBytes(`${slugify(board.name)}.zip`, zip);
  const count = `${entries.length} file${entries.length === 1 ? "" : "s"}`;
  state.toast(
    missing.length
      ? `Exported ${count}. Missing from your library: ${missing.join(", ")}.`
      : `Exported ${count}: the board and everything on it.`,
  );
}

/** The whole tree as a ZIP: the backup that works in every browser. */
export async function exportLibraryZip(): Promise<void> {
  const randomizers = state.library.files().map((f) => f.randomizer).filter((r): r is Randomizer => Boolean(r));
  const entries = state.library
    .files()
    .filter((f) => f.randomizer)
    .map((f) => ({ path: f.path, text: serialize(wrap(f.randomizer!)) }));
  const pictures = await pictureEntries(randomizers);
  const zip = await createZip([...entries, ...pictures]);
  downloadBytes("orangey-library.zip", zip);
  state.toast(
    `Exported ${entries.length} randomizer${entries.length === 1 ? "" : "s"}` +
      `${pictures.length ? ` and ${pictures.length} picture${pictures.length === 1 ? "" : "s"}` : ""}`,
  );
}
