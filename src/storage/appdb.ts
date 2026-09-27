/**
 * Per-device application storage: preferences, history, recents and favourites.
 *
 * It holds nothing that cannot be rebuilt, so losing it costs convenience, never
 * content.
 */

import type { FeelSettings } from "../ui/feel.ts";
import type { CustomColour } from "../model/settings-file.ts";
import type { CustomScheme } from "../core/theme.ts";

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
  /**
   * Dice rolled inside the outcome's text, e.g. "2d4 [1, 2] = 3", and for an
   * outcome picked from an offer, "chosen from A, B, C".
   */
  parts?: string[];
  /**
   * The roll whose outcome link opened this randomizer. Names, not ids, so the
   * row still reads right after either randomizer is renamed or deleted.
   */
  from?: RollOrigin;
}

export interface RollOrigin {
  randomizerName: string;
  label: string;
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
  /** Colour scheme: a built-in one, "system", or "custom" for your own. */
  scheme: string;
  /**
   * Your own theme, kept when another scheme is chosen so it can be chosen again.
   * Do not reuse the key `theme`: stored prefs may still hold an old one.
   */
  customScheme?: CustomScheme;
  /** Colours the user added to the palette; offered in the colour cell. */
  colours: CustomColour[];
  /** The one-time Add to Home Screen notice has been seen and dismissed. */
  homeScreenNoticeSeen?: boolean;
}

const DB_NAME = "orangey";
const DB_VERSION = 1;
export const HISTORY_CAP = 5000;
/**
 * How many recent rolls the app holds in memory, for the History view and the
 * Recent rolls panel. The store keeps up to `HISTORY_CAP`; an export reads all.
 */
export const HISTORY_IN_MEMORY = 500;

/**
 * One connection per operation, closed when its transaction ends.
 *
 * A connection held open while the site's storage is cleared (by the user, or
 * by the browser tests between cases) left every later IndexedDB open on the
 * origin slow or failing, and no `onversionchange`, `onclose` or retry fixed
 * it. An open costs a few milliseconds.
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

/** A read resolves as soon as its request does; nothing is left to commit. */
function txRead<T>(store: string, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return withTransaction<T>(store, "readonly", (s, resolve, reject) => {
    const req = fn(s);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * A write resolves only once the transaction commits: a request that has
 * succeeded can still be rolled back.
 */
function txWrite(store: string, fn: (s: IDBObjectStore) => void): Promise<void> {
  const write = withTransaction<void>(store, "readwrite", (s, resolve, _reject, t) => {
    fn(s);
    t.addEventListener("complete", () => resolve());
  });
  pendingWrites.add(write);
  const done = () => pendingWrites.delete(write);
  write.then(done, done);
  return write;
}

/**
 * Writes not yet committed or failed. A history row is written just after the
 * answer shows, so a test about to close its page waits on `storageSettled`
 * rather than guessing how long a write takes.
 */
const pendingWrites = new Set<Promise<void>>();

/** Resolves once every write started so far has committed or failed. */
export async function storageSettled(): Promise<void> {
  while (pendingWrites.size) await Promise.allSettled([...pendingWrites]);
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
   * The most recent rolls, newest first. Read backwards through the `at` index
   * so only `limit` entries are loaded, not the whole store.
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
   * Keep the store to `HISTORY_CAP`, dropping the oldest. Counts first, so the
   * usual roll costs one count and nothing else.
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
