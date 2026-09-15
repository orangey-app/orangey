/**
 * How the app feels when it rolls (plan C10, decision D22).
 *
 * Every animation timing in Orangey comes from here. Nothing else may hold a
 * duration: that is what makes the settings panel able to change all of them,
 * and it is checked by `npm run check`.
 *
 * A randomizer may carry an override for its own type's section (a wheel for
 * the wheel settings, dice for the dice settings), saved in its file; the
 * effective settings for a roll are the global ones with that merged on top.
 */

import type { CoinFeel, DiceFeel, FeelOverride, FeelSettings, MascotFeel, MascotPresence, MotionLevel, SpinCurve, WheelFeel } from "../model/feel.ts";

export type { CoinFeel, DiceFeel, DiceStyle, FeelOverride, FeelSettings, MascotFeel, MascotPresence, MotionLevel, SpinCurve, WheelFeel } from "../model/feel.ts";

export const DEFAULT_FEEL: FeelSettings = {
  motion: "full",
  wheel: { durationMs: 3200, turns: 6, curve: "standard", settleDegrees: 11 },
  dice: { style: "flat", tumbleMs: 900, bounces: 2, spread: 0.5 },
  coin: { flips: 5, durationMs: 1100, arc: 1.2 },
  haptics: false,
  // Out of the box he speaks up only for the moments that carry something:
  // an extreme, an outcome the game master tagged, a link that points nowhere,
  // an import that worked. Watching every roll and reacting to every ordinary
  // landing is available in Settings, off by default, because at the fortieth
  // roll of the evening it is noise. A rule is stored only when it is off, so
  // anyone who has already chosen keeps their choice.
  mascot: {
    presence: "triggers",
    wobble: 1.8,
    rules: { "roll-start": false, "roll-land": false, "roll-fail": false, "import-warn": false },
  },
};

/** The wobble control's three stops: none, soft, and the drawn maximum. */
export const MASCOT_WOBBLE_STOPS = [0, 1, 1.8] as const;

/**
 * How long Orangey holds a reaction before fading back, by state. In "always"
 * presence he returns to idle; in "triggers" presence he fades out. A state
 * not listed here holds for the default.
 */
export const MASCOT_HOLD_MS: Record<string, number> = {
  reveal: 1600,
  happy: 2600,
  oops: 2600,
  default: 2000,
};
/** A failed link is read slowly; give it a moment longer. */
export const MASCOT_LINK_FAIL_HOLD_MS = 3200;
/**
 * Below this gap between "roll started" and "roll landed" the anticipation
 * pose would flash for a frame nobody sees, so it is skipped. Instant mode
 * lands immediately, which is the case this exists for.
 */
export const MASCOT_ANTICIPATE_MIN_MS = 120;

export const LIMITS = {
  wheelDuration: [400, 8000],
  turns: [1, 12],
  settleDegrees: [0, 30],
  tumble: [200, 3000],
  bounces: [0, 4],
  spread: [0, 1],
  coinFlips: [1, 12],
  coinDuration: [300, 3000],
  coinArc: [0, 2.5],
  mascotWobble: [0, 1.8],
} as const;

const clamp = (v: unknown, [lo, hi]: readonly [number, number], fallback: number): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return Math.min(hi, Math.max(lo, n));
};

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;

/** Older files and preferences stored the roll-back as a word. */
function settleFromLegacy(v: unknown): unknown {
  if (v === "none") return 0;
  if (v === "slight") return 4;
  if (v === "bouncy") return 11;
  return v;
}

function normalizeWheel(raw: unknown, base: WheelFeel): WheelFeel {
  const w = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    durationMs: clamp(w.durationMs, LIMITS.wheelDuration, base.durationMs),
    turns: Math.round(clamp(w.turns, LIMITS.turns, base.turns)),
    curve: oneOf(w.curve, ["gentle", "standard", "snappy"] as const, base.curve),
    settleDegrees: clamp(w.settleDegrees ?? settleFromLegacy(w.settle), LIMITS.settleDegrees, base.settleDegrees),
  };
}

function normalizeDice(raw: unknown, base: DiceFeel): DiceFeel {
  const d = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    style: oneOf(d.style, ["flat", "wireframe"] as const, base.style),
    tumbleMs: clamp(d.tumbleMs, LIMITS.tumble, base.tumbleMs),
    bounces: Math.round(clamp(d.bounces, LIMITS.bounces, base.bounces)),
    spread: clamp(d.spread, LIMITS.spread, base.spread),
  };
}

function normalizeCoin(raw: unknown, base: CoinFeel): CoinFeel {
  const c = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    flips: Math.round(clamp(c.flips, LIMITS.coinFlips, base.flips)),
    durationMs: clamp(c.durationMs, LIMITS.coinDuration, base.durationMs),
    arc: clamp(c.arc, LIMITS.coinArc, base.arc),
  };
}

function normalizeMascot(raw: unknown, base: MascotFeel): MascotFeel {
  const m = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  // A rules object that is there is taken as it stands, empty included: that
  // is someone who has switched everything on. Only a missing one falls back
  // to what Orangey ships with.
  const rules: Record<string, boolean> = {};
  if (typeof m.rules === "object" && m.rules !== null) {
    for (const [id, on] of Object.entries(m.rules as Record<string, unknown>)) if (on === false) rules[id] = false;
  } else {
    Object.assign(rules, base.rules);
  }
  return {
    presence: oneOf(m.presence, ["hidden", "triggers", "always"] as const, base.presence),
    wobble: clamp(m.wobble, LIMITS.mascotWobble, base.wobble),
    rules,
  };
}

/**
 * Load settings from storage. Everything is clamped, so a hand-edited or
 * corrupted preference cannot produce a forty-second spin that looks like the
 * app has hung.
 */
export function normalizeFeel(raw: unknown): FeelSettings {
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    motion: oneOf(o.motion, ["full", "quick", "instant"] as const, DEFAULT_FEEL.motion),
    wheel: normalizeWheel(o.wheel, DEFAULT_FEEL.wheel),
    dice: normalizeDice(o.dice, DEFAULT_FEEL.dice),
    coin: normalizeCoin(o.coin, DEFAULT_FEEL.coin),
    haptics: o.haptics === true,
    mascot: normalizeMascot(o.mascot, DEFAULT_FEEL.mascot),
  };
}

/** How long a reaction holds, scaled like every other duration by the motion level. */
export function mascotHoldMs(state: string, feel: FeelSettings, event?: string): number {
  const base = event === "link:fail" ? MASCOT_LINK_FAIL_HOLD_MS : (MASCOT_HOLD_MS[state] ?? MASCOT_HOLD_MS.default);
  // instant mode still shows the reaction; it just does not animate it
  return base * (feel.motion === "quick" ? 0.4 : 1);
}

/** Is a reaction switched on? Absent means on. */
export function mascotRuleOn(feel: FeelSettings, id: string): boolean {
  return feel.mascot.rules[id] !== false;
}

/** A randomizer's override, cleaned: unknown keys dropped, values clamped. */
export function normalizeOverride(raw: unknown): FeelOverride | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  const out: FeelOverride = {};
  const keep = <T extends object>(section: unknown, allowed: (keyof T)[]): Partial<T> | undefined => {
    if (typeof section !== "object" || section === null) return undefined;
    const src = section as Record<string, unknown>;
    const part: Record<string, unknown> = {};
    for (const key of allowed) if (src[key as string] !== undefined) part[key as string] = src[key as string];
    return Object.keys(part).length ? (part as Partial<T>) : undefined;
  };
  const wheel = keep<WheelFeel>(o.wheel, ["durationMs", "turns", "curve", "settleDegrees"]);
  const dice = keep<DiceFeel>(o.dice, ["style", "tumbleMs", "bounces", "spread"]);
  const coin = keep<CoinFeel>(o.coin, ["flips", "durationMs", "arc"]);
  if (wheel) out.wheel = pickKeys(normalizeWheel({ ...DEFAULT_FEEL.wheel, ...wheel }, DEFAULT_FEEL.wheel), Object.keys(wheel));
  if (dice) out.dice = pickKeys(normalizeDice({ ...DEFAULT_FEEL.dice, ...dice }, DEFAULT_FEEL.dice), Object.keys(dice));
  if (coin) out.coin = pickKeys(normalizeCoin({ ...DEFAULT_FEEL.coin, ...coin }, DEFAULT_FEEL.coin), Object.keys(coin));
  return Object.keys(out).length ? out : undefined;
}

function pickKeys<T extends object>(obj: T, keys: string[]): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = (obj as Record<string, unknown>)[k];
  return out as Partial<T>;
}

/** The settings a particular roll should use: global, with the override on top. */
export function effectiveFeel(global: FeelSettings, override?: FeelOverride, animationsOff = false): FeelSettings {
  const merged: FeelSettings = {
    ...global,
    wheel: { ...global.wheel, ...(override?.wheel ?? {}) },
    dice: { ...global.dice, ...(override?.dice ?? {}) },
    coin: { ...global.coin, ...(override?.coin ?? {}) },
  };
  if (animationsOff) merged.motion = "instant";
  return normalizeFeel(merged);
}

/** Quick mode is the same animation at 0.4x; instant skips it entirely. */
export function motionScale(motion: MotionLevel): number {
  return motion === "instant" ? 0 : motion === "quick" ? 0.4 : 1;
}

export function wheelDuration(feel: FeelSettings): number {
  return feel.wheel.durationMs * motionScale(feel.motion);
}
export function diceDuration(feel: FeelSettings): number {
  return feel.dice.tumbleMs * motionScale(feel.motion);
}
export function coinDuration(feel: FeelSettings): number {
  return feel.coin.durationMs * motionScale(feel.motion);
}

/**
 * Ease-out exponent for each curve; higher means a sharper wind-down.
 *
 * Snappy was 5, which wound down so hard that a six-turn spin had 3° of 2340°
 * left by 70 % of its duration: the last third was a wheel standing still.
 */
export function curveExponent(curve: SpinCurve): number {
  return curve === "gentle" ? 2 : curve === "snappy" ? 4 : 3;
}

/**
 * How many wireframe dice are worth animating at once. Above this the tray
 * falls back to flat dice: forty spinning solids is a lot of work for a phone,
 * and forty tiny wireframes are unreadable anyway.
 */
export const WIREFRAME_DICE_LIMIT = 20;

/** The roll-back to use for one particular spin: a random share of the maximum. */
export function settleForSpin(feel: FeelSettings, random: () => number = Math.random): number {
  const max = feel.wheel.settleDegrees;
  if (max <= 0) return 0;
  return max * (0.5 + random() * 0.5);
}

/** 0 for no roll-back, otherwise how long a landing bounce lasts, in milliseconds. */
export function bounceMs(feel: FeelSettings): number {
  const degrees = feel.wheel.settleDegrees;
  if (degrees <= 0) return 0;
  // 4° is a light hop, 11° the default, 30° a real bounce.
  const base = 220 + Math.min(1, degrees / 20) * 260;
  return base * motionScale(feel.motion);
}

/** The fraction of a spin that a roll-back of `degrees` represents. */
export function overshootFraction(degrees: number, deltaDegrees: number): number {
  if (degrees <= 0 || deltaDegrees <= 0) return 0;
  return degrees / deltaDegrees;
}

/* ---- the spin curve -------------------------------------------------------
 * A wheel at rest has to be got moving, so the curve eases in as well as out.
 * The speed profile is a short sine ramp up followed by a power-law wind-down
 * whose exponent is the "curve" setting; integrating it gives the position,
 * normalised so the spin ends exactly on target. Both ends have zero speed.
 *
 * A roll-back is part of that profile, not something added after it. The
 * profile takes a single dip below zero near the end, so the wheel decelerates,
 * carries past where it is going to stop, turns once, and eases back. The dip's
 * size is solved for, so the wheel passes the target by exactly the roll-back
 * the settings ask for, whichever curve is in use.
 *
 * It used to be added on top of a finished curve, from a fixed three-quarters
 * of the way through. That addition starts moving at a speed of its own, so it
 * always stepped the wheel's speed up by about the same amount: invisible under
 * gentle, which is still turning at 7.3°/frame there, and a lurch under snappy,
 * which is down to 0.4°/frame with almost nothing left to travel.
 */
const RAMP_IN = 0.15;
const SAMPLES = 256;
/** The turn begins where the plain curve still has this many roll-backs to travel. */
const TURN_AT_ROLLBACKS = 4;
/**
  * The dip is the wind-down itself, scaled: speed = forward × (1 − depth × g),
  * with g rising smoothly from 0 to 1 over the turn. Above depth 1 the speed
  * crosses zero exactly once and stays below it, whatever the curve — a dip of
  * its own shape can be outrun by a slow wind-down's tail, which put a second
  * turn at the end of every gentle spin.
  */
const MAX_TURN_DEPTH = 64;
/** However large the roll-back, the wheel spends at least this much of the spin going forwards. */
const TURN_LIMITS: readonly [number, number] = [0.5, 0.92];

const plainProfiles = new Map<SpinCurve, Float64Array>();
/** Profiles with a roll-back are per spin, since the roll-back is drawn per spin. */
const settleProfiles = new Map<string, Float64Array>();
const SETTLE_CACHE_LIMIT = 32;

/** The wind-down, sampled as speeds; the area under it is the whole journey. */
function spinSpeeds(curve: SpinCurve): Float64Array {
  const n = curveExponent(curve);
  const speeds = new Float64Array(SAMPLES);
  for (let i = 0; i < SAMPLES; i++) {
    const t = (i + 0.5) / SAMPLES;
    const rampIn = t < RAMP_IN ? Math.sin((Math.PI * t) / (2 * RAMP_IN)) ** 2 : 1;
    speeds[i] = rampIn * (1 - t) ** (n - 1);
  }
  return speeds;
}

/** Speeds -> positions, normalised so the spin ends exactly on target. */
function spinTable(speeds: Float64Array): Float64Array | null {
  const table = new Float64Array(SAMPLES + 1);
  let acc = 0;
  for (let i = 0; i < SAMPLES; i++) {
    acc += speeds[i];
    table[i + 1] = acc;
  }
  // A dip deep enough to undo the whole journey would leave nothing to
  // normalise by; the caller falls back to a spin without one.
  if (!(acc > 0)) return null;
  for (let i = 0; i <= SAMPLES; i++) table[i] /= acc;
  return table;
}

function plainProfile(curve: SpinCurve): Float64Array {
  const cached = plainProfiles.get(curve);
  if (cached) return cached;
  // The plain wind-down is positive throughout, so this cannot fail.
  const table = spinTable(spinSpeeds(curve)) as Float64Array;
  plainProfiles.set(curve, table);
  return table;
}

const sampleAt = (table: Float64Array, t: number): number => {
  const x = t * SAMPLES;
  const i = Math.floor(x);
  return table[i] + (table[Math.min(SAMPLES, i + 1)] - table[i]) * (x - i);
};

/** How far into the spin the wheel starts giving distance back. */
function turnStart(curve: SpinCurve, overshoot: number): number {
  const table = plainProfile(curve);
  const want = 1 - TURN_AT_ROLLBACKS * overshoot;
  let t = TURN_LIMITS[1];
  for (let i = 0; i <= SAMPLES; i++) {
    if (table[i] >= want) {
      t = i / SAMPLES;
      break;
    }
  }
  return Math.min(TURN_LIMITS[1], Math.max(TURN_LIMITS[0], t));
}

/**
 * A profile whose highest point is exactly `overshoot` past the target.
 *
 * The dip's depth is found by bisection. Deeper always means further past the
 * target — the journey is normalised by a total the dip is subtracted from —
 * so the search cannot land on a different solution, which is what ruled out
 * fitting a damped spring to the tail instead.
 */
function settleProfile(curve: SpinCurve, overshoot: number): Float64Array {
  const key = `${curve}:${overshoot.toFixed(6)}`;
  const cached = settleProfiles.get(key);
  if (cached) return cached;

  const forward = spinSpeeds(curve);
  const start = turnStart(curve, overshoot);
  const dip = new Float64Array(SAMPLES);
  for (let i = 0; i < SAMPLES; i++) {
    const t = (i + 0.5) / SAMPLES;
    const u = (t - start) / (1 - start);
    dip[i] = u <= 0 ? 0 : forward[i] * Math.sin((Math.PI * u) / 2) ** 2;
  }

  const combined = new Float64Array(SAMPLES);
  const peakFor = (depth: number): Float64Array | null => {
    for (let i = 0; i < SAMPLES; i++) combined[i] = forward[i] - depth * dip[i];
    return spinTable(combined);
  };
  const highest = (table: Float64Array): number => {
    let top = 0;
    for (let i = 0; i <= SAMPLES; i++) if (table[i] > top) top = table[i];
    return top - 1;
  };

  let lo = 0;
  let hi = MAX_TURN_DEPTH;
  let best = plainProfile(curve);
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const table = peakFor(mid);
    if (table === null || highest(table) > overshoot) hi = mid;
    else {
      lo = mid;
      best = table;
    }
  }
  const settled = Float64Array.from(best);
  if (settleProfiles.size >= SETTLE_CACHE_LIMIT) settleProfiles.clear();
  settleProfiles.set(key, settled);
  return settled;
}

/** Position 0..1 along the spin at progress t, with no roll-back. */
export function spinPosition(t: number, curve: SpinCurve): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return sampleAt(plainProfile(curve), t);
}

/**
 * Progress 0..1 -> eased 0..1.
 *
 * With a roll-back the wheel passes the target by `overshoot` (as a fraction of
 * the whole spin), turns once, and comes back to it. It still finishes exactly
 * on target: the result was decided before any of this started and cannot be
 * changed by how the wheel arrives.
 */
export function easeSpin(t: number, feel: FeelSettings, overshoot = feel.wheel.settleDegrees / 360): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  if (!(overshoot > 0)) return spinPosition(t, feel.wheel.curve);
  return sampleAt(settleProfile(feel.wheel.curve, overshoot), t);
}

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function vibrate(feel: FeelSettings, pattern: number | number[]): void {
  if (!feel.haptics) return;
  const nav = navigator as Navigator & { vibrate?: (p: number | number[]) => boolean };
  try {
    nav.vibrate?.(pattern);
  } catch {
    /* not supported; nothing to do */
  }
}
