/**
 * Replace the colour palette from a data file.
 *
 *   node scripts/import-palette.mjs path/to/colors.json
 *
 * Accepts the common shapes such a file comes in:
 *   - an array of { name, hex }                       (most datasets)
 *   - an array of { name, color } or { title, hex }
 *   - an object whose values are such entries
 *   - a CSV/TSV with a name column and a hex column
 *
 * It rewrites the PALETTE array in src/ui/styles/palette.ts between the
 * palette:begin / palette:end markers and nothing else; the curated segment
 * pool and the tests are derived from PALETTE, so they follow automatically.
 * Run `npm test` afterwards: the palette tests re-verify contrast and
 * neighbour distinctness against the new colours.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, "src/ui/styles/palette.ts");
const source = process.argv[2];
if (!source) {
  console.error("usage: node scripts/import-palette.mjs <colors.json|colors.csv>");
  process.exit(2);
}

const text = readFileSync(resolve(source), "utf8");
const HEX = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i;

function normaliseHex(v) {
  const m = String(v ?? "").trim().match(HEX);
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  return `#${h.toLowerCase()}`;
}

function fromEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const name = entry.name ?? entry.title ?? entry.label ?? entry.colorName;
  const hex = normaliseHex(entry.hex ?? entry.color ?? entry.value ?? entry.rgb);
  if (typeof name !== "string" || !hex) return null;
  return { name: name.trim(), hex };
}

let colours = [];
const trimmed = text.trim();
if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
  const doc = JSON.parse(trimmed);
  // { colors: [...] } is the shape the dictionary dataset comes in.
  const inner = !Array.isArray(doc) && Array.isArray(doc.colors) ? doc.colors : doc;
  const list = Array.isArray(inner) ? inner : Object.values(inner);
  colours = list.map(fromEntry).filter(Boolean);
} else {
  const delimiter = trimmed.includes("\t") ? "\t" : ",";
  const rows = trimmed.split(/\r?\n/).map((l) => l.split(delimiter).map((c) => c.trim().replace(/^"|"$/g, "")));
  const header = rows[0].map((c) => c.toLowerCase());
  const nameAt = header.findIndex((c) => /name|title|label/.test(c));
  const hexAt = header.findIndex((c) => /hex|colou?r|value/.test(c));
  const body = nameAt >= 0 && hexAt >= 0 ? rows.slice(1) : rows;
  const n = nameAt >= 0 ? nameAt : 0;
  const x = hexAt >= 0 ? hexAt : 1;
  colours = body.map((r) => ({ name: r[n], hex: normaliseHex(r[x]) })).filter((c) => c.name && c.hex);
}

// Drop exact duplicates, keep first occurrence; make names unique.
const seen = new Set();
const names = new Set();
colours = colours.filter((c) => {
  if (seen.has(c.hex)) return false;
  seen.add(c.hex);
  let name = c.name;
  let n = 2;
  while (names.has(name)) name = `${c.name} ${n++}`;
  names.add(name);
  c.name = name;
  return true;
});

if (colours.length < 8) {
  console.error(`only ${colours.length} usable colours found in ${source}; expected a full palette`);
  process.exit(1);
}

const file = readFileSync(target, "utf8");
const begin = file.indexOf("// --- palette:begin");
const end = file.indexOf("// --- palette:end");
if (begin < 0 || end < 0) {
  console.error("palette.ts is missing the palette:begin / palette:end markers");
  process.exit(1);
}
const beginLineEnd = file.indexOf("\n", begin) + 1;
const body = colours.map((c) => `  { name: ${JSON.stringify(c.name)}, hex: "${c.hex}" },`).join("\n");
const replacement = `export const PALETTE: PaletteColor[] = [\n${body}\n];\n`;
writeFileSync(target, file.slice(0, beginLineEnd) + replacement + file.slice(end));
console.log(`wrote ${colours.length} colours to src/ui/styles/palette.ts`);
console.log("next: node scripts/curate-palette.mjs  (rebuilds the segment pool), then npm test");
