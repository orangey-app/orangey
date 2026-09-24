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
import { isRollable } from "../../core/weighted.ts";
import { labelFor } from "../../core/color.ts";
import {
  arcPath,
  fitLabelToWidth,
  layout,
  planSpin,
  pointOnCircle,
  POINTER_ANGLE,
  radialLabelRoom,
  tickerWindow,
  type Segment,
} from "../../core/wheel-geometry.ts";
import { CryptoSource } from "../../core/rng.ts";
import type { ListItem } from "../../model/randomizer.ts";
import { SEGMENT_POOL } from "../styles/palette.ts";
import { easeSpin, motionScale, overshootFraction, settleForSpin, wheelDuration, type FeelSettings } from "../feel.ts";
import { h, s, setChildren } from "../dom.ts";
import { imageUrl, imageUrlSync } from "../../storage/images.ts";

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
    const n = opts.items().filter(isRollable).length;
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

  /**
   * Which draw we are on. A picture that arrives after the wheel has been
   * redrawn belongs to a wheel that no longer exists, and redrawing on it
   * would undo whatever the newer draw put there.
   */
  let renderCount = 0;

  function refresh(): void {
    const items = opts.items();
    computeColors();
    segments = layout(items, { padAngle: items.length > 60 ? 0 : 0.4 });
    renderCount++;
    setChildren(el, mode() === "ticker" ? renderTicker() : renderWheel());
  }

  function renderWheel(): HTMLElement {
    const items = opts.items();
    const showLabels = mode() === "wheel";
    // Pictures not in the cache yet are collected over the whole draw and
    // fetched together, and the wheel is redrawn once, only if something
    // actually arrived. Redrawing on a picture that is simply not there is
    // what used to spin this forever.
    const wanted = new Set<string>();
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

    // A picture on an outcome is drawn inside its slice, clipped to the wedge,
    // so a wheel of portraits can be recognised at a glance. The label stays:
    // a thumbnail this small says "an owlbear", not which owlbear.
    const pictures = segments.flatMap((seg) => {
      const item = items[seg.index];
      if (!item?.image) return [];
      const url = imageUrlSync(item.image);
      if (!url) {
        wanted.add(item.image);
        return [];
      }
      const span = seg.endAngle - seg.startAngle;
      if (span < 12) return [];
      const key = `${opts.id()}-${seg.index}`.replace(/[^a-zA-Z0-9_-]/g, "");
      const [cxImg, cyImg] = pointOnCircle(cx, cy, radius * 0.62, seg.midAngle);
      const side = Math.min(radius * 0.40, 2 * radius * 0.62 * Math.sin((span * Math.PI) / 360) * 0.85);
      // A round medallion, and the slice clipped around it: a square would
      // read as a sticker laid on the wheel, and a picture that reached the
      // edges would take the label's contrast with it.
      return [
        s("clipPath", { id: `slice-${key}` }, s("path", { d: arcPath(seg, cx, cy, radius) })),
        s("clipPath", { id: `disc-${key}` }, s("circle", { cx: String(cxImg), cy: String(cyImg), r: String(side / 2) })),
        s("g", { "clip-path": `url(#slice-${key})` },
          s("image", {
            href: url,
            x: String(cxImg - side / 2),
            y: String(cyImg - side / 2),
            width: String(side),
            height: String(side),
            preserveAspectRatio: "xMidYMid slice",
            "clip-path": `url(#disc-${key})`,
          }),
          s("circle", {
            cx: String(cxImg), cy: String(cyImg), r: String(side / 2),
            fill: "none", stroke: "var(--bg-raised)", "stroke-width": "1.5", "clip-path": `url(#disc-${key})`,
          }),
        ),
      ];
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

    rotor = s("g", { class: "wheel-rotor" }, ...paths, ...pictures, ...labels);
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
    if (wanted.size) {
      const drawnAt = renderCount;
      const ids = [...wanted];
      void Promise.all(ids.map((id) => imageUrl(id))).then((urls) => {
        // Nothing came back: every one of them is missing, and asking again
        // would only produce the same answer.
        if (renderCount !== drawnAt || !urls.some((url) => url !== null)) return;
        refresh();
      });
    }
    return h("div", { class: "wheel-holder" }, svg);
  }

  function renderTicker(): HTMLElement {
    const items = opts.items().filter(isRollable);
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

  /**
   * Run an animation, and hand back the way to cut it short.
   *
   * The wheel and the ticker travel differently but wait the same way: a
   * frame loop, a `skip` that jumps to the end, and exactly one settle
   * whichever of the two gets there first. `onDone` runs once.
   */
  function animate(durationMs: number, onFrame: (t: number) => void, onDone: () => void): Promise<void> {
    const started = performance.now();
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        onDone();
        cancelSpin = null;
        resolve();
      };
      cancelSpin = finish;
      const step = (now: number) => {
        if (done) return;
        const t = Math.min(1, (now - started) / durationMs);
        onFrame(t);
        if (t >= 1) finish();
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
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

    return animate(
      duration,
      (t) => {
        rotation = from + delta * easeSpin(t, feel, overshoot);
        applyRotation();
      },
      () => {
        rotation = plan.rotation;
        applyRotation();
      },
    );
  }

  function spinTicker(index: number, feel: FeelSettings): Promise<void> {
    const items = opts.items();
    const live = items.map((it, i) => ({ it, i })).filter(({ it }) => isRollable(it));
    const position = Math.max(0, live.findIndex(({ i }) => i === index));
    // Must match `.ticker-row` in app.css.
    const rowHeight = 46;
    const duration = wheelDuration(feel);
    if (!tickerStrip) return Promise.resolve();
    const strip = tickerStrip;

    // The idle strip holds only the first rows of a long list, so the winner
    // may not be among them. Rebuild it around the winner before travelling,
    // and the roll lands on a row that exists however long the list is.
    const window_ = tickerWindow(live.length, position);
    const rows = live.slice(window_.start, window_.end);
    setChildren(strip,
      ...rows.map(({ it }, i) =>
        h("div", {
          class: "ticker-row",
          style: { background: (window_.start + i) % 2 ? "var(--bg-raised)" : "transparent" },
        }, it.label),
      ),
    );
    const target = -(window_.local * rowHeight);

    if (duration <= 0) {
      strip.style.transform = `translateY(${target}px)`;
      return Promise.resolve();
    }
    const from = -(rows.length * rowHeight);
    const overshoot = overshootFraction(settleForSpin(feel), Math.abs(target - from));
    return animate(
      duration,
      (t) => {
        strip.style.transform = `translateY(${from + (target - from) * easeSpin(t, feel, overshoot)}px)`;
      },
      () => {
        strip.style.transform = `translateY(${target}px)`;
      },
    );
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
