/**
 * What the app tells the mascot.
 *
 * Randomizers emit facts; they never name an animation. The reactions table
 * (reactions.ts) turns a fact into a state, and the host plays it. Keeping
 * this vocabulary small and generic is what lets a new randomizer type join
 * without the mascot knowing it exists: it produces an Outcome, the Outcome is
 * summarised, and everything downstream already works.
 */

import type { Outcome } from "../roll.ts";
import type { OutcomeReaction, Randomizer } from "../../model/randomizer.ts";

export type Extreme = "max" | "min" | null;

export interface RollSummary {
  kind: Randomizer["type"];
  /**
   * The roll hit the top or bottom of what it could produce. For dice that
   * is every kept die on its highest (or lowest) face; for whole-number draws,
   * every value at the range's bound. Coins and wheels have no honest extreme
   * and always report null.
   */
  extreme: Extreme;
  /**
   * What the game master asked for when this outcome comes up — a wheel item
   * or coin face tagged "cheer" or "wince" in its editor. Dice and numbers
   * carry no tag; their extremes speak for them.
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
