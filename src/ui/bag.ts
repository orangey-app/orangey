/**
 * Bag mode: which outcomes have already been drawn.
 *
 * What has been drawn is per device, like history: it lives in the app database,
 * keyed by randomizer id, never in the randomizer file, with an in-memory copy
 * the roll path can read synchronously.
 */

import { appdb } from "../storage/appdb.ts";
import { state } from "./state.ts";

const bags = new Map<string, Set<string>>();

function bagKey(randomizerId: string): string {
  return `bag:${randomizerId}`;
}

/**
 * A randomizer from a link has no file and gets fresh item ids on every load,
 * so its bag is never stored and lasts only as long as the page.
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

/** Take an outcome out of the bag. Call at the landing, not at the start. */
export function bagTake(randomizerId: string, itemId: string): void {
  const drawn = bags.get(randomizerId) ?? new Set<string>();
  drawn.add(itemId);
  bags.set(randomizerId, drawn);
  if (isPersistent(randomizerId)) void appdb.set(bagKey(randomizerId), [...drawn]);
}

export function bagRefill(randomizerId: string): void {
  bags.set(randomizerId, new Set());
  if (isPersistent(randomizerId)) void appdb.set(bagKey(randomizerId), []);
}
