/**
 * The Orangey colour palette: the 157 distinct colours of the dictionary
 * (two of the 159 share a hex with another and are folded in), imported with
 * `scripts/import-palette.mjs` from the owner's data file. Names are the
 * dictionary's own.
 *
 * SEGMENT_POOL — the colours the wheel draws from — is derived from PALETTE
 * by `scripts/curate-palette.mjs`; the tests re-verify contrast and neighbour
 * distinctness, so replacing the palette cannot silently degrade the wheel.
 */

import { chroma, deltaE, hexToOklab, labelFor, type Oklab } from "../../core/color.ts";

export interface PaletteColor {
  name: string;
  hex: string;
}

// --- palette:begin (rewritten by `node scripts/import-palette.mjs <file>`)
export const PALETTE: PaletteColor[] = [
  { name: "Hermosa Pink", hex: "#ffb3f0" },
  { name: "Corinthian Pink", hex: "#ffa6d9" },
  { name: "Cameo Pink", hex: "#e6adcf" },
  { name: "Fawn", hex: "#d1b0b3" },
  { name: "Light Brown Drab", hex: "#b08699" },
  { name: "Coral Red", hex: "#ff7399" },
  { name: "Fresh Color", hex: "#ff788c" },
  { name: "Grenadine Pink", hex: "#ff616b" },
  { name: "Eosine Pink", hex: "#ff5ec4" },
  { name: "Spinel Red", hex: "#ff4dc9" },
  { name: "Old Rose", hex: "#d94d99" },
  { name: "Eugenia Red | A", hex: "#ed3d66" },
  { name: "Eugenia Red | B", hex: "#e62e73" },
  { name: "Raw Sienna", hex: "#b85e00" },
  { name: "Vinaceous Tawny", hex: "#c74300" },
  { name: "Jasper Red", hex: "#fa2b00" },
  { name: "Spectrum Red", hex: "#f20000" },
  { name: "Red Orange", hex: "#e81900" },
  { name: "Etruscan Red", hex: "#c9303e" },
  { name: "Burnt Sienna", hex: "#a93400" },
  { name: "Ochre Red", hex: "#a7374b" },
  { name: "Scarlet", hex: "#d50c42" },
  { name: "Carmine", hex: "#d60036" },
  { name: "Indian Lake", hex: "#cc1a97" },
  { name: "Rosolanc Purple", hex: "#b319ab" },
  { name: "Pomegranite Purple", hex: "#b90078" },
  { name: "Hydrangea Red", hex: "#9e194d" },
  { name: "Brick Red", hex: "#a32100" },
  { name: "Carmine Red", hex: "#a10b2b" },
  { name: "Pompeian Red", hex: "#a90636" },
  { name: "Red", hex: "#a10045" },
  { name: "Brown", hex: "#6c2b11" },
  { name: "Hay's Russet", hex: "#681916" },
  { name: "Vandyke Red", hex: "#740909" },
  { name: "Pansy Purple", hex: "#6f0043" },
  { name: "Pale Burnt Lake", hex: "#730f1f" },
  { name: "Violet Red", hex: "#3d0079" },
  { name: "Vistoris Lake", hex: "#5c2c45" },
  { name: "Sulpher Yellow", hex: "#f5f5b8" },
  { name: "Pale Lemon Yellow", hex: "#fff59e" },
  { name: "Naples Yellow", hex: "#faed8f" },
  { name: "Ivory Buff", hex: "#ebd999" },
  { name: "Seashell Pink", hex: "#ffcfc4" },
  { name: "Light Pinkish Cinnamon", hex: "#ffbf99" },
  { name: "Pinkish Cinnamon", hex: "#f2ad78" },
  { name: "Cinnamon Buff", hex: "#ffbf6e" },
  { name: "Cream Yellow", hex: "#ffb852" },
  { name: "Golden Yellow", hex: "#fa9442" },
  { name: "Vinaceous Cinnamon", hex: "#f59994" },
  { name: "Ochraceous Salmon", hex: "#d99e73" },
  { name: "Isabella Color", hex: "#c3a55c" },
  { name: "Maple", hex: "#c2975a" },
  { name: "Olive Buff", hex: "#bcd382" },
  { name: "Ecru", hex: "#c0b490" },
  { name: "Yellow", hex: "#ffff00" },
  { name: "Lemon Yellow", hex: "#f2ff26" },
  { name: "Apricot Yellow", hex: "#ffe600" },
  { name: "Pyrite Yellow", hex: "#c4bf33" },
  { name: "Olive Ocher", hex: "#d1bd19" },
  { name: "Yellow Ocher", hex: "#e0b81f" },
  { name: "Orange Yellow", hex: "#ffab00" },
  { name: "Yellow Orange", hex: "#ff8c00" },
  { name: "Apricot Orange", hex: "#ff7340" },
  { name: "Orange", hex: "#ff5200" },
  { name: "Peach Red", hex: "#ff3319" },
  { name: "English Red", hex: "#de4500" },
  { name: "Cinnamon Rufous", hex: "#c2612c" },
  { name: "Orange Rufous", hex: "#c05200" },
  { name: "Sulphine Yellow", hex: "#baa600" },
  { name: "Khaki", hex: "#b68400" },
  { name: "Citron Yellow", hex: "#a6d40d" },
  { name: "Buffy Citrine", hex: "#888d2a" },
  { name: "Dark Citrine", hex: "#7e8743" },
  { name: "Light Grayish Olive", hex: "#76844e" },
  { name: "Krongbergs Green", hex: "#759243" },
  { name: "Olive", hex: "#718600" },
  { name: "Orange Citrine", hex: "#8c6510" },
  { name: "Sudan Brown", hex: "#9b5348" },
  { name: "Olive Green", hex: "#58771e" },
  { name: "Light Brownish Olive", hex: "#706934" },
  { name: "Deep Grayish Olive", hex: "#505423" },
  { name: "Pale Raw Umber", hex: "#5e4017" },
  { name: "Sepia", hex: "#503d00" },
  { name: "Madder Brown", hex: "#651300" },
  { name: "Mars Brown / Tobacco", hex: "#522000" },
  { name: "Vandyke Brown", hex: "#362304" },
  { name: "Turquoise Green", hex: "#b5ffc2" },
  { name: "Glaucous Green", hex: "#b3e8c2" },
  { name: "Dark Greenish Glaucous", hex: "#b3d9a3" },
  { name: "Yellow Green", hex: "#a6ff47" },
  { name: "Light Green Yellow", hex: "#bdf226" },
  { name: "Night Green", hex: "#7aff00" },
  { name: "Olive Yellow", hex: "#99b333" },
  { name: "Artemesia Green", hex: "#65a98f" },
  { name: "Andover Green", hex: "#5c8a73" },
  { name: "Rainette Green", hex: "#85b857" },
  { name: "Pistachio Green", hex: "#56aa69" },
  { name: "Sea Green", hex: "#33ff7d" },
  { name: "Benzol Green", hex: "#00d973" },
  { name: "Light Porcelain Green", hex: "#23c17c" },
  { name: "Green", hex: "#40c945" },
  { name: "Dull Viridian Green", hex: "#19cc33" },
  { name: "Oil Green", hex: "#6ea900" },
  { name: "Diamine Green", hex: "#1b8e13" },
  { name: "Cossack Green", hex: "#328e13" },
  { name: "Lincoln Green", hex: "#405416" },
  { name: "Blackish Olive", hex: "#324e2a" },
  { name: "Deep Slate Olive", hex: "#172713" },
  { name: "Nile Blue", hex: "#bfffe6" },
  { name: "Pale King's Blue", hex: "#abf5ed" },
  { name: "Light Glaucous Blue", hex: "#a6e6db" },
  { name: "Salvia Blue", hex: "#96bfe6" },
  { name: "Cobalt Green", hex: "#94ff94" },
  { name: "Calamine BLue", hex: "#80ffcc" },
  { name: "Venice Green", hex: "#6bffb3" },
  { name: "Cerulian Blue", hex: "#29bdad" },
  { name: "Peacock Blue", hex: "#00cf91" },
  { name: "Green Blue", hex: "#2dbc94" },
  { name: "Olympic Blue", hex: "#4f8fe6" },
  { name: "Blue", hex: "#0d75ff" },
  { name: "Antwarp Blue", hex: "#008aa1" },
  { name: "Helvetia Blue", hex: "#0057ba" },
  { name: "Dark Medici Blue", hex: "#417777" },
  { name: "Dusky Green", hex: "#00592e" },
  { name: "Deep Lyons Blue", hex: "#0024cc" },
  { name: "Violet Blue", hex: "#202d85" },
  { name: "Vandar Poel's Blue", hex: "#003e83" },
  { name: "Dark Tyrian Blue", hex: "#0d2b52" },
  { name: "Dull Violet Black", hex: "#06004f" },
  { name: "Deep Indigo", hex: "#000831" },
  { name: "Deep Slate Green", hex: "#0f261f" },
  { name: "Grayish Lavender - A", hex: "#b8b8ff" },
  { name: "Grayish Lavender - B", hex: "#bfabcc" },
  { name: "Laelia Pink", hex: "#cc85d1" },
  { name: "Lilac", hex: "#b875eb" },
  { name: "Eupatorium Purple", hex: "#bf36e0" },
  { name: "Light Mauve", hex: "#9161f2" },
  { name: "Aconite Violet", hex: "#9c52f2" },
  { name: "Dull Blue Violet", hex: "#6e66d4" },
  { name: "Dark Soft Violet", hex: "#4d52de" },
  { name: "Blue Violet", hex: "#4733ff" },
  { name: "Purple Drab", hex: "#754260" },
  { name: "Deep Violet / Plumbeous", hex: "#5c7287" },
  { name: "Veronia Purple", hex: "#7e3075" },
  { name: "Dark Slate Purple", hex: "#53225c" },
  { name: "Taupe Brown", hex: "#6b2e63" },
  { name: "Violet Carmine", hex: "#531745" },
  { name: "Violet", hex: "#2619d1" },
  { name: "Red Violet", hex: "#3400a3" },
  { name: "Cotinga Purple", hex: "#340059" },
  { name: "Dusky Madder Violet", hex: "#2d0060" },
  { name: "White", hex: "#ffffff" },
  { name: "Neutral Gray", hex: "#b5d1cc" },
  { name: "Mineral Gray", hex: "#9fc2b2" },
  { name: "Warm Gray", hex: "#9cb29e" },
  { name: "Slate Color", hex: "#1b3644" },
  { name: "Black", hex: "#000000" },
];
// --- palette:end

/** The app accent: one warm colour for buttons, focus rings, the wheel pointer. */
export const ACCENT: PaletteColor = { name: "Orangey orange", hex: "#f3a257" };

/**
 * Look a pool entry up by name. A name that is no longer in the palette — the
 * palette has just been replaced and the pool not yet rebuilt — is skipped
 * rather than fatal, so `scripts/curate-palette.mjs` can load the module and
 * rebuild the pool.
 */
const byName = (n: string): PaletteColor | null => PALETTE.find((p) => p.name === n) ?? null;
const isColor = (c: PaletteColor | null): c is PaletteColor => c !== null;

/**
 * The ordered pool the wheel draws from.
 *
 * Derived from PALETTE by `scripts/curate-palette.mjs`, which drops anything
 * too pale, too dark, too grey or too close to a colour already kept, then
 * orders what remains so that consecutive entries are far apart — the assigner
 * usually gets a good colour on its first try that way.
 *
 * Curation rules (re-verified by tests/unit/palette.test.ts, so replacing
 * PALETTE cannot silently degrade the wheel):
 *   - every entry carries a 4.5:1 label with at most 6 lightness nudges
 *   - lightness within 0.28..0.78, chroma at least 0.025
 *   - no two entries closer than 0.05 in OKLab
 */
export const SEGMENT_POOL: PaletteColor[] = [
  "Blue Violet", "Benzol Green", "Violet Red", "Golden Yellow",
  "Deep Lyons Blue", "Green", "Pansy Purple", "Vinaceous Cinnamon",
  "Dark Tyrian Blue", "Olive Yellow", "Red Violet", "Orange",
  "Blue", "Mars Brown / Tobacco", "Ecru", "Violet Blue",
  "Apricot Orange", "Slate Color", "Eosine Pink", "Diamine Green",
  "Eupatorium Purple", "Light Porcelain Green", "Vandyke Red", "Grayish Lavender - B",
  "Dark Slate Purple", "Oil Green", "Rosolanc Purple", "Dusky Green",
  "Coral Red", "Helvetia Blue", "Sulphine Yellow", "Vistoris Lake",
  "Cerulian Blue", "Jasper Red", "Dark Soft Violet", "Isabella Color",
  "Brown", "Lilac", "Pistachio Green", "Pomegranite Purple",
  "Warm Gray", "Pale Raw Umber", "Light Mauve", "Khaki",
  "Veronia Purple", "Ochraceous Salmon", "Deep Grayish Olive", "Indian Lake",
  "Artemesia Green", "Hydrangea Red", "Olympic Blue", "Grenadine Pink",
  "Olive Green", "Dull Blue Violet", "Eugenia Red | A", "Antwarp Blue",
  "Burnt Sienna", "Laelia Pink", "Buffy Citrine", "Purple Drab",
  "Old Rose", "Andover Green", "Etruscan Red", "Dark Medici Blue",
  "Vinaceous Tawny", "Light Brown Drab", "Ochre Red", "Light Grayish Olive",
  "Raw Sienna", "Sudan Brown", "Orange Citrine",
].map(byName).filter(isColor);

export interface PoolColor extends PaletteColor {
  oklab: Oklab;
  chroma: number;
}

let cachedPool: PoolColor[] | null = null;

export function pool(): PoolColor[] {
  if (!cachedPool) {
    cachedPool = SEGMENT_POOL.map((c) => {
      const oklab = hexToOklab(c.hex);
      return { ...c, oklab, chroma: chroma(oklab) };
    });
  }
  return cachedPool;
}

/** Curation report, used by the test and by `npm run check`. */
export function curate(minDistance = 0.05): { problems: string[]; closestPair: number } {
  const problems: string[] = [];
  const p = pool();
  let closest = Infinity;
  for (let i = 0; i < p.length; i++) {
    const label = labelFor(p[i].hex);
    if (p[i].oklab.L < 0.28 || p[i].oklab.L > 0.78) problems.push(`${p[i].name} is outside the segment lightness band`);
    if (label.nudges > 6) problems.push(`${p[i].name} cannot carry a 4.5:1 label`);
    if (p[i].chroma < 0.025) problems.push(`${p[i].name} is too close to grey for a segment`);
    for (let j = i + 1; j < p.length; j++) {
      const d = deltaE(p[i].oklab, p[j].oklab);
      if (d < closest) closest = d;
      if (d < minDistance) problems.push(`${p[i].name} and ${p[j].name} are only ${d.toFixed(3)} apart`);
    }
  }
  return { problems, closestPair: closest };
}
