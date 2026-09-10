/**
 * A library backend on IndexedDB.
 *
 * This is what the single-file build uses. A page opened from disk gets no
 * origin-private filesystem, so without this the library fell through to
 * memory and vanished on reload — which is exactly what happened the first
 * time someone tried it. IndexedDB is available to file:// pages in every
 * current browser, so a downloaded orangey.html keeps its library after all.
 *
 * The tree is stored flat: one record per file or folder, keyed by path.
 */

import type { Entry, LibraryBackend } from "./library.ts";
import { basename, parent } from "./paths.ts";

const LIBRARY_DB = "orangey-library";
const LIBRARY_STORE = "entries";

interface Record_ {
  path: string;
  kind: "file" | "folder";
  text?: string;
}

function openLibraryDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(LIBRARY_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(LIBRARY_STORE)) db.createObjectStore(LIBRARY_STORE, { keyPath: "path" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("the library database is open elsewhere"));
  });
}

function runLibraryTx<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(LIBRARY_STORE, mode);
    let result: T;
    const req = fn(tx.objectStore(LIBRARY_STORE));
    if (req) {
      req.onsuccess = () => {
        result = req.result;
      };
      req.onerror = () => reject(req.error);
    }
    tx.oncomplete = () => resolve(result!);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
  });
}

export class IndexedDbBackend implements LibraryBackend {
  readonly kind = "idb";
  readonly label = "Browser storage";
  readonly writable = true;
  #db: IDBDatabase;

  private constructor(db: IDBDatabase) {
    this.#db = db;
  }

  static async open(): Promise<IndexedDbBackend | null> {
    try {
      if (typeof indexedDB === "undefined") return null;
      const db = await openLibraryDb();
      return new IndexedDbBackend(db);
    } catch {
      return null;
    }
  }

  async #all(): Promise<Record_[]> {
    return runLibraryTx<Record_[]>(this.#db, "readonly", (s) => s.getAll() as IDBRequest<Record_[]>);
  }

  async list(path: string): Promise<Entry[]> {
    const all = await this.#all();
    return all
      .filter((r) => r.path !== "" && parent(r.path) === path)
      .map((r) => ({ name: basename(r.path), kind: r.kind }));
  }

  async read(path: string): Promise<string> {
    const record = await runLibraryTx<Record_ | undefined>(this.#db, "readonly", (s) => s.get(path) as IDBRequest<Record_ | undefined>);
    if (!record || record.kind !== "file") throw new Error(`no file at ${path}`);
    return record.text ?? "";
  }

  async write(path: string, contents: string): Promise<void> {
    const folders = this.#foldersAbove(path);
    await runLibraryTx(this.#db, "readwrite", (s) => {
      for (const f of folders) s.put({ path: f, kind: "folder" } satisfies Record_);
      s.put({ path, kind: "file", text: contents } satisfies Record_);
    });
  }

  async mkdir(path: string): Promise<void> {
    if (path === "") return;
    const folders = [...this.#foldersAbove(path), path];
    await runLibraryTx(this.#db, "readwrite", (s) => {
      for (const f of folders) s.put({ path: f, kind: "folder" } satisfies Record_);
    });
  }

  async move(from: string, to: string): Promise<void> {
    const all = await this.#all();
    const source = all.find((r) => r.path === from);
    if (!source) throw new Error(`nothing at ${from}`);
    const affected = all.filter((r) => r.path === from || r.path.startsWith(`${from}/`));
    const folders = this.#foldersAbove(to);
    await runLibraryTx(this.#db, "readwrite", (s) => {
      for (const f of folders) s.put({ path: f, kind: "folder" } satisfies Record_);
      for (const r of affected) {
        s.delete(r.path);
        s.put({ ...r, path: to + r.path.slice(from.length) });
      }
    });
  }

  async remove(path: string): Promise<void> {
    const all = await this.#all();
    const doomed = all.filter((r) => r.path === path || r.path.startsWith(`${path}/`));
    if (doomed.length === 0) throw new Error(`nothing at ${path}`);
    await runLibraryTx(this.#db, "readwrite", (s) => {
      for (const r of doomed) s.delete(r.path);
    });
  }

  #foldersAbove(path: string): string[] {
    const parts = path.split("/").slice(0, -1);
    return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
  }
}
