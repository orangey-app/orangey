/**
 * Temporary cells on a board: a quick wheel or a dice expression put beside
 * the board's own randomizers for tonight, without editing the board.
 *
 * They are not part of the board — its file is what the owner assembled, and
 * a throwaway 3d20 should not end up in it or in a shared copy — so they live
 * in the app database, per board and per device, like a bag's draws (P19).
 * That is also what brings them back after a phone locks and reloads the tab.
 * "Save to library" is how one stops being temporary.
 */

import { appdb } from "../storage/appdb.ts";
import type { DiceRandomizer, ListRandomizer } from "../model/randomizer.ts";

/** A quick wheel or a dice expression; nothing else is made on a board. */
export type TempRandomizer = ListRandomizer | DiceRandomizer;

/**
 * How many a board may carry at once. The board's own limit is about its
 * file; this one only keeps a busy evening from turning into a wall of cells.
 */
export const BOARD_TEMP_LIMIT = 6;

function tempsKey(boardId: string): string {
  return `board-temp:${boardId}`;
}

/** Only what could have been written here: an old or damaged record is dropped, not trusted. */
function isTemp(v: unknown): v is TempRandomizer {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.name !== "string") return false;
  if (r.type === "dice") return typeof r.expression === "string";
  return r.type === "list" && Array.isArray(r.items);
}

export async function loadBoardTemps(boardId: string): Promise<TempRandomizer[]> {
  const stored = await appdb.get<unknown[]>(tempsKey(boardId));
  return Array.isArray(stored) ? stored.filter(isTemp).slice(0, BOARD_TEMP_LIMIT) : [];
}

export function saveBoardTemps(boardId: string, temps: readonly TempRandomizer[]): Promise<void> {
  return appdb.set(tempsKey(boardId), temps);
}
