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

import { IMAGE_DIR, type Entry, type LibraryBackend } from "./library.ts";
import { basename, parent } from "./paths.ts";

const LIBRARY_DB = "orangey-library";
const LIBRARY_STORE = "entries";

interface Record_ {
  path: string;
  kind: "file" | "folder";
  text?: string;
  /** Pictures. IndexedDB stores a typed array as it is, so no encoding here. */
  bytes?: Uint8Array;
}

const idbEncoder = new TextEncoder();
const idbDecoder = new TextDecoder();

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

  /**
   * Whether a library database already exists here, without opening one.
   *
   * Opening creates the database, and an open connection that is then not
   * used is exactly what made clearing the site's storage misbehave (see
   * appdb). Where the browser cannot list its databases the answer is
   * "maybe", and the caller opens to find out.
   */
  static async exists(): Promise<boolean | "maybe"> {
    if (typeof indexedDB === "undefined") return false;
    const list = (indexedDB as { databases?: () => Promise<{ name?: string }[]> }).databases;
    if (typeof list !== "function") return "maybe";
    try {
      return (await list.call(indexedDB)).some((d) => d.name === LIBRARY_DB);
    } catch {
      return "maybe";
    }
  }

  /** Let go of the connection. For a backend that was opened and not chosen. */
  close(): void {
    this.#db.close();
  }

  /**
   * The records in a range of paths.
   *
   * Every read used to be `getAll()` over the whole store, which loads every
   * picture's bytes to answer a question about file names. Keys are paths and
   * are compared by code unit, so a folder's contents are a contiguous range;
   * "\uffff" is the conventional end of one, and `sanitizeName` cannot produce
   * it.
   */
  async #range(range: IDBKeyRange): Promise<Record_[]> {
    return runLibraryTx<Record_[]>(this.#db, "readonly", (s) => s.getAll(range) as IDBRequest<Record_[]>);
  }

  async #keysIn(range: IDBKeyRange): Promise<string[]> {
    return runLibraryTx<string[]>(this.#db, "readonly", (s) => s.getAllKeys(range) as IDBRequest<string[]>);
  }

  async list(path: string): Promise<Entry[]> {
    const records =
      path === ""
        ? // The top of the library, in two reads that step over the image
          // store: its records are the pictures themselves, and loading a
          // megabyte of bytes to list file names is the whole problem here.
          // The `images` folder record sorts before "images/" and so is still
          // included, which is what the tree builder expects to skip by name.
          [
            ...(await this.#range(IDBKeyRange.upperBound(`${IMAGE_DIR}/`, true))),
            ...(await this.#range(IDBKeyRange.lowerBound(`${IMAGE_DIR}/\uffff`, true))),
          ]
        : await this.#range(IDBKeyRange.bound(`${path}/`, `${path}/\uffff`));
    return records
      .filter((r) => r.path !== "" && parent(r.path) === path)
      .map((r) => ({ name: basename(r.path), kind: r.kind }));
  }

  /** One record and everything beneath it. */
  #subtree(path: string): IDBKeyRange {
    return IDBKeyRange.bound(`${path}/`, `${path}/\uffff`);
  }

  async #file(path: string): Promise<Record_> {
    const record = await runLibraryTx<Record_ | undefined>(this.#db, "readonly", (s) => s.get(path) as IDBRequest<Record_ | undefined>);
    if (!record || record.kind !== "file") throw new Error(`no file at ${path}`);
    return record;
  }

  async read(path: string): Promise<string> {
    const record = await this.#file(path);
    return record.bytes ? idbDecoder.decode(record.bytes) : record.text ?? "";
  }

  async write(path: string, contents: string): Promise<void> {
    await this.#put({ path, kind: "file", text: contents });
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const record = await this.#file(path);
    return record.bytes ?? idbEncoder.encode(record.text ?? "");
  }

  async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    await this.#put({ path, kind: "file", bytes });
  }

  async #put(record: Record_): Promise<void> {
    const folders = this.#foldersAbove(record.path);
    await runLibraryTx(this.#db, "readwrite", (s) => {
      for (const f of folders) s.put({ path: f, kind: "folder" } satisfies Record_);
      s.put(record);
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
    const source = await runLibraryTx<Record_ | undefined>(this.#db, "readonly", (s) => s.get(from) as IDBRequest<Record_ | undefined>);
    if (!source) throw new Error(`nothing at ${from}`);
    const affected = [source, ...(await this.#range(this.#subtree(from)))];
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
    // Keys only: a delete does not need what it is deleting, and a folder of
    // pictures would otherwise be read into memory to be thrown away.
    const here = await this.#keysIn(IDBKeyRange.only(path));
    const beneath = await this.#keysIn(this.#subtree(path));
    const doomed = [...here, ...beneath];
    if (doomed.length === 0) throw new Error(`nothing at ${path}`);
    await runLibraryTx(this.#db, "readwrite", (s) => {
      for (const key of doomed) s.delete(key);
    });
  }

  #foldersAbove(path: string): string[] {
    const parts = path.split("/").slice(0, -1);
    return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
  }
}
