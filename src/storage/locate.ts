/**
 * Where the library is. One rule, used by Orangey and by Sekwe (which
 * copies this folder), so the two can never disagree about it.
 *
 * In order: the folder on disk chosen last time, if the browser still lets us
 * in without a click; the browser's own storage; and only then memory, which
 * the UI flags because nothing survives. A remembered folder that needs a
 * click to reopen is reported as `folder: "ask"` alongside the browser
 * storage, and the caller decides what to show meanwhile.
 */

import { openOpfs, reopenFolder, type FolderAccess } from "./fsdir.ts";
import { IndexedDbBackend } from "./idb.ts";
import type { LibraryBackend } from "./library.ts";

/**
 * The browser's own storage: the origin-private filesystem where writable,
 * IndexedDB otherwise. A library already in IndexedDB wins over an empty
 * filesystem, so a browser that gains OPFS in an update (Safari did) does not
 * hide it.
 */
export async function pickBrowserStorage(): Promise<LibraryBackend | null> {
  const opfs = await openOpfs();
  if (!opfs) return IndexedDbBackend.open();
  const empty = (await opfs.list("").catch(() => [])).length === 0;
  if (!empty || (await IndexedDbBackend.exists()) === false) return opfs;
  const idb = await IndexedDbBackend.open();
  if (!idb) return opfs;
  if ((await idb.list("").catch(() => [])).length > 0) return idb;
  idb.close();
  return opfs;
}

export interface LibraryLocation {
  /** The folder on disk if it opened, else the browser's storage; null if neither. */
  backend: LibraryBackend | null;
  /** A folder was chosen before and needs a click (`regrantFolder`) to reopen. */
  folder: "ask" | null;
}

/** Orangey asks for "readwrite"; a reader such as Sekwe asks for "read". */
export async function locateLibrary(access: FolderAccess = "readwrite"): Promise<LibraryLocation> {
  const remembered = await reopenFolder(access);
  if (remembered && remembered !== "ask") return { backend: remembered, folder: null };
  return { backend: await pickBrowserStorage(), folder: remembered === "ask" ? "ask" : null };
}
