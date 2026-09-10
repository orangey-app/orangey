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

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
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

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
      }),
  );
}

export const appdb = {
  async get<T>(key: string): Promise<T | undefined> {
    try {
      return await tx<T>("kv", "readonly", (s) => s.get(key) as IDBRequest<T>);
    } catch {
      return undefined;
    }
  },

  async set(key: string, value: unknown): Promise<void> {
    try {
      await tx("kv", "readwrite", (s) => s.put(value, key));
    } catch {
      /* storage may be unavailable; the app keeps working in memory */
    }
  },

  async addHistory(entry: HistoryEntry): Promise<void> {
    try {
      await tx("history", "readwrite", (s) => s.put(entry));
      await this.trimHistory();
    } catch {
      /* ignore */
    }
  },

  async history(limit = 200): Promise<HistoryEntry[]> {
    try {
      const all = await tx<HistoryEntry[]>("history", "readonly", (s) => s.getAll() as IDBRequest<HistoryEntry[]>);
      return all.sort((a, b) => b.at - a.at).slice(0, limit);
    } catch {
      return [];
    }
  },

  async removeHistory(id: string): Promise<void> {
    try {
      await tx("history", "readwrite", (s) => s.delete(id));
    } catch {
      /* ignore */
    }
  },

  async clearHistory(): Promise<void> {
    try {
      await tx("history", "readwrite", (s) => s.clear());
    } catch {
      /* ignore */
    }
  },

  async trimHistory(): Promise<void> {
    const all = await tx<HistoryEntry[]>("history", "readonly", (s) => s.getAll() as IDBRequest<HistoryEntry[]>).catch(() => []);
    if (all.length <= HISTORY_CAP) return;
    const doomed = all.sort((a, b) => a.at - b.at).slice(0, all.length - HISTORY_CAP);
    for (const e of doomed) await this.removeHistory(e.id);
  },
};
