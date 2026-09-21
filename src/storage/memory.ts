/**
 * An in-memory library backend.
 *
 * It is the reference implementation the shared backend test suite runs
 * against, and it is what the app falls back to if neither OPFS nor a chosen
 * folder is available — a session with no persistence is better than an app
 * that refuses to start.
 */

import type { Entry, LibraryBackend } from "./library.ts";
import { basename, parent } from "./paths.ts";

const memoryEncoder = new TextEncoder();
const memoryDecoder = new TextDecoder();

export class MemoryBackend implements LibraryBackend {
  readonly kind = "memory";
  readonly label = "This session only";
  readonly writable = true;
  /**
   * One map for both kinds of file. A file is held as whatever it was written
   * as, and converted on the way out, so moving or removing a folder does not
   * have to know which of its files are pictures.
   */
  #files = new Map<string, string | Uint8Array>();
  #folders = new Set<string>([""]);

  async list(path: string): Promise<Entry[]> {
    const out: Entry[] = [];
    for (const f of this.#folders) {
      if (f !== "" && parent(f) === path) out.push({ name: basename(f), kind: "folder" });
    }
    for (const f of this.#files.keys()) {
      if (parent(f) === path) out.push({ name: basename(f), kind: "file" });
    }
    return out;
  }

  async read(path: string): Promise<string> {
    const content = this.#files.get(path);
    if (content === undefined) throw new Error(`no file at ${path}`);
    return typeof content === "string" ? content : memoryDecoder.decode(content);
  }

  async write(path: string, contents: string): Promise<void> {
    this.#ensureFolders(parent(path));
    this.#files.set(path, contents);
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const content = this.#files.get(path);
    if (content === undefined) throw new Error(`no file at ${path}`);
    return typeof content === "string" ? memoryEncoder.encode(content) : content;
  }

  async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    this.#ensureFolders(parent(path));
    // A copy: the caller may reuse or resize the buffer it handed us, and a
    // file that changes under the library is a bug with no witness.
    this.#files.set(path, bytes.slice());
  }

  async mkdir(path: string): Promise<void> {
    this.#ensureFolders(path);
  }

  async move(from: string, to: string): Promise<void> {
    if (this.#files.has(from)) {
      this.#ensureFolders(parent(to));
      this.#files.set(to, this.#files.get(from)!);
      this.#files.delete(from);
      return;
    }
    if (!this.#folders.has(from)) throw new Error(`nothing at ${from}`);
    this.#ensureFolders(to);
    for (const f of [...this.#folders]) {
      if (f === from || f.startsWith(`${from}/`)) {
        this.#folders.delete(f);
        this.#folders.add(to + f.slice(from.length));
      }
    }
    for (const [p, content] of [...this.#files]) {
      if (p.startsWith(`${from}/`)) {
        this.#files.delete(p);
        this.#files.set(to + p.slice(from.length), content);
      }
    }
  }

  async remove(path: string): Promise<void> {
    if (this.#files.delete(path)) return;
    if (!this.#folders.has(path)) throw new Error(`nothing at ${path}`);
    for (const f of [...this.#folders]) if (f === path || f.startsWith(`${path}/`)) this.#folders.delete(f);
    for (const p of [...this.#files.keys()]) if (p.startsWith(`${path}/`)) this.#files.delete(p);
  }

  #ensureFolders(path: string): void {
    if (path === "") return;
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) this.#folders.add(parts.slice(0, i).join("/"));
  }

  /** Test helper: everything the backend holds, for assertions. */
  snapshot(): Record<string, string> {
    return Object.fromEntries([...this.#files].map(([p, c]) => [p, typeof c === "string" ? c : memoryDecoder.decode(c)]));
  }
}
