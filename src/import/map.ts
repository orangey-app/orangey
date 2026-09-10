/**
 * Turning detected rows into outcomes, with a report the user reads before
 * anything is created (plan C7).
 *
 * Errors skip a row rather than abandoning the import: one bad weight in a
 * forty-row encounter table should not send you back to the spreadsheet.
 */

import { makeItem, type ListItem } from "../model/randomizer.ts";
import { isHex } from "../core/color.ts";
import { parseNumberLoose } from "./detect.ts";

export interface Mapping {
  label: number;
  weight: number | null;
  description: number | null;
  color: number | null;
  /** Put every unmapped column into item.metadata, keyed by header name. */
  extrasToMetadata: boolean;
}

export type ReportLevel = "ok" | "warn" | "error";

export interface ReportLine {
  level: ReportLevel;
  text: string;
}

export interface ImportResult {
  items: ListItem[];
  report: ReportLine[];
  /** True when there is something worth creating. */
  usable: boolean;
}

const MARK: Record<ReportLevel, string> = { ok: "✓", warn: "⚠", error: "✗" };

export function renderReport(report: readonly ReportLine[]): string {
  return report.map((l) => `${MARK[l.level]} ${l.text}`).join("\n");
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function buildItems(rows: string[][], hasHeader: boolean, mapping: Mapping): ImportResult {
  const header = hasHeader ? rows[0] : [];
  const body = hasHeader ? rows.slice(1) : rows;
  const rowNumber = (i: number) => i + 1 + (hasHeader ? 1 : 0);

  const items: ListItem[] = [];
  /** Source row number for each produced item, for accurate reporting. */
  const sourceRows: number[] = [];
  const badWeights: string[] = [];
  const emptyLabels: number[] = [];
  const badColors: number[] = [];
  let missingDescriptions = 0;
  let defaultedWeights = 0;

  body.forEach((row, i) => {
    const label = (row[mapping.label] ?? "").trim();
    if (label === "") {
      emptyLabels.push(rowNumber(i));
      return;
    }

    let weight = 1;
    if (mapping.weight !== null) {
      const raw = (row[mapping.weight] ?? "").trim();
      if (raw === "") {
        defaultedWeights++;
      } else {
        const n = parseNumberLoose(raw);
        if (n === null || n < 0) {
          badWeights.push(`row ${rowNumber(i)} "${raw}"`);
          return;
        }
        weight = n;
      }
    }

    const extra: Partial<ListItem> = {};
    if (mapping.description !== null) {
      const d = (row[mapping.description] ?? "").trim();
      if (d) extra.description = d;
      else missingDescriptions++;
    }
    if (mapping.color !== null) {
      const c = (row[mapping.color] ?? "").trim();
      if (c) {
        if (isHex(c)) extra.color = c.startsWith("#") ? c : `#${c}`;
        else badColors.push(rowNumber(i));
      }
    }
    if (mapping.extrasToMetadata) {
      const used = new Set([mapping.label, mapping.weight, mapping.description, mapping.color]);
      const metadata: Record<string, string> = {};
      row.forEach((cell, c) => {
        if (used.has(c) || !cell.trim()) return;
        metadata[(header[c] ?? `column ${c + 1}`).trim() || `column ${c + 1}`] = cell.trim();
      });
      if (Object.keys(metadata).length) extra.metadata = metadata;
    }

    items.push(makeItem(label, weight, extra));
    sourceRows.push(rowNumber(i));
  });

  const report: ReportLine[] = [];
  report.push({ level: items.length ? "ok" : "error", text: `${plural(items.length, "entry", "entries")} ready` });

  const total = items.reduce((a, it) => a + it.weight, 0);
  if (items.length) {
    report.push({ level: "ok", text: `Weights valid (total ${round(total)})` });
  }
  if (defaultedWeights) {
    report.push({ level: "warn", text: `${plural(defaultedWeights, "entry", "entries")} had no weight — using 1` });
  }
  if (missingDescriptions) {
    report.push({
      level: "warn",
      text: `${plural(missingDescriptions, "entry", "entries")} ${missingDescriptions === 1 ? "has" : "have"} no description`,
    });
  }

  // Duplicate labels are kept: a table may legitimately list the same
  // encounter twice to double its chance.
  const byLabel = new Map<string, number[]>();
  items.forEach((it, i) => {
    const key = it.label.toLowerCase();
    byLabel.set(key, [...(byLabel.get(key) ?? []), sourceRows[i]]);
  });
  const dupes = [...byLabel.entries()].filter(([, r]) => r.length > 1);
  for (const [key, rowsFor] of dupes.slice(0, 3)) {
    const label = items.find((it) => it.label.toLowerCase() === key)!.label;
    report.push({
      level: "warn",
      text: `${plural(rowsFor.length - 1, "duplicate label")}: "${label}" (rows ${rowsFor.join(", ")}) — kept ${rowsFor.length === 2 ? "both" : "all"}`,
    });
  }
  if (dupes.length > 3) report.push({ level: "warn", text: `and ${dupes.length - 3} more duplicated labels — all kept` });

  if (badColors.length) {
    report.push({
      level: "warn",
      text: `${plural(badColors.length, "entry", "entries")} had an unreadable colour (${rowList(badColors)}) — using automatic colours`,
    });
  }
  if (emptyLabels.length) {
    report.push({ level: "error", text: `${plural(emptyLabels.length, "row")} had no label (${rowList(emptyLabels)}) — skipped` });
  }
  if (badWeights.length) {
    report.push({
      level: "error",
      text: `${plural(badWeights.length, "entry", "entries")} ${badWeights.length === 1 ? "has" : "have"} an invalid weight: ${badWeights.slice(0, 3).join(", ")} — will be skipped`,
    });
  }
  if (!items.length) report.push({ level: "error", text: "Nothing to import from this data" });

  return { items, report, usable: items.length > 0 };
}

function rowList(rows: number[]): string {
  const shown = rows.slice(0, 5).join(", ");
  const more = rows.length > 5 ? `, and ${rows.length - 5} more` : "";
  return `${rows.length === 1 ? "row" : "rows"} ${shown}${more}`;
}

function round(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

/** Accept a pasted JSON array or {items:[...]} as well as a table. */
export function itemsFromJson(text: string): ImportResult {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return { items: [], report: [{ level: "error", text: `Not valid JSON (${(e as Error).message})` }], usable: false };
  }
  const raw = Array.isArray(doc)
    ? doc
    : typeof doc === "object" && doc !== null && Array.isArray((doc as Record<string, unknown>).items)
      ? ((doc as Record<string, unknown>).items as unknown[])
      : null;
  if (!raw) {
    return { items: [], report: [{ level: "error", text: "Expected a list of outcomes, or an object with an items list" }], usable: false };
  }
  const items: ListItem[] = [];
  let skipped = 0;
  for (const entry of raw) {
    if (typeof entry === "string") {
      items.push(makeItem(entry, 1));
      continue;
    }
    if (typeof entry !== "object" || entry === null) {
      skipped++;
      continue;
    }
    const o = entry as Record<string, unknown>;
    const label = typeof o.label === "string" ? o.label : typeof o.name === "string" ? o.name : null;
    if (!label) {
      skipped++;
      continue;
    }
    const weight = typeof o.weight === "number" && Number.isFinite(o.weight) && o.weight >= 0 ? o.weight : 1;
    const extra: Partial<ListItem> = {};
    if (typeof o.description === "string") extra.description = o.description;
    if (typeof o.color === "string" && isHex(o.color)) extra.color = o.color;
    if (o.disabled === true) extra.disabled = true;
    items.push(makeItem(label, weight, extra));
  }
  const report: ReportLine[] = [
    { level: items.length ? "ok" : "error", text: `${plural(items.length, "entry", "entries")} ready` },
  ];
  if (skipped) report.push({ level: "error", text: `${plural(skipped, "entry", "entries")} had no label — skipped` });
  return { items, report, usable: items.length > 0 };
}
