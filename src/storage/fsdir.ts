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

  /**
   * Write through a temporary file and rename, so an interrupted write cannot
   * leave a half-written randomizer behind. Where rename is unavailable we
   * write in place and accept the smaller guarantee rather than failing.
   */
  async write(path: string, contents: string): Promise<void> {
    const dir = await this.#dir(parent(path), true);
    const name = basename(path);
    const tmpName = `.${name}.tmp`;
    try {
      const tmp = await dir.getFileHandle(tmpName, { create: true });
      const stream = await tmp.createWritable();
      await stream.write(contents);
      await stream.close();
      // @ts-ignore - move() is not in every lib.dom yet
      if (typeof tmp.move === "function") {
        // @ts-ignore
        await tmp.move(dir, name);
        return;
      }
      const target = await dir.getFileHandle(name, { create: true });
      const out = await target.createWritable();
      await out.write(contents);
      await out.close();
      await dir.removeEntry(tmpName).catch(() => {});
    } catch {
      const target = await dir.getFileHandle(name, { create: true });
      const out = await target.createWritable();
      await out.write(contents);
      await out.close();
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
      await this.write(to, await this.read(from));
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
      else await this.write(dst, await this.read(src));
    }
  }

  async remove(path: string): Promise<void> {
    const dir = await this.#dir(parent(path));
    await dir.removeEntry(basename(path), { recursive: true });
  }
}

export async function openOpfs(): Promise<DirectoryBackend | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const library = await root.getDirectoryHandle("library", { create: true });
    return new DirectoryBackend(library, "opfs", "Browser storage");
  } catch {
    return null;
  }
}

export function canPickFolder(): boolean {
  return typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";
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
