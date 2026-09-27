/**
 * Temporary cells on a board: a quick wheel or a dice expression added for one
 * session without editing the board.
 *
 * They are per device, like a bag's draws: kept in the app database, never in
 * the board's file, which also brings them back after a phone reloads the tab.
 */

import { appdb } from "../storage/appdb.ts";
import type { DiceRandomizer, ListRandomizer } from "../model/randomizer.ts";

export type TempRandomizer = ListRandomizer | DiceRandomizer;

/** At most this many at once, so a board does not become a wall of cells. */
export const BOARD_TEMP_LIMIT = 6;

function tempsKey(boardId: string): string {
  return `board-temp:${boardId}`;
}

/** Accepts only what this module writes; an old or damaged record is dropped. */
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
