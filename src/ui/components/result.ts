/**
 * The result panel: the largest thing on the screen, and the only place a
 * result is ever announced.
 *
 * Its height is reserved, not discovered. `reserve()` is called with the
 * longest outcome the current randomizer can produce, and from that the panel
 * fixes its type size and how many lines it keeps — so the card never grows
 * when a roll lands, and never grows again when a longer outcome comes up
 * later. An outcome that still does not fit is clipped with an ellipsis; the
 * spoken announcement is always the whole thing.
 *
 * The live region is updated when the animation ends (or immediately in
 * instant mode) so that a screen reader is never told the answer before the
 * table can see it.
 */

import { h } from "../dom.ts";
import type { Outcome } from "../roll.ts";

export interface ResultPanel {
  el: HTMLElement;
  show(outcome: Outcome, opts?: { announce?: boolean }): void;
  /** While an animation runs: hold the slot without giving the answer away. */
  pending(text?: string): void;
  clear(placeholder?: string): void;
  announce(text: string): void;
  /**
   * Fix the panel's size from the longest outcome that can come up, and say
   * whether a seed line needs room. Called when a randomizer is opened or
   * swapped, never per roll.
   */
  reserve(longest: string, opts?: { seed?: boolean }): void;
}

/** Beyond this many characters the result drops to the smaller type size. */
export const RESULT_SMALL_AT = 18;
/** Beyond this many characters a second line is kept, so wrapping cannot push. */
export const RESULT_TWO_LINES_AT = 12;

export function resultLines(longest: string): 1 | 2 {
  return longest.length > RESULT_TWO_LINES_AT ? 2 : 1;
}

export function resultIsSmall(longest: string): boolean {
  return longest.length > RESULT_SMALL_AT;
}

export function createResultPanel(placeholder = "Ready"): ResultPanel {
  const value = h("div", { class: "result-value", text: placeholder });
  const slot = h("div", { class: "result-slot" }, value);
  const detail = h("div", { class: "result-detail" });
  const meta = h("div", { class: "result-meta" });
  const live = h("div", { class: "sr-only", role: "status", "aria-live": "polite", "aria-atomic": "true" });
  const el = h("div", { class: "result-panel" }, slot, detail, meta, live);

  return {
    el,
    show(outcome, { announce = true } = {}) {
      el.classList.remove("is-pending");
      value.textContent = outcome.text;
      value.classList.toggle("is-max", outcome.isMaximum === true);
      value.classList.toggle("is-min", outcome.isMinimum === true);
      value.title = outcome.text;
      detail.textContent = outcome.detail ?? "";
      meta.textContent = outcome.seed ? `seed ${outcome.seed}` : "";
      if (announce) live.textContent = outcome.speak;
    },
    pending(text = "Rolling…") {
      el.classList.add("is-pending");
      value.textContent = text;
      value.classList.remove("is-max", "is-min");
      value.removeAttribute("title");
      detail.textContent = "";
      meta.textContent = "";
    },
    clear(text = placeholder) {
      el.classList.remove("is-pending");
      value.textContent = text;
      value.classList.remove("is-max", "is-min");
      value.removeAttribute("title");
      detail.textContent = "";
      meta.textContent = "";
    },
    reserve(longest, { seed = false } = {}) {
      const lines = resultLines(longest);
      slot.classList.toggle("small", resultIsSmall(longest));
      el.style.setProperty("--result-lines", String(lines));
      // Full screen uses this: two lines of the largest type is a lot of a
      // short window, so the type there gives way rather than the wheel.
      el.classList.toggle("two-lines", lines === 2);
      el.classList.toggle("seeded", seed);
    },
    announce(text) {
      live.textContent = text;
    },
  };
}
