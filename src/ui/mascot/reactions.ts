/**
 * What Orangey does about what happens — as a table.
 *
 * A reaction is: on this event, when this holds, play that state. The first
 * matching row wins. Every row has an id so the GM can switch it off in
 * Settings, and a salience so that a reaction only ever interrupts a held one
 * of lower salience — an Oops is never buried by a Reveal that lands a frame
 * later.
 *
 * Adding a trigger is adding a row. Nothing upstream names an animation;
 * nothing here names a randomizer.
 */

import type { MascotEvent, MascotEventType } from "./events.ts";

export interface MascotReaction {
  id: string;
  on: MascotEventType;
  when?: (event: MascotEvent) => boolean;
  /** A registered state name (states.ts). Unknown names fall back to idle. */
  then: string;
  /** Higher interrupts lower; equal restarts. */
  salience: number;
  /** For the settings panel. */
  label: string;
}

export const MASCOT_SALIENCE = { idle: 0, anticipate: 1, reveal: 2, happy: 3, oops: 4 } as const;

const isLand = (e: MascotEvent): e is Extract<MascotEvent, { type: "roll:land" }> => e.type === "roll:land";
const isImport = (e: MascotEvent): e is Extract<MascotEvent, { type: "import:done" }> => e.type === "import:done";

export const DEFAULT_REACTIONS: readonly MascotReaction[] = [
  { id: "roll-start", on: "roll:start", then: "anticipate", salience: MASCOT_SALIENCE.anticipate, label: "Watches the roll" },
  { id: "outcome-cheer", on: "roll:land", when: (e) => isLand(e) && e.summary.mood === "cheer", then: "happy", salience: MASCOT_SALIENCE.happy, label: "Cheers an outcome you tagged" },
  { id: "outcome-wince", on: "roll:land", when: (e) => isLand(e) && e.summary.mood === "wince", then: "oops", salience: MASCOT_SALIENCE.oops, label: "Winces at an outcome you tagged" },
  { id: "roll-max", on: "roll:land", when: (e) => isLand(e) && e.summary.extreme === "max", then: "happy", salience: MASCOT_SALIENCE.happy, label: "Cheers a maximum roll" },
  { id: "roll-min", on: "roll:land", when: (e) => isLand(e) && e.summary.extreme === "min", then: "oops", salience: MASCOT_SALIENCE.oops, label: "Winces at a minimum roll" },
  { id: "roll-land", on: "roll:land", then: "reveal", salience: MASCOT_SALIENCE.reveal, label: "Reacts when a roll lands" },
  { id: "roll-fail", on: "roll:fail", then: "oops", salience: MASCOT_SALIENCE.oops, label: "Winces when a roll cannot happen" },
  { id: "link-fail", on: "link:fail", then: "oops", salience: MASCOT_SALIENCE.oops, label: "Winces when a slide link points nowhere" },
  { id: "import-ok", on: "import:done", when: (e) => isImport(e) && e.ok, then: "happy", salience: MASCOT_SALIENCE.happy, label: "Cheers a clean import" },
  { id: "import-warn", on: "import:done", when: (e) => isImport(e) && !e.ok, then: "oops", salience: MASCOT_SALIENCE.oops, label: "Winces at an import with problems" },
];

/** The first matching reaction that is switched on, or null. */
export function pickReaction(
  event: MascotEvent,
  reactions: readonly MascotReaction[],
  isOn: (id: string) => boolean = () => true,
): MascotReaction | null {
  for (const r of reactions) {
    if (r.on !== event.type) continue;
    if (!isOn(r.id)) continue;
    if (r.when && !r.when(event)) continue;
    return r;
  }
  return null;
}

/**
 * May `next` take over from `held`? Higher salience interrupts; equal
 * restarts; lower waits. The host exempts a new roll from this: a fresh roll
 * always takes over, because it is the newest fact about the table.
 */
export function mayInterrupt(held: MascotReaction | null, next: MascotReaction): boolean {
  return held === null || next.salience >= held.salience;
}
