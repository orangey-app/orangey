/**
 * Orangey's motion, as numbers.
 *
 * The model owns the springs and the state machine and produces, each frame,
 * everything the view needs to draw: the body path, the eye centres and
 * rotations, the limb angles, the whole-figure offset and tilt. It never
 * touches the DOM, so the tests can run it in Node for ten simulated seconds
 * and check the invariant that matters: at rest, he is the drawing.
 *
 * States live in a registry. A state is a pose (which drawn parts show) plus
 * an optional entry impulse and a per-frame driver that sets spring targets.
 * Adding an animation is registering a state; nothing else changes.
 */

import {
  MASCOT_BASE_Y,
  MASCOT_BODY,
  MASCOT_EYES,
  MASCOT_LIMB_KEYS,
  MASCOT_MOUTH_CENTRE,
  MASCOT_MOUTH_KEYS,
  MASCOT_POSES,
  bodyPathFrom,
  type EyePlacement,
  type EyeSide,
  type LimbKey,
  type MouthKey,
  type PoseName,
} from "./parts.ts";
import { MascotSpring, mascotField, type BodyModes } from "./springs.ts";

export interface MascotStateDef {
  pose: PoseName;
  /** Fired once when the state is entered: launches, kicks, target changes. */
  enter?: (m: MascotModel) => void;
  /** Runs every frame: sets spring targets from the state's clock. */
  drive?: (m: MascotModel, dt: number) => void;
  /** Limb targets this frame; every other limb goes to 0. */
  limbs?: (m: MascotModel) => Partial<Record<LimbKey, number>>;
}

const MASCOT_STATE_REGISTRY = new Map<string, MascotStateDef>();
const MASCOT_WARNED = new Set<string>();

export function registerMascotState(name: string, def: MascotStateDef): void {
  MASCOT_STATE_REGISTRY.set(name, def);
}

export function mascotStateNames(): string[] {
  return [...MASCOT_STATE_REGISTRY.keys()];
}

/** Unknown names fall back to idle, once loudly, so a stale rule never breaks a session. */
export function mascotStateDef(name: string): { name: string; def: MascotStateDef } {
  const def = MASCOT_STATE_REGISTRY.get(name);
  if (def) return { name, def };
  if (!MASCOT_WARNED.has(name)) {
    MASCOT_WARNED.add(name);
    console.warn(`Orangey has no state called "${name}"; using idle.`);
  }
  const idle = MASCOT_STATE_REGISTRY.get("idle");
  if (!idle) throw new Error("the idle state is not registered");
  return { name: "idle", def: idle };
}

export interface EyeState {
  x: MascotSpring;
  y: MascotSpring;
  r: MascotSpring;
}

export interface MascotFrame {
  pose: PoseName;
  bodyPath: string;
  /** Vertical offset of the whole figure (hop + crouch) and its tilt about the feet. */
  offsetY: number;
  tilt: number;
  stem: { dx: number; dy: number; rot: number };
  eyes: Record<EyeSide, { cx: number; cy: number; rot: number; dx: number; dy: number; scale: number }>;
  mouths: Record<MouthKey, { dx: number; dy: number; scale: number }>;
  limbs: Record<LimbKey, number>;
}

export class MascotModel {
  /* body modes — TRANSIENT ONLY: target 0 in every state, symmetric clamps */
  readonly sq = new MascotSpring(168, 7.4).clamp(-0.09, 0.09);
  readonly sl = new MascotSpring(96, 5.2).clamp(-0.06, 0.06);
  readonly pn = new MascotSpring(240, 6.0).clamp(-0.16, 0.16);
  /* posture — carries the poses so that no pose deforms the silhouette */
  readonly tilt = new MascotSpring(60, 4.6).clamp(-8, 8);
  readonly crouch = new MascotSpring(120, 9.0).clamp(0, 6);
  /* face */
  readonly eyeScale = new MascotSpring(210, 9.0).clamp(0.16, 1.45).set(1);
  readonly mouthScale = new MascotSpring(210, 9.0).clamp(0.3, 1.35).set(1);
  readonly eye: Record<EyeSide, EyeState> = {
    L: { x: new MascotSpring(120, 9), y: new MascotSpring(120, 9), r: new MascotSpring(120, 9) },
    R: { x: new MascotSpring(120, 9), y: new MascotSpring(120, 9), r: new MascotSpring(120, 9) },
  };
  readonly limb = {} as Record<LimbKey, MascotSpring>;

  /* the hop: ballistic only while airborne; standing still is a real state */
  y = 0;
  vy = 0;
  grounded = true;

  /** How far the body modes are allowed to show: 0 none, 1 soft, 1.8 the owner's default. */
  gain = 1.8;
  /** Total simulated time, and time in the current state. */
  t = 0;
  stateT = 0;
  state = "";
  pose: PoseName = "neutral";
  /** Scratch for state drivers (the idle nudge clock, the happy hop clock). */
  scratch: Record<string, number> = {};
  /**
   * The only way a state may move the squash target: a zero-mean breath of
   * this amplitude. Reset every frame, so a state has to keep asking for it.
   */
  breath = 0;

  #prevSlosh = 0;
  #lastAx = 0;
  #random: () => number;

  constructor(random: () => number = Math.random) {
    this.#random = random;
    for (const k of MASCOT_LIMB_KEYS) this.limb[k] = new MascotSpring(k === "L" || k === "R" ? 190 : 130, k === "L" || k === "R" ? 8.5 : 6.8).clamp(-18, 18);
    this.placeEyes("ec", true);
  }

  random(): number {
    return this.#random();
  }

  launch(v: number): void {
    this.vy = v;
    this.grounded = false;
  }

  placeEyes(placement: EyePlacement, snap: boolean): void {
    for (const side of ["L", "R"] as const) {
      const [px, py, prot] = MASCOT_EYES[placement][side];
      const e = this.eye[side];
      e.x.t = px;
      e.y.t = py;
      // rotate the short way round: an ellipse is the same at 180°
      let target = prot;
      while (target - e.r.x > 90) target -= 180;
      while (target - e.r.x < -90) target += 180;
      e.r.t = target;
      if (snap) {
        e.x.set(px);
        e.y.set(py);
        e.r.set(prot);
      }
    }
  }

  setState(name: string): void {
    const { name: resolved, def } = mascotStateDef(name);
    if (this.state === resolved) return;
    const first = this.state === "";
    this.state = resolved;
    this.stateT = 0;
    this.pose = def.pose;
    this.placeEyes(MASCOT_POSES[def.pose].eyes, first);
    // every state parks squash at zero; poses are crouch + tilt, never squash
    this.sq.t = 0;
    this.eyeScale.t = 1;
    this.mouthScale.t = 1;
    def.enter?.(this);
    if (!first) this.pn.kick(0.35);
  }

  step(dt: number): void {
    this.t += dt;
    this.stateT += dt;
    const { def } = mascotStateDef(this.state);

    // drivers set targets; the squash target is derived, never set directly,
    // so its mean over any breath cycle is exactly zero
    this.sl.t = 0;
    this.tilt.t = 0;
    this.crouch.t = 0;
    this.breath = 0;
    def.drive?.(this, dt);
    this.sq.t = this.breath * Math.sin(this.t * 1.85);

    const limbTargets = def.limbs?.(this) ?? {};
    for (const k of MASCOT_LIMB_KEYS) this.limb[k].t = limbTargets[k] ?? 0;

    // the hop, integrated only while airborne
    if (!this.grounded) {
      this.vy += 1150 * dt;
      this.y += this.vy * dt;
      if (this.y >= 0) {
        const impact = this.vy;
        this.y = 0;
        if (impact > 60) this.vy = -impact * 0.35;
        else {
          this.vy = 0;
          this.grounded = true;
        }
        this.sq.kick(impact * 0.004);
        this.pn.kick(impact * 0.0012);
        this.limb.L.kick(-impact * 0.25);
        this.limb.R.kick(impact * 0.25);
      }
    }

    this.sq.step(dt);
    this.sl.step(dt);
    this.pn.step(dt);
    this.tilt.step(dt);
    this.crouch.step(dt);
    this.eyeScale.step(dt);
    this.mouthScale.step(dt);
    for (const side of ["L", "R"] as const) {
      this.eye[side].x.step(dt);
      this.eye[side].y.step(dt);
      this.eye[side].r.step(dt);
    }

    // limbs lag the body: the slosh's acceleration drives them
    const ax = (this.sl.x - this.#prevSlosh) / Math.max(dt, 1e-4);
    this.#prevSlosh = this.sl.x;
    const drive = (ax - this.#lastAx) * 0.01;
    this.#lastAx = ax;
    for (const k of MASCOT_LIMB_KEYS) {
      this.limb[k].kick(drive * (k === "L" || k === "R" ? 0.4 : 1));
      this.limb[k].step(dt);
    }
  }

  /** Everything at its target, no motion: the static pose instant mode draws. */
  freeze(): void {
    this.sq.set(0);
    this.sl.set(0);
    this.pn.set(0);
    this.tilt.set(this.tilt.t);
    this.crouch.set(this.crouch.t);
    this.y = 0;
    this.vy = 0;
    this.grounded = true;
    this.eyeScale.set(this.eyeScale.t);
    this.mouthScale.set(this.mouthScale.t);
    this.placeEyes(MASCOT_POSES[this.pose].eyes, true);
    for (const k of MASCOT_LIMB_KEYS) this.limb[k].set(this.limb[k].t);
  }

  modes(): BodyModes {
    return { squash: this.sq.x, slosh: this.sl.x, pinch: this.pn.x };
  }

  /** The deformation at a point of the drawing, as an offset. */
  ride(x: number, y: number): { dx: number; dy: number } {
    const [fx, fy] = mascotField(x, y, this.modes(), this.gain);
    return { dx: fx - x, dy: fy - y };
  }

  frame(): MascotFrame {
    const m = this.modes();
    const points = MASCOT_BODY.map(([x, y]) => mascotField(x, y, m, this.gain));
    const eyes = {} as MascotFrame["eyes"];
    for (const side of ["L", "R"] as const) {
      const e = this.eye[side];
      const { dx, dy } = this.ride(e.x.x, e.y.x);
      eyes[side] = { cx: e.x.x, cy: e.y.x, rot: e.r.x, dx, dy, scale: this.eyeScale.x };
    }
    const mouths = {} as MascotFrame["mouths"];
    const mouthScale = this.pose === "oops" ? 1 : this.mouthScale.x;
    for (const k of MASCOT_MOUTH_KEYS) {
      const [cx, cy] = MASCOT_MOUTH_CENTRE[k];
      mouths[k] = { ...this.ride(cx, cy), scale: mouthScale };
    }
    const limbs = {} as Record<LimbKey, number>;
    for (const k of MASCOT_LIMB_KEYS) limbs[k] = this.limb[k].x;
    const stemRide = this.ride(75.82, 37.82);
    return {
      pose: this.pose,
      bodyPath: bodyPathFrom(points),
      offsetY: this.y + this.crouch.x,
      tilt: this.tilt.x,
      stem: { ...stemRide, rot: -this.sl.x * this.gain * 34 },
      eyes,
      mouths,
      limbs,
    };
  }
}

export const MASCOT_FEET_X = 96;
export const MASCOT_FEET_Y = MASCOT_BASE_Y;
