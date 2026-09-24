/**
 * Application storage: preferences, history, recents and favourites.
 *
 * This is the part that is genuinely the browser's, not the user's: it never
 * holds anything that is not reconstructible, so losing it costs a little
 * convenience and no content (plan C5, decision D12).
 */

import type { FeelSettings } from "../ui/feel.ts";
import type { CustomColour } from "../model/settings-file.ts";

export interface HistoryEntry {
  id: string;
  at: number;
  /** The randomizer's id, or null for an ad-hoc roll. */
  randomizerId: string | null;
  /** Snapshotted so history survives the randomizer being deleted. */
  randomizerName: string;
  type: string;
  resultText: string;
  speakText: string;
  seed?: string;
  /** Enough to repeat the roll: an expression, or the randomizer id. */
  repeat?: { kind: "dice"; expression: string } | { kind: "randomizer"; id: string };
}

export interface Prefs {
  feel: FeelSettings;
  seed: string | null;
  lastPath: string | null;
  expandedFolders: string[];
  favourites: string[];
  backend: "opfs" | "idb" | "fsa" | "memory";
  reducedMotionOverridden: boolean;
  /** Starter randomizers have been added once. */
  seeded: boolean;
  /** Animation switched off from the play screen for now. */
  animationsOff: boolean;
  /** Colour scheme. */
  scheme: string;
  /** Colours the user added to the palette; offered in the colour cell. */
  colours: CustomColour[];
}

const DB_NAME = "orangey";
const DB_VERSION = 1;
export const HISTORY_CAP = 5000;
/**
 * How many of those rolls the app holds in memory.
 *
 * The store keeps up to `HISTORY_CAP`; this is the recent slice the History
 * view and the Recent rolls panel work from. An export asks for the lot.
 */
export const HISTORY_IN_MEMORY = 500;

/**
 * One connection per operation, closed when its transaction ends.
 *
 * Keeping a single connection open for the life of the page was tried and
 * withdrawn. Clearing the site's storage while a connection is held — a user
 * clearing site data, or the browser tests doing it between cases — left
 * every later IndexedDB open on the origin slow or failing, for the library
 * database as well as this one, and neither `onversionchange`, `onclose` nor
 * a retry prevented it. An open costs a few milliseconds; a preference that
 * silently stops saving costs the user their settings.
 */
function openDb(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("history")) {
        const store = db.createObjectStore("history", { keyPath: "id" });
        store.createIndex("at", "at");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Run one transaction on a connection of its own, and close the connection
 * however the transaction ends. `settle` decides what the caller is waiting
 * for: a read resolves with its request, a write only when it has committed.
 */
function withTransaction<T>(
  store: string,
  mode: IDBTransactionMode,
  body: (s: IDBObjectStore, resolve: (value: T) => void, reject: (reason: unknown) => void, t: IDBTransaction) => void,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let t: IDBTransaction;
        try {
          t = db.transaction(store, mode);
        } catch (e) {
          db.close();
          reject(e);
          return;
        }
        t.addEventListener("complete", () => db.close());
        t.addEventListener("abort", () => {
          db.close();
          reject(t.error ?? new Error("transaction aborted"));
        });
        t.addEventListener("error", () => reject(t.error));
        body(t.objectStore(store), resolve, reject, t);
      }),
  );
}

/**
 * A read: the request's own result.
 *
 * Reads may resolve as soon as the request does — the value is already in
 * hand and the transaction has nothing left to do.
 */
function txRead<T>(store: string, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return withTransaction<T>(store, "readonly", (s, resolve, reject) => {
    const req = fn(s);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * A write: only once the transaction commits.
 *
 * A request that has succeeded is not yet durable; resolving on it meant
 * telling the app a preference was saved while it could still be rolled back.
 */
function txWrite(store: string, fn: (s: IDBObjectStore) => void): Promise<void> {
  return withTransaction<void>(store, "readwrite", (s, resolve, _reject, t) => {
    fn(s);
    t.addEventListener("complete", () => resolve());
  });
}

export const appdb = {
  async get<T>(key: string): Promise<T | undefined> {
    try {
      return await txRead<T>("kv", (s) => s.get(key) as IDBRequest<T>);
    } catch {
      return undefined;
    }
  },

  async set(key: string, value: unknown): Promise<void> {
    try {
      await txWrite("kv", (s) => {
        s.put(value, key);
      });
    } catch {
      /* storage may be unavailable; the app keeps working in memory */
    }
  },

  async addHistory(entry: HistoryEntry): Promise<void> {
    try {
      await txWrite("history", (s) => {
        s.put(entry);
      });
      await this.trimHistory();
    } catch {
      /* ignore */
    }
  },

  /**
   * The most recent rolls, newest first.
   *
   * Through the `at` index backwards rather than `getAll()` then sort: the
   * store holds up to `HISTORY_CAP` entries, and reading five thousand of
   * them to show the last few hundred is work the index can avoid.
   */
  async history(limit = HISTORY_IN_MEMORY): Promise<HistoryEntry[]> {
    try {
      return await withTransaction<HistoryEntry[]>("history", "readonly", (s, resolve, reject) => {
        const req = s.index("at").openCursor(null, "prev");
        const out: HistoryEntry[] = [];
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor || out.length >= limit) {
            resolve(out);
            return;
          }
          out.push(cursor.value as HistoryEntry);
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      });
    } catch {
      return [];
    }
  },

  async removeHistory(id: string): Promise<void> {
    try {
      await txWrite("history", (s) => {
        s.delete(id);
      });
    } catch {
      /* ignore */
    }
  },

  /** Several at once: clearing a randomizer's rolls is one transaction. */
  async removeHistoryMany(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      await txWrite("history", (s) => {
        for (const id of ids) s.delete(id);
      });
    } catch {
      /* ignore */
    }
  },

  async clearHistory(): Promise<void> {
    try {
      await txWrite("history", (s) => {
        s.clear();
      });
    } catch {
      /* ignore */
    }
  },

  /**
   * Keep the store to `HISTORY_CAP`, oldest first.
   *
   * Counting first means the usual case — every roll after the first few
   * thousand — costs one count and nothing else, where it used to read every
   * stored entry on every roll.
   */
  async trimHistory(): Promise<void> {
    try {
      const count = await txRead<number>("history", (s) => s.count());
      if (count <= HISTORY_CAP) return;
      let over = count - HISTORY_CAP;
      await txWrite("history", (s) => {
        const req = s.index("at").openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor || over <= 0) return;
          cursor.delete();
          over--;
          cursor.continue();
        };
      });
    } catch {
      /* ignore */
    }
  },
};
