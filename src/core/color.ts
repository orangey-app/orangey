/**
 * Colour maths: sRGB <-> OKLab, perceptual distance, WCAG contrast, and a
 * deuteranopia simulation. Everything the palette work in C8 needs, in one
 * dependency-free module.
 */

export type RGB = { r: number; g: number; b: number }; // 0..1
export type Oklab = { L: number; a: number; b: number };

export function hexToRgb(hex: string): RGB {
  const h = hex.trim().replace(/^#/, "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`not a colour: ${hex}`);
  return {
    r: Number.parseInt(full.slice(0, 2), 16) / 255,
    g: Number.parseInt(full.slice(2, 4), 16) / 255,
    b: Number.parseInt(full.slice(4, 6), 16) / 255,
  };
}

export function rgbToHex({ r, g, b }: RGB): string {
  const c = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function isHex(s: unknown): s is string {
  return typeof s === "string" && /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s.trim());
}

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toGamma = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

export function linearize({ r, g, b }: RGB): RGB {
  return { r: toLinear(r), g: toLinear(g), b: toLinear(b) };
}
export function delinearize({ r, g, b }: RGB): RGB {
  return { r: toGamma(r), g: toGamma(g), b: toGamma(b) };
}

/** Björn Ottosson's OKLab. Perceptually uniform enough for "do these clash". */
export function rgbToOklab(rgb: RGB): Oklab {
  const { r, g, b } = linearize(rgb);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

export function oklabToRgb({ L, a, b }: Oklab): RGB {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return delinearize({
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  });
}

export const hexToOklab = (hex: string): Oklab => rgbToOklab(hexToRgb(hex));

/** Euclidean distance in OKLab. Roughly: 0.02 is "just noticeable". */
export function deltaE(a: Oklab, b: Oklab): number {
  return Math.hypot(a.L - b.L, a.a - b.a, a.b - b.b);
}

export function chroma({ a, b }: Oklab): number {
  return Math.hypot(a, b);
}

/** Hue angle in degrees, 0..360. */
export function hueAngle({ a, b }: Oklab): number {
  const deg = (Math.atan2(b, a) * 180) / Math.PI;
  return deg < 0 ? deg + 360 : deg;
}

export function hueDifference(a: Oklab, b: Oklab): number {
  const d = Math.abs(hueAngle(a) - hueAngle(b)) % 360;
  return d > 180 ? 360 - d : d;
}

/** Viénot's linear-RGB approximation of deuteranopia. Good enough to catch
 *  the red/green pairs that a wheel must not put side by side. */
export function simulateDeuteranopia(rgb: RGB): RGB {
  const { r, g, b } = linearize(rgb);
  return delinearize({
    r: 0.625 * r + 0.375 * g,
    g: 0.7 * r + 0.3 * g,
    b: 0.3 * g + 0.7 * b,
  });
}

function relativeLuminance(rgb: RGB): number {
  const { r, g, b } = linearize(rgb);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.1 contrast ratio, 1..21. */
export function contrastRatio(a: RGB, b: RGB): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const WHITE: RGB = { r: 1, g: 1, b: 1 };
const BLACK: RGB = { r: 0, g: 0, b: 0 };

export interface LabelChoice {
  /** The colour to draw the label in. */
  ink: "#ffffff" | "#000000";
  /** The fill to use, possibly nudged in lightness to reach the target. */
  fill: string;
  ratio: number;
  /** How many lightness nudges were needed; 0 means the fill was fine as-is. */
  nudges: number;
}

/**
 * Choose black or white label ink for a fill, nudging the fill's lightness in
 * small steps if neither reaches the target ratio. A pool colour that still
 * fails after `maxNudges` is a curation bug and the build test says so.
 */
export function labelFor(fillHex: string, target = 4.5, maxNudges = 6): LabelChoice {
  let fill = fillHex;
  for (let n = 0; n <= maxNudges; n++) {
    const rgb = hexToRgb(fill);
    const onWhite = contrastRatio(rgb, WHITE);
    const onBlack = contrastRatio(rgb, BLACK);
    const useWhite = onWhite >= onBlack;
    const ratio = useWhite ? onWhite : onBlack;
    if (ratio >= target) {
      return { ink: useWhite ? "#ffffff" : "#000000", fill, ratio, nudges: n };
    }
    // Push away from mid-grey: darker if white ink is winning, lighter if black.
    const lab = rgbToOklab(rgb);
    lab.L = Math.min(1, Math.max(0, lab.L + (useWhite ? -0.02 : 0.02)));
    fill = rgbToHex(oklabToRgb(lab));
  }
  const rgb = hexToRgb(fill);
  const onWhite = contrastRatio(rgb, WHITE);
  const onBlack = contrastRatio(rgb, BLACK);
  const useWhite = onWhite >= onBlack;
  return {
    ink: useWhite ? "#ffffff" : "#000000",
    fill,
    ratio: Math.max(onWhite, onBlack),
    nudges: maxNudges + 1,
  };
}

export function mix(aHex: string, bHex: string, t: number): string {
  const a = hexToOklab(aHex);
  const b = hexToOklab(bHex);
  return rgbToHex(oklabToRgb({ L: a.L + (b.L - a.L) * t, a: a.a + (b.a - a.a) * t, b: a.b + (b.b - a.b) * t }));
}
