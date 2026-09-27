/**
 * A list of outcomes as CSV, so a table can be edited in a spreadsheet and
 * imported back. The columns are the ones the import wizard recognises by
 * name, so the round trip needs no mapping step.
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
