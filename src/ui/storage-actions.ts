/**
 * The things you can do to where the library is kept.
 *
 * Both the library's storage badge and the Storage card in Settings offer
 * these, so they live here rather than in either view. Nothing here draws
 * anything: each returns whether something changed, and the caller re-renders.
 */

import { serialize, wrap } from "../model/file.ts";
import { LibraryService } from "../storage/library.ts";
import { canPickFolder, forgetFolder, pickFolder } from "../storage/fsdir.ts";
import { createZip } from "../storage/zip.ts";
import { parent } from "../storage/paths.ts";
import { askConfirm } from "./dom.ts";
import { state } from "./state.ts";
import { downloadBytes } from "./views/library.ts";

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
      await next.refresh();
    }
  }
  state.library = next;
  state.folderNeedsPermission = false;
  void state.savePrefs({ backend: "fsa" });
  state.toast(`Library is now the folder “${backend.label}”`);
  return true;
}

export async function stopUsingFolder(): Promise<void> {
  await forgetFolder();
  state.toast("Reload to go back to browser storage.");
}

/** The whole tree as a ZIP: the backup that works in every browser. */
export async function exportLibraryZip(): Promise<void> {
  const entries = state.library
    .files()
    .filter((f) => f.randomizer)
    .map((f) => ({ path: f.path, text: serialize(wrap(f.randomizer!)) }));
  const zip = await createZip(entries);
  downloadBytes("orangey-library.zip", zip);
  state.toast(`Exported ${entries.length} randomizer${entries.length === 1 ? "" : "s"}`);
}
