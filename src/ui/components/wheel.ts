/**
 * The wheel.
 *
 * Three modes, chosen by outcome count (decision D9): labelled segments up to
 * 48, unlabelled segments up to 200, and above that a ticker — a 250-slice pie
 * is unreadable, and encounter tables that long are common.
 *
 * Labels are written along the radius, reading outwards, and the pointer sits
 * at three o'clock, so whatever wins arrives horizontal and reads towards it.
 * Labels on the left half read upside down while the wheel is still; flipping
 * them would turn half of all winners upside down instead.
 *
 * The spin is fitted to a result that has already been decided, so skipping is
 * always safe and the wheel can never disagree with the announcement.
 */

import { assignColors, toCandidate, type ColorCandidate } from "../../core/palette-assign.ts";
import { labelFor } from "../../core/color.ts";
import {
  arcPath,
  fitLabelToWidth,
  layout,
  planSpin,
  pointOnCircle,
  POINTER_ANGLE,
  radialLabelRoom,
  type Segment,
} from "../../core/wheel-geometry.ts";
import { CryptoSource } from "../../core/rng.ts";
import type { ListItem } from "../../model/randomizer.ts";
import { SEGMENT_POOL } from "../styles/palette.ts";
import { easeSpin, motionScale, overshootFraction, settleForSpin, wheelDuration, type FeelSettings } from "../feel.ts";
import { h, s, setChildren } from "../dom.ts";

export const LABEL_LIMIT = 48;
export const TICKER_LIMIT = 200;
/** The disc at the centre; labels stop short of it. */
const HUB_RADIUS = 16;

const POOL: ColorCandidate[] = SEGMENT_POOL.map((c) => toCandidate(c.hex));

/** Weight of the wheel's labels; the same value is in .wheel-label in app.css. */
const WHEEL_LABEL_WEIGHT = 600;

let labelCanvas: CanvasRenderingContext2D | null | undefined;
let labelFamily = "";

/**
 * A string's advance at the wheel's label font. Canvas measures without the
 * SVG being in the document; where there is no canvas, 0.6 em a character.
 */
function measureWheelLabel(text: string, fontSize: number): number {
  if (labelCanvas === undefined) {
    labelCanvas = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;
    // The --font token is fixed for the life of the page, so it is read once.
    if (labelCanvas) labelFamily = getComputedStyle(document.documentElement).getPropertyValue("--font").trim();
  }
  if (!labelCanvas) return Array.from(text).length * 0.6 * fontSize;
  labelCanvas.font = `${WHEEL_LABEL_WEIGHT} ${fontSize}px ${labelFamily || "system-ui, sans-serif"}`;
  return labelCanvas.measureText(text).width;
}

export interface WheelView {
  el: HTMLElement;
  /** Redraw from the current items. */
  refresh(): void;
  /** Animate to an outcome index; resolves when the wheel has settled. */
  spinTo(index: number, feel: FeelSettings): Promise<void>;
  /** Jump to the end of a running spin. */
  skip(): void;
  /** Colour actually used for each outcome, for the editor's swatches. */
  colors(): string[];
  mode(): "wheel" | "unlabelled" | "ticker";
}

export interface WheelOptions {
  items: () => ListItem[];
  id: () => string;
  /** Called when the user clicks the wheel itself. */
  onActivate?: () => void;
  size?: number;
}

export function createWheel(opts: WheelOptions): WheelView {
  const size = opts.size ?? 320;
  const cx = size / 2;
  const cy = size / 2;
  const radius = size / 2 - 6;
  // The pointer overlaps the rim; labels end a little short of its tip, or the
  // winner's last letters would sit underneath it.
  const pointerTip = size / 2 - 20;
  const labelEnd = pointerTip - 5;

  const el = h("div", { class: "wheel-wrap" });
  let segments: Segment[] = [];
  let colorByIndex: string[] = [];
  let rotation = 0;
  let cancelSpin: (() => void) | null = null;

  const mode = (): "wheel" | "unlabelled" | "ticker" => {
    const n = opts.items().filter((i) => !i.disabled && i.weight > 0).length;
    return n > TICKER_LIMIT ? "ticker" : n > LABEL_LIMIT ? "unlabelled" : "wheel";
  };

  let rotor: SVGElement | null = null;
  let tickerStrip: HTMLElement | null = null;

  function computeColors(): void {
    const items = opts.items();
    const result = assignColors({
      fixed: items.map((i) => i.color ?? null),
      id: opts.id(),
      pool: POOL,
      cyclic: true,
    });
    colorByIndex = result.colors;
  }

  function refresh(): void {
    const items = opts.items();
    computeColors();
    segments = layout(items, { padAngle: items.length > 60 ? 0 : 0.4 });
    setChildren(el, mode() === "ticker" ? renderTicker() : renderWheel());
  }

  function renderWheel(): HTMLElement {
    const items = opts.items();
    const showLabels = mode() === "wheel";
    const paths = segments.map((seg) => {
      const fill = colorByIndex[seg.index] ?? "#888888";
      return s("path", {
        d: arcPath(seg, cx, cy, radius),
        fill,
        stroke: "var(--bg-raised)",
        "stroke-width": segments.length > 60 ? 0.5 : 1,
        "data-index": String(seg.index),
      });
    });

    const labels = showLabels
      ? segments.flatMap((seg) => {
          const item = items[seg.index];
          // A sliver cannot carry a readable label; the list beside the wheel
          // and the result panel say what it is instead.
          const room = radialLabelRoom(seg.endAngle - seg.startAngle, { outer: labelEnd, hub: HUB_RADIUS + 6 });
          if (!room) return [];
          const { ink } = labelFor(colorByIndex[seg.index] ?? "#888888");
          const text = fitLabelToWidth(item.label, room.length, (t) => measureWheelLabel(t, room.fontSize));
          // Anchored at the rim and running inwards along the radius, reading
          // outwards — horizontal once the slice is under the pointer.
          const [x, y] = pointOnCircle(cx, cy, room.outer, seg.midAngle);
          return [
            s("text", {
              class: "wheel-label",
              "data-index": String(seg.index),
              x: String(x),
              y: String(y),
              fill: ink,
              "font-size": String(room.fontSize),
              "text-anchor": "end",
              "dominant-baseline": "middle",
              transform: `rotate(${seg.midAngle - POINTER_ANGLE} ${x} ${y})`,
              text,
            }),
          ];
        })
      : [];

    rotor = s("g", { class: "wheel-rotor" }, ...paths, ...labels);
    applyRotation();

    // At three o'clock, pointing in at the centre (POINTER_ANGLE).
    const pointer = s("path", {
      class: "wheel-pointer",
      d: `M ${size - 2} ${cy - 10} L ${size - 2} ${cy + 10} L ${cx + pointerTip} ${cy} Z`,
      fill: "var(--accent)",
      stroke: "var(--bg-raised)",
      "stroke-width": "1.5",
    });

    const svg = s(
      "svg",
      {
        class: "wheel-svg",
        viewBox: `0 0 ${size} ${size}`,
        role: "img",
        "aria-label": `Wheel with ${segments.length} possible outcomes`,
        onclick: () => opts.onActivate?.(),
      },
      s("circle", { cx: String(cx), cy: String(cy), r: String(radius + 2), fill: "var(--border)" }),
      rotor,
      s("circle", { cx: String(cx), cy: String(cy), r: String(HUB_RADIUS), fill: "var(--bg-raised)", stroke: "var(--border-strong)" }),
      pointer,
    );
    return h("div", { class: "wheel-holder" }, svg);
  }

  function renderTicker(): HTMLElement {
    const items = opts.items().filter((i) => !i.disabled && i.weight > 0);
    tickerStrip = h(
      "div",
      { class: "ticker-strip" },
      ...items.slice(0, 400).map((item, i) =>
        h("div", { class: "ticker-row", style: { background: i % 2 ? "var(--bg-raised)" : "transparent" } }, item.label),
      ),
    );
    return h(
      "div",
      { class: "ticker", role: "img", "aria-label": `${items.length} possible outcomes` },
      tickerStrip,
      h("div", { class: "ticker-marker" }),
    );
  }

  function applyRotation(): void {
    if (rotor) rotor.setAttribute("transform", `rotate(${rotation % 360} ${cx} ${cy})`);
  }

  function spinTo(index: number, feel: FeelSettings): Promise<void> {
    cancelSpin?.();
    const duration = wheelDuration(feel);
    if (mode() === "ticker") return spinTicker(index, feel);

    const segment = segments.find((seg) => seg.index === index);
    if (!segment) return Promise.resolve();
    const plan = planSpin(segment, new CryptoSource(), {
      turns: feel.wheel.turns,
      currentRotation: rotation,
    });

    if (duration <= 0 || motionScale(feel.motion) === 0) {
      rotation = plan.rotation;
      applyRotation();
      return Promise.resolve();
    }

    const from = rotation;
    const delta = plan.rotation - from;
    // The roll-back is a random share of the maximum, in degrees, expressed as
    // a fraction of this particular spin rather than of a nominal one.
    const overshoot = overshootFraction(settleForSpin(feel), delta);
    const started = performance.now();

    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        rotation = plan.rotation;
        applyRotation();
        cancelSpin = null;
        resolve();
      };
      cancelSpin = finish;
      const step = (now: number) => {
        if (done) return;
        const t = Math.min(1, (now - started) / duration);
        rotation = from + delta * easeSpin(t, feel, overshoot);
        applyRotation();
        if (t >= 1) finish();
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }

  function spinTicker(index: number, feel: FeelSettings): Promise<void> {
    const items = opts.items();
    const live = items.map((it, i) => ({ it, i })).filter(({ it }) => !it.disabled && it.weight > 0);
    const position = Math.max(0, live.findIndex(({ i }) => i === index));
    const rowHeight = 46;
    const target = -(position * rowHeight);
    const duration = wheelDuration(feel);
    if (!tickerStrip) return Promise.resolve();
    const strip = tickerStrip;

    if (duration <= 0) {
      strip.style.transform = `translateY(${target}px)`;
      return Promise.resolve();
    }
    const from = -(Math.min(live.length, 400) * rowHeight);
    const overshoot = overshootFraction(settleForSpin(feel), Math.abs(target - from));
    const started = performance.now();
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        strip.style.transform = `translateY(${target}px)`;
        cancelSpin = null;
        resolve();
      };
      cancelSpin = finish;
      const step = (now: number) => {
        if (done) return;
        const t = Math.min(1, (now - started) / duration);
        strip.style.transform = `translateY(${from + (target - from) * easeSpin(t, feel, overshoot)}px)`;
        if (t >= 1) finish();
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }

  refresh();

  return {
    el,
    refresh,
    spinTo,
    skip: () => cancelSpin?.(),
    colors: () => colorByIndex,
    mode,
  };
}
