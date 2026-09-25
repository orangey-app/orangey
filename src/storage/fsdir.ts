/**
 * A library backend over any FileSystemDirectoryHandle.
 *
 * Both storage backends the browser offers have the same shape, so they share
 * this implementation: OPFS hands us a private root, and the File System
 * Access API hands us a folder the user picked. The only differences are the
 * label, and that a picked folder can be revoked.
 */

import type { Entry, LibraryBackend } from "./library.ts";
import { appdb } from "./appdb.ts";
import { basename, parent, segments } from "./paths.ts";

type DirHandle = FileSystemDirectoryHandle;

export class DirectoryBackend implements LibraryBackend {
  readonly kind: "opfs" | "fsa";
  readonly label: string;
  writable = true;
  #root: DirHandle;

  constructor(root: DirHandle, kind: "opfs" | "fsa", label: string) {
    this.#root = root;
    this.kind = kind;
    this.label = label;
  }

  async #dir(path: string, create = false): Promise<DirHandle> {
    let dir = this.#root;
    for (const part of segments(path)) {
      dir = await dir.getDirectoryHandle(part, { create });
    }
    return dir;
  }

  async list(path: string): Promise<Entry[]> {
    const dir = await this.#dir(path);
    const out: Entry[] = [];
    // @ts-ignore - async iteration over directory entries
    for await (const [name, handle] of dir.entries()) {
      if (name.startsWith(".")) continue;
      out.push({ name, kind: handle.kind === "directory" ? "folder" : "file" });
    }
    return out;
  }

  async read(path: string): Promise<string> {
    const dir = await this.#dir(parent(path));
    const handle = await dir.getFileHandle(basename(path));
    const file = await handle.getFile();
    return file.text();
  }

  async write(path: string, contents: string): Promise<void> {
    await this.#writeFile(path, contents);
  }

  /**
   * Pictures are written as themselves. A .png in the library folder is a .png
   * on the disk, so the owner can open it, edit it in whatever they draw with,
   * and drop a new one over it.
   */
  async readBytes(path: string): Promise<Uint8Array> {
    const dir = await this.#dir(parent(path));
    const handle = await dir.getFileHandle(basename(path));
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    await this.#writeFile(path, bytes);
  }

  /**
   * Write through a temporary file and rename, so an interrupted write cannot
   * leave a half-written randomizer behind. Where rename is unavailable we
   * write in place and accept the smaller guarantee rather than failing.
   */
  async #writeFile(path: string, contents: string | Uint8Array): Promise<void> {
    const dir = await this.#dir(parent(path), true);
    const name = basename(path);
    const tmpName = `.${name}.tmp`;
    try {
      const tmp = await dir.getFileHandle(tmpName, { create: true });
      const stream = await tmp.createWritable();
      await stream.write(contents as FileSystemWriteChunkType);
      await stream.close();
      // @ts-ignore - move() is not in every lib.dom yet
      if (typeof tmp.move === "function") {
        // @ts-ignore
        await tmp.move(dir, name);
        return;
      }
      const target = await dir.getFileHandle(name, { create: true });
      const out = await target.createWritable();
      await out.write(contents as FileSystemWriteChunkType);
      await out.close();
      await dir.removeEntry(tmpName).catch(() => {});
    } catch {
      const target = await dir.getFileHandle(name, { create: true });
      const out = await target.createWritable();
      await out.write(contents as FileSystemWriteChunkType);
      await out.close();
      // Whatever went wrong above may still have made the temp file, and a
      // folder of ".forest.orangey.json.tmp" is the user's folder, not ours.
      await dir.removeEntry(tmpName).catch(() => {});
    }
  }

  async mkdir(path: string): Promise<void> {
    await this.#dir(path, true);
  }

  async move(from: string, to: string): Promise<void> {
    const fromDir = await this.#dir(parent(from));
    let handle: FileSystemHandle;
    try {
      handle = await fromDir.getFileHandle(basename(from));
    } catch {
      handle = await fromDir.getDirectoryHandle(basename(from));
    }
    const toDir = await this.#dir(parent(to), true);
    // @ts-ignore - move() where available is atomic and cheap
    if (typeof (handle as { move?: unknown }).move === "function") {
      // @ts-ignore
      await handle.move(toDir, basename(to));
      return;
    }
    if (handle.kind === "file") {
      // Bytes, not text: a folder being moved may hold pictures, and a PNG
      // that went out through a TextDecoder would arrive unopenable.
      await this.writeBytes(to, await this.readBytes(from));
      await this.remove(from);
      return;
    }
    await this.#copyTree(from, to);
    await this.remove(from);
  }

  async #copyTree(from: string, to: string): Promise<void> {
    await this.mkdir(to);
    for (const entry of await this.list(from)) {
      const src = `${from}/${entry.name}`;
      const dst = `${to}/${entry.name}`;
      if (entry.kind === "folder") await this.#copyTree(src, dst);
      else await this.writeBytes(dst, await this.readBytes(src));
    }
  }

  async remove(path: string): Promise<void> {
    const dir = await this.#dir(parent(path));
    await dir.removeEntry(basename(path), { recursive: true });
  }
}

/**
 * The origin-private filesystem, but only where it can be written to.
 *
 * Safari up to 18 — every browser on an iPhone or iPad running iOS 18, since
 * they all use its engine — hands out the directory and lists it, and has no
 * `createWritable()`: reads succeed and every write throws. A library that
 * can be listed but not written to is worse than none, because the first
 * write is the starters, the next is the person's first wheel, and each of
 * them fails after the app has already opened. So the check is a write: one
 * small file, made and removed, and any failure at all sends the caller on
 * to IndexedDB, which those browsers do have.
 */
export async function openOpfs(): Promise<DirectoryBackend | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const library = await root.getDirectoryHandle("library", { create: true });
    const backend = new DirectoryBackend(library, "opfs", "Browser storage");
    await backend.write(PROBE_NAME, "");
    await backend.remove(PROBE_NAME);
    return backend;
  } catch {
    return null;
  }
}

/** Dot-prefixed so that a probe left behind by a crash never shows in the tree. */
const PROBE_NAME = ".orangey-write-probe";

export function canPickFolder(): boolean {
  return typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";
}

/** What this browser can do about keeping a library, as far as the advice cares. */
export interface StorageEnv {
  canPickFolder: boolean;
  /**
   * Safari on iPhone and iPad — and every other browser there, since they all
   * run on Safari's engine. Only those have `navigator.standalone`, so this is
   * read from what the browser has rather than guessed from its name.
   */
  ios: boolean;
  /** Running as a home-screen or Dock app rather than in a browser tab. */
  standalone: boolean;
}

export function storageEnv(): StorageEnv {
  const nav = globalThis.navigator as (Navigator & { standalone?: boolean }) | undefined;
  const displayStandalone = typeof globalThis.matchMedia === "function" && globalThis.matchMedia("(display-mode: standalone)").matches;
  return {
    canPickFolder: canPickFolder(),
    ios: typeof nav?.standalone === "boolean",
    standalone: nav?.standalone === true || displayStandalone,
  };
}

/**
 * What to tell someone whose library cannot live in a folder.
 *
 * A folder is where the library is safest, and most browsers that cannot pick
 * one are Safari, which clears the storage of a site nobody has opened for
 * about a week — unless it runs as a home-screen (iPhone, iPad) or Dock (Mac)
 * app. The one-time notice is for the case where that matters most and the
 * fix is one tap away: an iPhone or iPad, in a browser tab. Nowhere else.
 */
export function storageAdvice(env: StorageEnv): { note: string | null; homeScreenNotice: boolean } {
  if (env.canPickFolder) return { note: null, homeScreenNotice: false };
  if (env.ios) {
    return env.standalone
      ? {
          note: "On iPhone and iPad no browser can keep the library in a folder, so it lives in Orangey's own storage. Running from the Home Screen keeps it safe from Safari's clear-out; export a ZIP now and then as your backup.",
          homeScreenNotice: false,
        }
      : {
          note: "On iPhone and iPad no browser can keep the library in a folder, and Safari clears the storage of a site nobody has opened for about a week. Add Orangey to your Home Screen (Share, then Add to Home Screen) and the library stays; export a ZIP now and then as your backup.",
          homeScreenNotice: true,
        };
  }
  return {
    note: "This browser cannot keep the library in a folder; Chrome and Edge can, on Windows, Mac and Linux. Safari may clear the storage of a site nobody has opened for about a week, which adding it to the Dock (File, then Add to Dock) prevents. Either way, export a ZIP now and then as your backup.",
    homeScreenNotice: false,
  };
}

export async function pickFolder(): Promise<DirectoryBackend | null> {
  if (!canPickFolder()) return null;
  // @ts-ignore - not in every lib.dom
  const handle: DirHandle = await globalThis.showDirectoryPicker({ id: "orangey-library", mode: "readwrite" });
  const permission = await (handle as unknown as { requestPermission?: (o: unknown) => Promise<string> })
    .requestPermission?.({ mode: "readwrite" });
  const backend = new DirectoryBackend(handle, "fsa", handle.name);
  if (permission === "denied") backend.writable = false;
  // Remember the folder: a directory handle can be stored in IndexedDB and
  // reopened next time, so the choice survives a reload instead of quietly
  // falling back to browser storage.
  await appdb.set("folderHandle", handle);
  return backend;
}

/**
 * Reopen the folder chosen last time, if the browser still lets us.
 * Returns the backend when permission is already granted, "ask" when the user
 * has to click to grant it again (browsers require a gesture), or null when
 * no folder was ever chosen.
 */
export async function reopenFolder(): Promise<DirectoryBackend | "ask" | null> {
  const handle = await appdb.get<DirHandle>("folderHandle");
  if (!handle) return null;
  try {
    const query = (handle as unknown as { queryPermission?: (o: unknown) => Promise<string> }).queryPermission;
    const state = query ? await query.call(handle, { mode: "readwrite" }) : "granted";
    if (state === "granted") return new DirectoryBackend(handle, "fsa", handle.name);
    return "ask";
  } catch {
    return null;
  }
}

/** Grant access again after a reload; must be called from a click. */
export async function regrantFolder(): Promise<DirectoryBackend | null> {
  const handle = await appdb.get<DirHandle>("folderHandle");
  if (!handle) return null;
  const request = (handle as unknown as { requestPermission?: (o: unknown) => Promise<string> }).requestPermission;
  const state = request ? await request.call(handle, { mode: "readwrite" }) : "granted";
  return state === "granted" ? new DirectoryBackend(handle, "fsa", handle.name) : null;
}

export async function forgetFolder(): Promise<void> {
  await appdb.set("folderHandle", null);
}

/** The name of the remembered folder, for the reconnect prompt. */
export async function rememberedFolderName(): Promise<string | null> {
  const handle = await appdb.get<DirHandle>("folderHandle");
  return handle?.name ?? null;
}
