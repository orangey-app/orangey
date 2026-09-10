/**
 * Rebuild the wheel's segment pool from the PALETTE array.
 *
 * Drops anything too pale, too dark, too grey, or within 0.05 (OKLab) of a
 * colour already kept, then orders the rest so consecutive entries are far
 * apart. Rewrites the SEGMENT_POOL name list in palette.ts.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, "src/ui/styles/palette.ts");
const { PALETTE } = await import(target);
const { hexToOklab, chroma, deltaE, labelFor } = await import(join(root, "src/core/color.ts"));

const candidates = PALETTE.map((c) => ({ ...c, lab: hexToOklab(c.hex), ch: chroma(hexToOklab(c.hex)) }))
  .filter((c) => c.ch >= 0.025 && labelFor(c.hex).nudges <= 6 && c.lab.L >= 0.28 && c.lab.L <= 0.78);

const kept = [];
for (const c of candidates) if (kept.every((k) => deltaE(k.lab, c.lab) >= 0.05)) kept.push(c);

const order = [];
const rest = [...kept];
order.push(rest.splice(rest.indexOf(rest.reduce((a, b) => (a.ch > b.ch ? a : b))), 1)[0]);
while (rest.length) {
  let best = 0;
  let bestScore = -1;
  rest.forEach((x, i) => {
    const prev = order[order.length - 1];
    const prev2 = order[order.length - 2];
    const score = deltaE(prev.lab, x.lab) + 0.3 * (prev2 ? deltaE(prev2.lab, x.lab) : 0);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  order.push(rest.splice(best, 1)[0]);
}

const file = readFileSync(target, "utf8");
const start = file.indexOf("export const SEGMENT_POOL: PaletteColor[] = [");
const endMarker = "].map(byName).filter(isColor);";
const end = file.indexOf(endMarker, start) + endMarker.length;
if (start < 0 || end < start) {
  console.error("could not find SEGMENT_POOL in palette.ts");
  process.exit(1);
}
const lines = [];
for (let i = 0; i < order.length; i += 4) {
  lines.push(`  ${order.slice(i, i + 4).map((c) => JSON.stringify(c.name)).join(", ")},`);
}
const replacement = `export const SEGMENT_POOL: PaletteColor[] = [\n${lines.join("\n")}\n].map(byName).filter(isColor);`;
writeFileSync(target, file.slice(0, start) + replacement + file.slice(end));
console.log(`segment pool: ${order.length} of ${PALETTE.length} colours`);
