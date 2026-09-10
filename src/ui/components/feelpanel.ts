/**
 * The controls for one section of the Feel settings — wheel, dice or coin.
 *
 * Used twice: in Settings for the global values, and in a randomizer's editor
 * for that randomizer's own override. Same sliders, same previews, so what
 * you learn in one place is true in the other.
 */

import { LIMITS, type CoinFeel, type DiceFeel, type FeelSettings, type WheelFeel } from "../feel.ts";
import { button, h } from "../dom.ts";

export function slider(
  label: string,
  value: number,
  [min, max]: readonly [number, number],
  step: number,
  format: (v: number) => string,
  onChange: (v: number) => void,
): HTMLElement {
  const readout = h("span", { class: "faint", text: format(value) });
  const input = h("input", { type: "range", min: String(min), max: String(max), step: String(step), value: String(value), "aria-label": label });
  input.addEventListener("input", () => { readout.textContent = format(Number(input.value)); });
  input.addEventListener("change", () => onChange(Number(input.value)));
  return h("label", { class: "field" },
    h("span", { class: "row" }, h("span", { class: "field-label", text: label }), h("span", { class: "spacer" }), readout),
    input,
  );
}

export function choice<T extends string>(label: string, options: readonly T[], current: T, onChange: (v: T) => void): HTMLElement {
  return h("div", { class: "field" },
    h("span", { class: "field-label", text: label }),
    h("div", { class: "segmented", role: "group", "aria-label": label },
      ...options.map((o) => button(o[0].toUpperCase() + o.slice(1), () => onChange(o), { "aria-pressed": o === current ? "true" : "false" })),
    ),
  );
}

export interface SectionPanel {
  el: HTMLElement;
}

export function wheelControls(values: WheelFeel, onChange: (patch: Partial<WheelFeel>) => void, extras: HTMLElement[] = []): HTMLElement {
  return h("div", { class: "feel-section" },
    slider("Spin length", values.durationMs, LIMITS.wheelDuration, 100, (v) => `${(v / 1000).toFixed(1)} s`, (v) => onChange({ durationMs: v })),
    slider("Turns", values.turns, LIMITS.turns, 1, (v) => `${v}`, (v) => onChange({ turns: v })),
    choice("Wind-down", ["gentle", "standard", "snappy"] as const, values.curve, (v) => onChange({ curve: v })),
    slider("Roll-back, at most", values.settleDegrees, LIMITS.settleDegrees, 1,
      (v) => (v === 0 ? "none" : `${v}°`), (v) => onChange({ settleDegrees: v })),
    h("p", { class: "faint", text: "Each spin swings past its target by a random share of this — between half and all of it — before settling back." }),
    ...extras,
  );
}

export function diceControls(values: DiceFeel, onChange: (patch: Partial<DiceFeel>) => void, extras: HTMLElement[] = []): HTMLElement {
  return h("div", { class: "feel-section" },
    choice("Style", ["flat", "wireframe"] as const, values.style, (v) => onChange({ style: v })),
    slider("Tumble", values.tumbleMs, LIMITS.tumble, 50, (v) => `${v} ms`, (v) => onChange({ tumbleMs: v })),
    slider("Bounces", values.bounces, LIMITS.bounces, 1, (v) => `${v}`, (v) => onChange({ bounces: v })),
    slider("Scatter", values.spread, LIMITS.spread, 0.05, (v) => `${Math.round(v * 100)}%`, (v) => onChange({ spread: v })),
    ...extras,
  );
}

export function coinControls(values: CoinFeel, onChange: (patch: Partial<CoinFeel>) => void, extras: HTMLElement[] = []): HTMLElement {
  return h("div", { class: "feel-section" },
    slider("Flip length", values.durationMs, LIMITS.coinDuration, 50, (v) => `${(v / 1000).toFixed(1)} s`, (v) => onChange({ durationMs: v })),
    slider("Flips", values.flips, LIMITS.coinFlips, 1, (v) => `${v}`, (v) => onChange({ flips: v })),
    slider("Toss height", values.arc, LIMITS.coinArc, 0.1, (v) => (v === 0 ? "in place" : `${v.toFixed(1)}×`), (v) => onChange({ arc: v })),
    ...extras,
  );
}

/** The section that applies to a randomizer type. */
export function sectionFor(type: string): keyof Pick<FeelSettings, "wheel" | "dice" | "coin"> | null {
  return type === "list" ? "wheel" : type === "dice" ? "dice" : type === "coin" ? "coin" : null;
}
