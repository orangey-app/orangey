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
  theme: "system" | "light" | "dark";
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
 * One connection, kept open.
 *
 * Every call used to open the database, use it and close it again, so saving
 * a preference or writing a roll to history paid for a full open each time.
 * The handle is dropped on failure, and when another tab wants to upgrade the
 * schema, so a stale one is never reused.
 */
let dbHandle: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbHandle) return dbHandle;
  dbHandle = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("history")) {
        const store = db.createObjectStore("history", { keyPath: "id" });
        store.createIndex("at", "at");
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab is upgrading: let go, or it waits on us for ever.
      db.onversionchange = () => {
        dbHandle = null;
        db.close();
      };
      db.onclose = () => {
        dbHandle = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  }).catch((e) => {
    dbHandle = null;
    throw e;
  });
  return dbHandle;
}

/**
 * A read: the request's own result.
 *
 * Reads may resolve as soon as the request does — the value is already in
 * hand and the transaction has nothing left to do.
 */
function txRead<T>(store: string, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, "readonly");
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

/**
 * A write: only once the transaction commits.
 *
 * A request that has succeeded is not yet durable; resolving on it meant
 * telling the app a preference was saved while it could still be rolled back.
 */
function txWrite(store: string, fn: (s: IDBObjectStore) => void): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const t = db.transaction(store, "readwrite");
        fn(t.objectStore(store));
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error ?? new Error("transaction aborted"));
      }),
  );
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
      const db = await openDb();
      return await new Promise<HistoryEntry[]>((resolve, reject) => {
        const t = db.transaction("history", "readonly");
        const req = t.objectStore("history").index("at").openCursor(null, "prev");
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
