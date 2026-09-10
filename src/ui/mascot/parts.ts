/**
 * Orangey's anatomy, as the owner drew it.
 *
 * Copyright (c) 2026 Amogh Kinikar. All rights reserved. The geometry in
 * this file is the Orangey character and is NOT under the MIT licence that
 * covers the rest of the software — see LICENSE and assets/mascot/README.md.
 *
 * Every constant here is lifted from one of six SVG files — the logo and the
 * five poses — normalised into the logo's own coordinate space. The body is
 * the same curve in all six (maximum deviation 0.0005 units), so there is one
 * body; the poses differ only in eyes, mouth and arms. Legs are canonical in
 * every pose. Nothing here is invented: redrawing a pose is a one-constant
 * swap, and the source files live in assets/mascot/.
 */

/** The body outline: four cubic segments, twelve movable points. */
export const MASCOT_BODY: readonly (readonly [number, number])[] = [
  [133.13, 53.04], [123.28, 36.87], [104.04, 26.77],
  [85.06, 25.98], [41.32, 23.06], [-4.97, 68.07],
  [23.2, 110.3], [37.68, 131.12], [65.34, 140.74],
  [90.15, 137.22], [130.24, 131.74], [155.04, 88.88],
];

/** Where the body's mass sits, and where its feet rest. */
export const MASCOT_CENTRE = { x: 82.9, y: 81.6 } as const;
export const MASCOT_BASE_Y = 137.2;

/** The whole figure fits in this box; the view's viewBox. */
export const MASCOT_VIEWBOX = "2 0 178 176";

export type EyePlacement = "tq" | "ec" | "sq";
export type EyeSide = "L" | "R";

/**
 * Every eye in every drawing is the same 7.09 × 9.92 ellipse; only its centre
 * and rotation change. tq = three-quarter (logo, surprised, upset); ec = eye
 * contact (idle, happy); sq = the anticipation squint, the ellipse turned so
 * its long axis lies nearly flat — deliberately cockeyed, as drawn.
 */
export const MASCOT_EYES: Record<EyePlacement, Record<EyeSide, readonly [number, number, number]>> = {
  tq: { L: [87.78, 87.76, -12.71], R: [120.02, 77.95, -12.71] },
  ec: { L: [70.8, 79.93, -7.85], R: [109.67, 71.56, -19.39] },
  sq: { L: [80.18, 81.01, -82.96], R: [116.53, 76.32, 69.71] },
};
export const MASCOT_EYE_RX = 7.09;
export const MASCOT_EYE_RY = 9.92;

/** The stem nub on top of the head, the same in every drawing. */
export const MASCOT_STEM = { cx: 75.82, cy: 37.82, rx: 7.09, ry: 4.25 } as const;

export type LimbKey = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I" | "J" | "L" | "R";

/** Where each limb hinges: the drawn shoulder or hip. */
export const MASCOT_PIVOT: Record<LimbKey, readonly [number, number]> = {
  A: [127.27, 63.99], B: [48.82, 99.68], C: [128.76, 77.95], D: [48.81, 99.68],
  E: [128.37, 74.77], F: [51.13, 100.26], G: [120.44, 64.73], H: [39.38, 91.38],
  I: [77.95, 116.24], J: [127.23, 106.07], L: [72.7, 127.2], R: [118.95, 118.1],
};
export const MASCOT_LIMB_KEYS: readonly LimbKey[] = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "L", "R"];

export type MouthKey = "mO" | "mW" | "mIdle" | "mHappy" | "mAnt";
export const MASCOT_MOUTH_CENTRE: Record<MouthKey, readonly [number, number]> = {
  mO: [110.83, 110.95], mW: [107.6, 109.4], mIdle: [97, 106.9], mHappy: [94.9, 109.3], mAnt: [102.6, 100.9],
};
export const MASCOT_MOUTH_KEYS: readonly MouthKey[] = ["mO", "mW", "mIdle", "mHappy", "mAnt"];

export type PoseName = "neutral" | "surprised" | "oops" | "happy" | "anticipate";
export interface Pose {
  eyes: EyePlacement;
  mouth: MouthKey;
  /** Two limb keys; which is drawn in front is fixed by the markup order. */
  arms: readonly [LimbKey, LimbKey];
}
export const MASCOT_POSES: Record<PoseName, Pose> = {
  neutral: { eyes: "ec", mouth: "mIdle", arms: ["E", "F"] },
  surprised: { eyes: "tq", mouth: "mO", arms: ["A", "B"] },
  oops: { eyes: "tq", mouth: "mW", arms: ["C", "D"] },
  happy: { eyes: "ec", mouth: "mHappy", arms: ["G", "H"] },
  anticipate: { eyes: "sq", mouth: "mAnt", arms: ["I", "J"] },
};

/* ---- markup ---------------------------------------------------------------
 * Path data verbatim from the owner's files, translated into logo space.
 * A hand is four finger strokes and a dot at the wrist.
 */

function mascotHand(x: number, y: number, fingers: readonly string[], dotAsPath = false): string {
  const strokes = fingers.map((d) => `<path class="l" d="M${x},${y}${d}"/>`).join("");
  const dot = dotAsPath
    ? `<path class="d" d="M20.51,72.82c-1.13-.45-1.6-1.56-1.05-2.48s1.91-1.3,3.04-.85,1.6,1.56,1.05,2.48-1.91,1.3-3.04.85Z"/>`
    : `<circle class="d" cx="${x}" cy="${y}" r="1.42"/>`;
  return strokes + dot;
}

function mascotArm(key: LimbKey, d: string, hx: number, hy: number, fingers: readonly string[], dotAsPath = false): string {
  return `<g class="arm arm${key}"><path class="l" d="${d}"/>${mascotHand(hx, hy, fingers, dotAsPath)}</g>`;
}

/** Limbs drawn behind the body: the screen-right arms and the right leg. */
const MASCOT_BACK_LIMBS =
  // A — up-right (Surprised)
  mascotArm("A", "M127.27,63.99c9.89-.52,21.07-3.3,30.01-11.59.49-.46.97-.93,1.44-1.4", 158.71, 51, [
    "c.75-1.26,2.48-4.41,1.63-7.66-.25-.97-.68-1.75-1.12-2.36",
    "c.9-.07,4.38-.57,7.02-3.45,1.45-1.58,2.05-3.28,2.31-4.27",
    "c.77-.52,2.64-1.88,3.75-4.39,1.05-2.38.92-4.51.81-5.44",
    "c2.15-.17,3.78-.71,5.28.44,1.61,1.23,1.82,3.1,1.85,3.45",
  ]) +
  // C — out-right (Upset)
  mascotArm("C", "M128.76,77.95c6.23,7.7,15.06,15.1,27.01,17.46.66.13,1.32.24,1.98.34", 157.75, 95.75, [
    "c1.46.13,5.02.58,7.16,3.18.64.78,1.02,1.58,1.25,2.29",
    "c.58-.69,3.04-3.21,6.92-3.65,2.13-.24,3.86.27,4.81.64",
    "c.88-.32,3.07-1.03,5.76-.45,2.54.55,4.19,1.91,4.88,2.55",
    "c1.4-1.64,2.8-2.64,2.75-4.53-.05-2.02-1.44-3.3-1.7-3.53",
  ]) +
  // E — Idle right: the down-left arm mirrored
  mascotArm("E", "M128.37,74.77c2.45,9.6,7.37,20.01,17.24,27.15.55.4,1.1.77,1.66,1.14", 147.27, 103.06, [
    "c1.38.49,4.81,1.57,7.83.1.9-.44,1.59-1.01,2.1-1.56",
    "c.24.87,1.42,4.18,4.76,6.2,1.84,1.11,3.62,1.37,4.64,1.43",
    "c.67.66,2.36,2.22,5.04,2.81,2.54.56,4.61.02,5.5-.28",
    "c.58,2.07,1.44,3.57.61,5.27-.89,1.82-2.69,2.39-3.02,2.49",
  ]) +
  // G — Happy right, raised
  mascotArm("G", "M120.44,64.73c5.19-8.43,9.25-19.21,7.52-31.27-.1-.67-.21-1.33-.34-1.98", 127.62, 31.48, [
    "c-.61-1.33-2.22-4.54-5.38-5.7-.94-.34-1.83-.44-2.58-.42",
    "c.46-.78,2.02-3.93,1.15-7.74-.48-2.09-1.54-3.55-2.2-4.33",
    "c0-.93-.05-3.24-1.49-5.58-1.36-2.22-3.19-3.32-4.02-3.76",
    "c1.08-1.86,1.57-3.52,3.36-4.1,1.92-.63,3.59.27,3.89.44",
  ]) +
  `<g class="legR"><path class="l" d="M118.95,118.1c5.91,12.02,2.32,25.63,2.32,25.63,0,0,8.48-.45,14.31-.76"/></g>`;

/** Limbs drawn in front of the body: the screen-left arms, the anticipation pair, and the left leg. */
const MASCOT_FRONT_LIMBS =
  // B — down-left (Surprised)
  mascotArm("B", "M48.82,99.68c-2.49,9.59-7.45,19.98-17.35,27.08-.55.39-1.1.77-1.66,1.13", 29.8, 127.89, [
    "c-1.38.48-4.81,1.55-7.83.07-.9-.44-1.58-1.02-2.09-1.57",
    "c-.25.87-1.43,4.18-4.79,6.18-1.84,1.1-3.62,1.35-4.64,1.41",
    "c-.67.65-2.37,2.21-5.05,2.79-2.54.55-4.61,0-5.49-.3",
    "c-.59,2.07-1.45,3.57-.63,5.26.88,1.82,2.68,2.4,3.01,2.51",
  ]) +
  // D — up-left (Upset); its dot is a filled path in the source
  mascotArm("D", "M48.81,99.68c-8.83-.46-27.39-4.89-27.39-4.89,0,0,8.63-16.92,2.36-21.78-.78-.61-1.54-1.23-2.28-1.85", 21.51, 71.15, [
    "c-1.66-1.72-8.06-9.09-2.47-10.05",
    "c-1.44-.1-8.08-.17-8.69-2.99-.39-1.82-.13-2.49.83-3.43",
    "c-1.23-.7-6.27-1.63-7.15-4.48-.77-2.47.51-2.99,1.43-2.96",
    "c-3.44-.25-6.91,2.54-8.48.49",
  ], true) +
  // F — Idle left, hanging
  mascotArm("F", "M51.13,100.26c2.81,9.5,3.91,20.96-.93,32.15-.27.62-.55,1.23-.84,1.82", 49.36, 134.23, [
    "c-.93,1.13-3.33,3.81-6.68,4.09-1,.09-1.88-.05-2.6-.27",
    "c.24.87.92,4.32-.92,7.77-1.01,1.89-2.41,3.02-3.25,3.6",
    "c-.24.9-.9,3.11-2.89,5-1.89,1.78-3.95,2.37-4.86,2.57",
    "c.56,2.08.59,3.8,2.17,4.84,1.69,1.11,3.53.68,3.87.6",
  ]) +
  // H — Happy left, raised: the down-left arm flipped vertically
  mascotArm("H", "M39.38,91.38c-2.49-9.59-7.45-19.98-17.35-27.08-.55-.39-1.1-.77-1.66-1.13", 20.37, 63.17, [
    "c-1.38-.48-4.81-1.55-7.83-.07-.9.44-1.58,1.02-2.09,1.57",
    "c-.25-.87-1.43-4.18-4.79-6.18-1.84-1.1-3.62-1.35-4.64-1.41",
    "c-.67-.65-2.37-2.21-5.05-2.79-2.54-.55-4.61,0-5.49.3",
    "c-.59-2.07-1.45-3.57-.63-5.26.88-1.82,2.68-2.4,3.01-2.51",
  ]) +
  // I, J — Anticipation, both hands crossing the front
  mascotArm("I", "M77.95,116.24c3.27,9.03,7.27,19.39,7.27,19.39,0,0,19.66-18.68,34.43-18.29", 119.65, 117.33, [
    "c1.36-.55,4.63-2.02,5.92-5.13.38-.93.52-1.81.53-2.56",
    "c.76.49,3.84,2.19,7.68,1.47,2.11-.39,3.61-1.38,4.42-2.01",
    "c.93.05,3.24.09,5.64-1.25,2.27-1.27,3.45-3.05,3.92-3.86",
    "c1.81,1.16,3.45,1.72,3.95,3.53.54,1.95-.42,3.57-.6,3.87",
  ]) +
  mascotArm("J", "M127.23,106.07c1.54,1.97,4.77,14.48,4.77,14.48,0,0-22.87-3.29-38.96,4.81", 93.15, 125.34, [
    "c-1.36-.55-4.63-2.02-5.92-5.13-.38-.93-.52-1.81-.53-2.56",
    "c-.76.49-3.84,2.19-7.68,1.47-2.11-.39-3.61-1.38-4.42-2.01",
    "c-.93.05-3.24.09-5.64-1.25-2.27-1.27-3.45-3.05-3.92-3.86",
    "c-1.81,1.16-3.45,1.72-3.95,3.53-.54,1.95.42,3.57.6,3.87",
  ]) +
  `<g class="legL"><path class="l" d="M72.7,127.2c3.68,13.11-6.4,29.54-6.4,29.54,0,0,12.08,3.03,14.23,3.52"/></g>`;

const MASCOT_FACE =
  `<g class="stem"><ellipse cx="${MASCOT_STEM.cx}" cy="${MASCOT_STEM.cy}" rx="${MASCOT_STEM.rx}" ry="${MASCOT_STEM.ry}"/></g>` +
  `<g class="eyeR"><g class="lid"><ellipse class="eye eyeR-el" cx="120.02" cy="77.95" rx="${MASCOT_EYE_RX}" ry="${MASCOT_EYE_RY}"/></g></g>` +
  `<g class="eyeL"><g class="lid"><ellipse class="eye eyeLopen eyeL-el" cx="87.78" cy="87.76" rx="${MASCOT_EYE_RX}" ry="${MASCOT_EYE_RY}"/></g>` +
  `<polygon class="eyeLsquint eye" points="72.55,85.86 79.62,82.69 72.99,77.91 88.49,83.70"/></g>` +
  `<g class="mouth mO"><ellipse cx="110.83" cy="110.95" rx="5.67" ry="7.09"/></g>` +
  `<g class="mouth mW"><path d="M118.95,108.25c-.75-3.02-6.45-4.21-12.72-2.64-6.27,1.56-10.75,5.28-9.99,8.31l22.72-5.66Z"/></g>` +
  `<g class="mouth mIdle"><path d="M116.08,102.32c.47,3.18-7.68,7.03-18.22,8.59s-19.45.24-19.92-2.94l38.14-5.64Z"/></g>` +
  `<g class="mouth mHappy"><path d="M113.96,101.41c1.03,6.98-6.67,13.9-17.2,15.45s-19.9-2.83-20.94-9.81l38.14-5.64Z"/></g>` +
  `<g class="mouth mAnt"><path d="M118.13,96.51c-1.51.44-6.84,2.37-13.87,3.31-7.3.97-17.16,1.52-17.16,1.52,0,0,6.66,4.85,18.36,3.69,8.16-.81,12.67-8.53,12.67-8.53Z"/></g>`;

/** The complete SVG for one Orangey, all poses present, selected by data-pose. */
export function mascotMarkup(): string {
  return (
    `<svg class="mascot-svg" viewBox="${MASCOT_VIEWBOX}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">` +
    `<g class="root">${MASCOT_BACK_LIMBS}<path class="body" d=""/>${MASCOT_FRONT_LIMBS}${MASCOT_FACE}</g></svg>`
  );
}

/** The body at rest, exactly as drawn — the invariant every test pins. */
export function mascotRestingBodyPath(): string {
  return bodyPathFrom(MASCOT_BODY.map(([x, y]) => [x, y] as [number, number]));
}

/**
 * The app's mark: his head alone, tight to the drawn outline plus two units
 * of air. The logo tile in assets/mascot/logo.svg is this artwork on the
 * brand black square; the square belongs to the icons, which are square
 * canvases, not to a mark sitting on a coloured bar.
 */
export const MASCOT_LOGO_VIEWBOX = "12.59 23.85 130.71 116.09";

/** The tile the icons are drawn on, from logo.svg. */
export const MASCOT_LOGO_TILE = 155.91;

/**
 * Orangey's head as the logo: the same body, stem and three-quarter eyes as
 * every pose, with no mouth and no limbs. It is built from the constants
 * above rather than from a second copy of the paths, so redrawing him
 * reaches the top bar, the favicon and the installed icon at once.
 *
 * It is deliberately not a `mascot-svg`: that class means an animated
 * Orangey, and counting them is how the tests prove there is only ever one.
 */
export function mascotLogoMarkup(): string {
  const eye = (side: EyeSide) => {
    const [cx, cy, rot] = MASCOT_EYES.tq[side];
    return `<ellipse class="eye" cx="${cx}" cy="${cy}" rx="${MASCOT_EYE_RX}" ry="${MASCOT_EYE_RY}" transform="rotate(${rot} ${cx} ${cy})"/>`;
  };
  return (
    `<svg class="logo-svg" viewBox="${MASCOT_LOGO_VIEWBOX}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">` +
    `<path class="body" d="${mascotRestingBodyPath()}"/>` +
    `<ellipse class="stem" cx="${MASCOT_STEM.cx}" cy="${MASCOT_STEM.cy}" rx="${MASCOT_STEM.rx}" ry="${MASCOT_STEM.ry}"/>` +
    eye("R") + eye("L") +
    `</svg>`
  );
}

export function bodyPathFrom(points: readonly (readonly [number, number])[]): string {
  let d = "";
  for (let i = 0; i < 12; i++) {
    const [x, y] = points[i];
    if (i === 0) d = `M${x.toFixed(2)},${y.toFixed(2)}`;
    else {
      if (i % 3 === 1) d += "C";
      d += ` ${x.toFixed(2)},${y.toFixed(2)}`;
    }
  }
  const [x0, y0] = points[0];
  return `${d} ${x0.toFixed(2)},${y0.toFixed(2)}Z`;
}
