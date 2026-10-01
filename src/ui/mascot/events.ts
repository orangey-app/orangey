/**
 * What the app tells the mascot: facts about what happened, never the name of
 * an animation. reactions.ts turns a fact into a state, so a new randomizer
 * type needs no mascot changes.
 */

import type { Outcome } from "../../model/roll.ts";
import type { OutcomeReaction, Randomizer } from "../../model/randomizer.ts";

export type Extreme = "max" | "min" | null;

export interface RollSummary {
  kind: Randomizer["type"];
  /**
   * Every kept die, or every drawn number, at its highest or lowest possible
   * value. Coins and wheels always report null.
   */
  extreme: Extreme;
  /**
   * The "cheer" or "wince" tag set on a wheel item or coin face in its editor.
   * Dice and numbers carry none; their extremes speak for them.
   */
  mood: OutcomeReaction | null;
  /** The same text the result panel shows. */
  text: string;
}

export type MascotEvent =
  | { type: "roll:start"; source: Randomizer["type"] }
  | { type: "roll:land"; source: Randomizer["type"]; summary: RollSummary }
  | { type: "roll:fail"; source: Randomizer["type"]; reason: string }
  | { type: "link:fail"; id: string }
  | { type: "import:done"; ok: boolean; skipped: number };

export type MascotEventType = MascotEvent["type"];

export function summarize(outcome: Outcome): RollSummary {
  const extreme: Extreme = outcome.isMaximum ? "max" : outcome.isMinimum ? "min" : null;
  return { kind: outcome.kind, extreme, mood: outcome.reaction ?? null, text: outcome.text };
}

/** A tiny bus: one EventTarget, one event name, the payload in `detail`. */
export const MASCOT_EVENT = "orangey:mascot";

export function emitMascotEvent(target: EventTarget, event: MascotEvent): void {
  target.dispatchEvent(new CustomEvent(MASCOT_EVENT, { detail: event }));
}

export function onMascotEvent(target: EventTarget, handler: (event: MascotEvent) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<MascotEvent>).detail);
  target.addEventListener(MASCOT_EVENT, listener);
  return () => target.removeEventListener(MASCOT_EVENT, listener);
}
