/**
 * The five states Orangey ships with.
 *
 * Each is a pose plus what he does in it. None of them sets the squash
 * target: idle asks for a zero-mean breath, and every other pose is carried
 * by crouch and tilt, so the silhouette is always the owner's drawing.
 *
 * To add a state: register it here (or anywhere that runs before the mascot
 * mounts), then name it in a reaction. Nothing else needs to change.
 */

import { registerMascotState, type MascotModel } from "./model.ts";

/* Idle: breathes, tilts its head, hops once in a while. Eye contact. */
registerMascotState("idle", {
  pose: "neutral",
  enter(m) {
    m.scratch.nudgeAt = m.t + 2 + m.random() * 3;
  },
  drive(m) {
    m.breath = 0.02;
    m.sl.t = 0.008 * Math.sin(m.t * 0.72);
    m.tilt.t = 2.6 * Math.sin(m.t * 0.55);
    if (m.t > (m.scratch.nudgeAt ?? 0)) {
      m.launch(-120);
      m.tilt.kick(18 * (m.random() < 0.5 ? -1 : 1));
      m.scratch.nudgeAt = m.t + 4.2 + m.random() * 3.6;
    }
  },
});

/* Anticipate: sinks, leans back, rocks; the drawn squint looks at the wheel. */
registerMascotState("anticipate", {
  pose: "anticipate",
  drive(m) {
    m.sl.t = 0.032 * Math.sin(m.t * 11);
    m.tilt.t = -4.5 + 2.5 * Math.sin(m.t * 11);
    m.crouch.t = 2.5;
  },
  limbs(m) {
    return { I: 3 * Math.sin(m.t * 11), J: -3 * Math.sin(m.t * 11) };
  },
});

/* Reveal: the surprised pose, launched at the landing. Holds until told otherwise. */
registerMascotState("reveal", {
  pose: "surprised",
  enter(m) {
    m.eyeScale.t = 1.32;
    m.launch(-190);
    m.sq.kick(-1.0);
    m.pn.kick(1.1);
    m.eyeScale.kick(5);
    m.limb.A.kick(-7);
    m.limb.B.kick(4);
    m.tilt.kick(-46);
  },
  limbs() {
    return { A: -16 };
  },
});

/* Oops: sways, ducks, rubs the back of its head. */
registerMascotState("oops", {
  pose: "oops",
  enter(m) {
    m.eyeScale.t = 0.88;
    m.sq.kick(0.5);
    m.sl.kick(0.35);
  },
  drive(m) {
    m.sl.t = 0.028 * Math.sin(m.t * 2.4);
    m.tilt.t = 3.5;
    m.crouch.t = 1.5;
  },
  limbs(m) {
    return { D: -7 * Math.sin(m.t * 8.7) };
  },
});

/* Happy: arms up, a little dance, small repeated hops. Eye contact. */
registerMascotState("happy", {
  pose: "happy",
  enter(m) {
    m.eyeScale.t = 1.08;
    m.launch(-150);
    m.sq.kick(-0.8);
    m.pn.kick(0.9);
    m.limb.G.kick(-9);
    m.limb.H.kick(9);
    m.tilt.kick(30);
    m.scratch.lastHop = -1;
  },
  drive(m) {
    m.sl.t = 0.012 * Math.sin(m.t * 6);
    m.tilt.t = 3 * Math.sin(m.t * 6);
    const beat = Math.floor(m.t * 2);
    if (m.grounded && m.stateT > 0.9 && m.stateT < 2.6 && beat !== m.scratch.lastHop) {
      m.scratch.lastHop = beat;
      m.launch(-95);
    }
  },
  limbs(m) {
    return { G: -8 * Math.sin(m.t * 7.5), H: 8 * Math.sin(m.t * 7.5) };
  },
});

/** The names the reactions table may use, for validation and the settings panel. */
export const MASCOT_BUILTIN_STATES = ["idle", "anticipate", "reveal", "oops", "happy"] as const;
export type MascotStateName = (typeof MASCOT_BUILTIN_STATES)[number];
export function isMascotState(name: unknown): name is MascotStateName {
  return typeof name === "string" && (MASCOT_BUILTIN_STATES as readonly string[]).includes(name);
}
