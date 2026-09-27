/**
 * The one Orangey the app shows: a single host owning a single mascot element.
 * It looks each mascot event up in the reactions table and plays the result
 * according to the presence setting:
 *
 *   hidden    — nothing mounted, events ignored
 *   triggers  — invisible until a reaction plays, then fades out again
 *   always    — visible and idling; reactions play over the idle
 *
 * The mascot only reads: the host listens to events and moves an element, and
 * never writes app state.
 */

import type { FeelSettings, MascotPresence } from "../feel.ts";
import { MASCOT_ANTICIPATE_MIN_MS, mascotHoldMs, mascotRuleOn } from "../feel.ts";
import { onMascotEvent, type MascotEvent } from "./events.ts";
import { createMascot, type Mascot, type MascotOptions } from "./mascot.ts";
import { DEFAULT_REACTIONS, mayInterrupt, pickReaction, type MascotReaction } from "./reactions.ts";

export interface MascotTimers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
  now: () => number;
}

export interface MascotHostOptions {
  bus: EventTarget;
  feel: () => FeelSettings;
  reactions?: readonly MascotReaction[];
  /** Injected by the unit tests; the app uses the real ones. */
  timers?: MascotTimers;
  factory?: (opts: MascotOptions) => Mascot;
}

const REAL_TIMERS: MascotTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
};

/** How many anticipation holds to wait for a landing before giving up: a safety net. */
const ANTICIPATE_SAFETY_MULTIPLIER = 6;

export class MascotHost {
  readonly reactions: readonly MascotReaction[];
  #bus: EventTarget;
  #feel: () => FeelSettings;
  #timers: MascotTimers;
  #factory: (opts: MascotOptions) => Mascot;
  #mascot: Mascot | null = null;
  #slot: HTMLElement | null = null;
  #unsubscribe: (() => void) | null = null;
  #held: MascotReaction | null = null;
  #holdTimer: unknown = null;
  #pendingAnticipate: unknown = null;
  #visible = false;
  #presence: MascotPresence = "hidden";
  /** For tests and the debug hook: what was played, in order. */
  readonly played: string[] = [];

  constructor(opts: MascotHostOptions) {
    this.#bus = opts.bus;
    this.#feel = opts.feel;
    this.reactions = opts.reactions ?? DEFAULT_REACTIONS;
    this.#timers = opts.timers ?? REAL_TIMERS;
    this.#factory = opts.factory ?? createMascot;
    this.#unsubscribe = onMascotEvent(this.#bus, (e) => this.handle(e));
    this.applyFeel();
  }

  get presence(): MascotPresence {
    return this.#presence;
  }

  get state(): string {
    return this.#mascot?.model.state ?? "";
  }

  get visible(): boolean {
    return this.#visible;
  }

  get el(): HTMLElement | null {
    return this.#mascot?.el ?? null;
  }

  /** Put him in a slot; each surface that may show him has one. Idempotent. */
  mount(slot: HTMLElement): void {
    this.#slot = slot;
    if (this.#presence === "hidden") return;
    this.#ensure();
    if (this.#mascot && this.#mascot.el.parentElement !== slot) slot.appendChild(this.#mascot.el);
    if (this.#visible) this.#mascot?.resume();
  }

  /** Off screen: nothing to draw into, so the ticker is released too. */
  unmount(): void {
    this.#slot = null;
    this.#mascot?.el.remove();
    this.#mascot?.pause();
  }

  get mounted(): boolean {
    return this.#slot !== null && this.#mascot?.el.parentElement === this.#slot;
  }

  /** Called whenever settings change: presence, wobble or motion may differ. */
  applyFeel(): void {
    const feel = this.#feel();
    const presence = feel.mascot.presence;
    if (presence !== this.#presence) {
      this.#presence = presence;
      this.#clearHold();
      if (presence === "hidden") {
        this.#mascot?.destroy();
        this.#mascot = null;
        this.#visible = false;
        return;
      }
      this.#ensure();
      if (this.#slot) this.mount(this.#slot);
      this.#setVisible(presence === "always");
      this.#mascot?.setState("idle");
    }
    if (this.#mascot) {
      this.#mascot.setWobble(feel.mascot.wobble);
      this.#mascot.setMotion(feel.motion);
      if (!this.#visible) this.#mascot.pause();
    }
  }

  handle(event: MascotEvent): void {
    if (this.#presence === "hidden") return;
    const feel = this.#feel();
    const reaction = pickReaction(event, this.reactions, (id) => mascotRuleOn(feel, id));
    if (!reaction) return;

    // A landing cancels a not-yet-shown anticipation: in instant mode the gap
    // is a frame, and nobody should see a pose flash for a frame.
    if (reaction.on !== "roll:start" && this.#pendingAnticipate !== null) {
      this.#timers.clear(this.#pendingAnticipate);
      this.#pendingAnticipate = null;
    }

    if (reaction.on === "roll:start") {
      if (this.#pendingAnticipate !== null) return;
      this.#clearHold();
      this.#pendingAnticipate = this.#timers.set(() => {
        this.#pendingAnticipate = null;
        this.#play(reaction, mascotHoldMs("anticipate", feel) * ANTICIPATE_SAFETY_MULTIPLIER);
      }, MASCOT_ANTICIPATE_MIN_MS);
      return;
    }

    // A new roll always takes his attention; salience only arbitrates between
    // other events (an import finishing while an Oops is held, say).
    const freshRoll = reaction.on === "roll:land";
    if (!freshRoll && !mayInterrupt(this.#held, reaction)) return;
    this.#play(reaction, mascotHoldMs(reaction.then, feel, event.type));
  }

  destroy(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#clearHold();
    if (this.#pendingAnticipate !== null) this.#timers.clear(this.#pendingAnticipate);
    this.#mascot?.destroy();
    this.#mascot = null;
  }

  #ensure(): void {
    if (this.#mascot) return;
    const feel = this.#feel();
    this.#mascot = this.#factory({ state: "idle", wobble: feel.mascot.wobble, motion: feel.motion });
    this.#mascot.el.classList.add("mascot-host");
  }

  #play(reaction: MascotReaction, holdMs: number): void {
    this.#ensure();
    if (!this.#mascot) return;
    this.#clearHold();
    this.#held = reaction;
    this.played.push(reaction.then);
    this.#setVisible(true);
    this.#mascot.resume();
    this.#mascot.setState(reaction.then);
    this.#holdTimer = this.#timers.set(() => this.#release(), holdMs);
  }

  #release(): void {
    this.#holdTimer = null;
    this.#held = null;
    if (!this.#mascot) return;
    if (this.#presence === "always") {
      this.#mascot.setState("idle");
    } else {
      this.#setVisible(false);
      this.#mascot.setState("idle");
      this.#mascot.pause();
    }
  }

  #clearHold(): void {
    if (this.#holdTimer !== null) this.#timers.clear(this.#holdTimer);
    this.#holdTimer = null;
    this.#held = null;
  }

  #setVisible(on: boolean): void {
    this.#visible = on;
    this.#mascot?.el.classList.toggle("is-visible", on);
  }
}
