/**
 * One Orangey: a model, a view, and a place on the shared ticker.
 *
 * `createMascot` is the only thing the rest of the app needs. The host
 * (host.ts) owns the single instance the app shows; the settings panel may
 * make throwaway ones for its previews.
 */

import "./states.ts";
import { MascotModel } from "./model.ts";
import { MascotView } from "./view.ts";
import { mascotTicker } from "./ticker.ts";
import type { MotionLevel } from "../feel.ts";

export interface Mascot {
  readonly el: HTMLElement;
  readonly model: MascotModel;
  setState(name: string): void;
  /** 0 none, 1 soft, 1.8 the owner's default. */
  setWobble(gain: number): void;
  /** full runs the springs; quick runs them faster; instant draws one still pose. */
  setMotion(level: MotionLevel): void;
  /** Stop animating without unmounting; the next setState resumes if motion allows. */
  pause(): void;
  resume(): void;
  destroy(): void;
}

export interface MascotOptions {
  state?: string;
  wobble?: number;
  motion?: MotionLevel;
  random?: () => number;
}

export function createMascot(opts: MascotOptions = {}): Mascot {
  const model = new MascotModel(opts.random);
  const view = new MascotView();
  let motion: MotionLevel = opts.motion ?? "full";
  let unsubscribe: (() => void) | null = null;
  let destroyed = false;

  model.gain = opts.wobble ?? model.gain;

  const timeScale = () => (motion === "quick" ? 2.5 : 1);

  const tick = (dt: number) => {
    model.step(dt * timeScale());
    view.draw(model.frame());
  };

  function drawStill(): void {
    model.freeze();
    view.draw(model.frame());
  }

  function resume(): void {
    if (destroyed) return;
    if (motion === "instant") {
      pause();
      drawStill();
      return;
    }
    view.setBlinking(true);
    unsubscribe ??= mascotTicker.add(tick);
  }

  function pause(): void {
    unsubscribe?.();
    unsubscribe = null;
    view.setBlinking(false);
  }

  const mascot: Mascot = {
    el: view.el,
    model,
    setState(name) {
      model.setState(name);
      if (motion === "instant") drawStill();
      else view.draw(model.frame());
    },
    setWobble(gain) {
      if (gain === model.gain) return;
      model.gain = gain;
      model.pn.kick(0.5);
    },
    setMotion(level) {
      motion = level;
      resume();
    },
    pause,
    resume,
    destroy() {
      destroyed = true;
      pause();
      view.el.remove();
    },
  };

  model.setState(opts.state ?? "idle");
  view.draw(model.frame());
  resume();
  return mascot;
}
