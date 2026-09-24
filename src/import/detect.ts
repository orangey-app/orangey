/**
 * Guessing the shape of pasted or dropped data (plan C7).
 *
 * Delimiter: the one that gives the most consistent column count over the
 * first 50 non-empty lines, with a bonus for producing more than one column at
 * all. Header: the first row is a header when it contains nothing that parses
 * as a number while some later row does — the usual "Name,Weight" case.
 */

import { DELIMITERS, parseDelimited, type Delimiter } from "./parse.ts";

export interface Detection {
  delimiter: Delimiter;
  hasHeader: boolean;
  rows: string[][];
  /** How confident the delimiter guess is, 0..1; the UI shows the picker anyway. */
  confidence: number;
}

export function parseNumberLoose(s: string): number | null {
  const t = s.trim().replace(/%$/, "").replace(/\s/g, "");
  if (t === "") return null;
  // Accept both 1,5 and 1.5 when the string is unambiguous.
  const normalized = /^-?\d+,\d+$/.test(t) ? t.replace(",", ".") : t;
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(normalized)) return null;
  const n = Number.parseFloat(normalized);
  return Number.isFinite(n) ? n : null;
}

/**
 * A roll range, as a published table writes one: `01-65`, `66–85`, `00`.
 *
 * Returns how many rolls the range covers, which is the outcome's weight.
 * `00` is 100 on a d100, the way every table in print means it. Deliberately
 * not part of `parseNumberLoose`: that one also decides delimiters and
 * headers, and a hyphen must not start looking numeric there.
 */
export function parseRollRange(raw: string): number | null {
  const m = /^\s*(\d{1,3})\s*[-–—]\s*(\d{1,3})\s*$/.exec(raw);
  if (!m) return null;
  const end = (v: string) => (/^0+$/.test(v) ? 100 : Number.parseInt(v, 10));
  const lo = end(m[1]);
  const hi = end(m[2]);
  if (hi < lo) return null;
  return hi - lo + 1;
}

function score(rows: string[][]): { score: number; columns: number } {
  if (rows.length === 0) return { score: -1, columns: 0 };
  const counts = new Map<number, number>();
  for (const r of rows) counts.set(r.length, (counts.get(r.length) ?? 0) + 1);
  let columns = 1;
  let best = 0;
  for (const [n, c] of counts) {
    if (c > best || (c === best && n > columns)) {
      best = c;
      columns = n;
    }
  }
  const consistency = best / rows.length;
  if (columns < 2) return { score: consistency * 0.2, columns };
  return { score: consistency * (1 + Math.min(columns, 4) / 10), columns };
}

export function detect(text: string): Detection {
  let bestDelimiter: Delimiter = ",";
  let bestScore = -1;

  for (const d of DELIMITERS) {
    const rows = parseDelimited(text, d).slice(0, 50);
    const s = score(rows);
    if (s.score > bestScore) {
      bestScore = s.score;
      bestDelimiter = d;
    }
  }

  const rows = parseDelimited(text, bestDelimiter);
  return {
    delimiter: bestDelimiter,
    rows,
    hasHeader: guessHeader(rows),
    confidence: Math.max(0, Math.min(1, bestScore)),
  };
}

export function guessHeader(rows: string[][]): boolean {
  if (rows.length < 2) return false;
  const first = rows[0];
  const firstHasNumber = first.some((c) => parseNumberLoose(c) !== null);
  if (firstHasNumber) return false;
  const laterHasNumber = rows.slice(1, 20).some((r) => r.some((c) => parseNumberLoose(c) !== null));
  if (laterHasNumber) return true;
  // No numbers anywhere: treat a first row of short, distinct, title-ish cells
  // as a header only if it looks like one.
  return first.every((c) => c.length > 0 && c.length <= 24) && new Set(first).size === first.length && rows.length > 3
    ? /name|label|title|option|outcome|weight|chance|prob|desc/i.test(first.join(" "))
    : false;
}

const LABEL_HINTS = /^(name|label|title|option|outcome|entry|item|result|thing)s?$/i;
// `d100`, `d%` and `roll` are what a printed table calls its range column.
const WEIGHT_HINTS = /^(weight|probability|prob|chance|odds|likelihood|freq(uency)?|%|percent(age)?|share|d\d+|d%|roll|range)s?$/i;
const DESC_HINTS = /^(desc(ription)?|notes?|detail|details|comment|text)s?$/i;
const COLOR_HINTS = /^(colou?r|hex)$/i;

export interface ColumnGuess {
  label: number;
  weight: number | null;
  description: number | null;
  color: number | null;
}

/** Sensible defaults for the mapping step. */
export function guessColumns(rows: string[][], hasHeader: boolean): ColumnGuess {
  const width = Math.max(...rows.map((r) => r.length), 1);
  const header = hasHeader ? rows[0] : [];
  const body = hasHeader ? rows.slice(1) : rows;

  const find = (re: RegExp) => header.findIndex((h) => re.test(h.trim()));
  let label = find(LABEL_HINTS);
  let weight = find(WEIGHT_HINTS);
  let description = find(DESC_HINTS);
  const color = find(COLOR_HINTS);

  // A roll range counts as numeric here. `01-65` is not a number, but a
  // column of them is plainly not the labels either, and without this the
  // first column of a published d100 table gets taken for the outcome names.
  const numericShare = (col: number) => {
    const cells = body.map((r) => r[col] ?? "").filter((c) => c !== "");
    if (cells.length === 0) return 0;
    return cells.filter((c) => parseNumberLoose(c) !== null || parseRollRange(c) !== null).length / cells.length;
  };

  if (label < 0) {
    // The first mostly-non-numeric column is the label.
    label = 0;
    for (let c = 0; c < width; c++) {
      if (numericShare(c) < 0.5) {
        label = c;
        break;
      }
    }
  }
  if (weight < 0) {
    weight = -1;
    for (let c = 0; c < width; c++) {
      if (c !== label && numericShare(c) >= 0.8) {
        weight = c;
        break;
      }
    }
  }
  if (description < 0) {
    description = -1;
    for (let c = 0; c < width; c++) {
      if (c !== label && c !== weight && c !== color && numericShare(c) < 0.5) {
        description = c;
        break;
      }
    }
  }
  return {
    label,
    weight: weight >= 0 ? weight : null,
    description: description >= 0 ? description : null,
    color: color >= 0 ? color : null,
  };
}
