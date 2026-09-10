/**
 * The result panel: the largest thing on the screen, and the only place a
 * result is ever announced.
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
}

export function createResultPanel(placeholder = "Ready"): ResultPanel {
  const value = h("div", { class: "result-value", text: placeholder });
  const detail = h("div", { class: "result-detail" });
  const meta = h("div", { class: "result-meta" });
  const live = h("div", { class: "sr-only", role: "status", "aria-live": "polite", "aria-atomic": "true" });
  const el = h("div", { class: "result-panel" }, value, detail, meta, live);

  return {
    el,
    show(outcome, { announce = true } = {}) {
      el.classList.remove("is-pending");
      value.textContent = outcome.text;
      value.classList.toggle("small", outcome.text.length > 18);
      value.classList.toggle("is-max", outcome.isMaximum === true);
      value.classList.toggle("is-min", outcome.isMinimum === true);
      detail.textContent = outcome.detail ?? "";
      meta.textContent = outcome.seed ? `seed ${outcome.seed}` : "";
      if (announce) live.textContent = outcome.speak;
    },
    pending(text = "Rolling…") {
      el.classList.add("is-pending");
      value.textContent = text;
      value.classList.remove("is-max", "is-min");
      value.classList.add("small");
      detail.textContent = "";
      meta.textContent = "";
    },
    clear(text = placeholder) {
      el.classList.remove("is-pending");
      value.textContent = text;
      value.className = "result-value";
      detail.textContent = "";
      meta.textContent = "";
    },
    announce(text) {
      live.textContent = text;
    },
  };
}
