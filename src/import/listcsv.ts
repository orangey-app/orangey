/**
 * A list of outcomes as a spreadsheet.
 *
 * The importer has always been able to read a CSV; this is the other
 * direction, so a table can be taken out to a spreadsheet, edited by
 * whatever the group already uses, and brought back. The columns are exactly
 * the ones the import wizard recognises by name, so the round trip needs no
 * mapping step at all.
 */

import type { ListItem } from "../model/randomizer.ts";

/** One cell, quoted only when it has to be. */
export function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function listCsv(items: readonly ListItem[]): string {
  const rows = [
    ["label", "weight", "description", "color"],
    ...items.map((i) => [i.label, String(i.weight), i.description ?? "", i.color ?? ""]),
  ];
  return rows.map((r) => r.map(csvCell).join(",")).join("\n");
}
