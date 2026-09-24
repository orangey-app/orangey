/**
 * Bag mode: which outcomes have already been drawn.
 *
 * "Draw without putting back" is a property of the randomizer and lives in
 * its file; *what has been drawn so far* is not. It is like history: it
 * belongs to this device and this session of play, and two people rolling the
 * same shared wheel each have their own bag. Putting it in the file would
 * make every draw a write to the user's library and a change to sync.
 *
 * So the bag lives in the app database, keyed by randomizer id, with an
 * in-memory copy the roll path can read synchronously.
 */

import { appdb } from "../storage/appdb.ts";
import { state } from "./state.ts";

const bags = new Map<string, Set<string>>();

function bagKey(randomizerId: string): string {
  return `bag:${randomizerId}`;
}

/**
 * A randomizer that came out of a link has no file behind it, and its item
 * ids are made fresh on every load — so a stored bag could never match, and
 * storing one would only leave debris in the database. Those bags live for
 * as long as the page does.
 */
function isPersistent(randomizerId: string): boolean {
  return state.library.findById(randomizerId) !== null;
}

/** Read the bag for a randomizer into memory. Safe to call more than once. */
export async function bagLoad(randomizerId: string): Promise<void> {
  if (bags.has(randomizerId)) return;
  if (!isPersistent(randomizerId)) {
    bags.set(randomizerId, new Set());
    return;
  }
  const stored = await appdb.get<string[]>(bagKey(randomizerId));
  bags.set(randomizerId, new Set(Array.isArray(stored) ? stored : []));
}

export function bagDrawn(randomizerId: string): ReadonlySet<string> {
  return bags.get(randomizerId) ?? new Set<string>();
}

/** Take an outcome out of the bag. Called at the landing, not at the start. */
export function bagTake(randomizerId: string, itemId: string): void {
  const drawn = bags.get(randomizerId) ?? new Set<string>();
  drawn.add(itemId);
  bags.set(randomizerId, drawn);
  if (isPersistent(randomizerId)) void appdb.set(bagKey(randomizerId), [...drawn]);
}

/** Everything goes back in. */
export function bagRefill(randomizerId: string): void {
  bags.set(randomizerId, new Set());
  if (isPersistent(randomizerId)) void appdb.set(bagKey(randomizerId), []);
}
