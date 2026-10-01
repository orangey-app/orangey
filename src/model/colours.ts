/**
 * Colours the user adds to the palette. Kept apart from the settings file so
 * that the app database, which stores them, does not depend on that file: it
 * is the one model file allowed to reach into src/ui (see scripts/check.mjs).
 */

import { isHex } from "../core/color.ts";

/** A colour the user added to the palette. */
export interface CustomColour {
  name: string;
  hex: string;
}

export const MAX_CUSTOM_COLOURS = 64;
export const MAX_COLOUR_NAME = 40;

/** Keep only well-formed colours, lower-case hex, no duplicates, capped. */
export function normalizeColours(raw: unknown): CustomColour[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomColour[] = [];
  const seen = new Set<string>();
  for (const c of raw) {
    if (typeof c !== "object" || c === null) continue;
    const { name, hex } = c as Record<string, unknown>;
    if (typeof name !== "string" || !name.trim() || !isHex(hex)) continue;
    const h = (hex.startsWith("#") ? hex : `#${hex}`).toLowerCase();
    if (seen.has(h)) continue;
    seen.add(h);
    out.push({ name: name.trim().slice(0, MAX_COLOUR_NAME), hex: h });
    if (out.length >= MAX_CUSTOM_COLOURS) break;
  }
  return out;
}
