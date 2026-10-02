/**
 * The wheel, in three modes by outcome count: labelled slices up to 48,
 * unlabelled up to 200, and above that a ticker, since a 250-slice pie is
 * unreadable. The spin is fitted to a result decided before the animation, so
 * skipping is always safe.
 *
 * Labels run along the radius, reading outwards, towards a pointer at three
 * o'clock, so the winner arrives horizontal. Labels on the left half read upside
 * down at rest; flipping them would turn half of all winners upside down.
 */

import { showRefs } from "../../model/refs.ts";

import { assignWheelColours } from "../../core/palette-assign.ts";
import { state } from "../state.ts";
import { isRollable } from "../../core/weighted.ts";
import { labelFor } from "../../core/color.ts";
import {
  arcPath,
  fitLabelToWidth,
  layout,
  planSpin,
  pointOnCircle,
  POINTER_ANGLE,
  sliceLayout,
  tickerWindow,
  type Segment,
  type SliceContent,
  type SliceLayout,
} from "../../core/wheel-geometry.ts";
import { CryptoSource } from "../../core/rng.ts";
import type { ListItem } from "../../model/randomizer.ts";
import { DOUBLE_TAP_MS, easeSpin, motionScale, overshootFraction, settleForSpin, wheelDuration, type FeelSettings } from "../feel.ts";
import { h, s, setChildren, windowOf } from "../dom.ts";
import { imageUrl, imageUrlSync } from "../../storage/images.ts";

export const LABEL_LIMIT = 48;
export const TICKER_LIMIT = 200;
/**
 * The hub is the wheel's Roll button (a click on a slice does not roll, so a
 * double-tap there can edit its weight), so it is sized to be hit. Labels stop
 * short of it.
 */
const HUB_RADIUS = 22;

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
    // The --font-ui token is fixed for the life of the page, so it is read once.
    if (labelCanvas) labelFamily = getComputedStyle(document.documentElement).getPropertyValue("--font-ui").trim();
  }
  if (!labelCanvas) return Array.from(text).length * 0.6 * fontSize;
  labelCanvas.font = `${WHEEL_LABEL_WEIGHT} ${fontSize}px ${labelFamily || "system-ui, sans-serif"}`;
  return labelCanvas.measureText(text).width;
}

export interface WheelView {
  el: HTMLElement;
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
  /** Called when the user clicks the hub, the wheel's own Roll button. */
  onActivate?: () => void;
  /**
   * Called on a double-tap (or double-click) on a slice, with the outcome's
   * index and where the tap was. Left out, slices do nothing.
   */
  onSliceEdit?: (index: number, clientX: number, clientY: number) => void;
  size?: number;
  /** What a slice with a picture shows; left out, the picture. */
  slices?: () => SliceContent | undefined;
  /**
   * The colours slices take when their outcome has none of its own: three in
   * turn and a spare. Left out, the theme's (`state.wheelColours()`); a wheel
   * with its own palette passes `state.wheelColours(palette)`.
   */
  colours?: () => readonly string[];
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
  /** The last tap on a slice, to tell a double-tap from two single ones. */
  let lastTap: { index: number; at: number; x: number; y: number } | null = null;
  let tickerStrip: HTMLElement | null = null;

  function computeColors(): void {
    const items = opts.items();
    colorByIndex = assignWheelColours(items.map((i) => i.color ?? null), true, opts.colours?.() ?? state.wheelColours()).colors;
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
    // Pictures not yet cached are fetched together after the draw, and the wheel
    // is redrawn once, only if something arrived; redrawing for a picture that is
    // simply missing would loop forever.
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

    // What each slice holds, decided once: a picture only if already cached (one
    // still loading shows the name until the redraw), and never a name over a
    // picture.
    const content = opts.slices?.() ?? "pictures";
    const plan = new Map<number, SliceLayout>();
    for (const seg of segments) {
      const item = items[seg.index];
      let picture = false;
      if (item?.image && content !== "names") {
        picture = imageUrlSync(item.image) !== null;
        if (!picture) wanted.add(item.image);
      }
      plan.set(seg.index, sliceLayout(seg.endAngle - seg.startAngle, {
        radius, rim: labelEnd, hub: HUB_RADIUS + 6, picture, content, labels: showLabels,
      }));
    }

    // A picture on an outcome is drawn inside its slice, clipped to the wedge,
    // so a wheel of portraits can be recognised at a glance.
    const pictures = segments.flatMap((seg) => {
      const item = items[seg.index];
      const medallion = plan.get(seg.index)?.medallion;
      if (!item?.image || !medallion) return [];
      const url = imageUrlSync(item.image) as string;
      const key = `${opts.id()}-${seg.index}`.replace(/[^a-zA-Z0-9_-]/g, "");
      const [cxImg, cyImg] = pointOnCircle(cx, cy, medallion.centre, seg.midAngle);
      const side = medallion.side;
      // A round medallion, and the slice clipped around it: a square would
      // read as a sticker laid on the wheel.
      return [
        s("clipPath", { id: `slice-${key}` }, s("path", { d: arcPath(seg, cx, cy, radius) })),
        s("clipPath", { id: `disc-${key}` }, s("circle", { cx: String(cxImg), cy: String(cyImg), r: String(side / 2) })),
        s("g", { "clip-path": `url(#slice-${key})`, "data-index": String(seg.index) },
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

    const labels = segments.flatMap((seg) => {
      const item = items[seg.index];
      // No room means a sliver, or a slice its picture fills; the list beside
      // the wheel and the result panel say what it is instead.
      const room = plan.get(seg.index)?.label;
      if (!room) return [];
      const { ink } = labelFor(colorByIndex[seg.index] ?? "#888888");
      const text = fitLabelToWidth(showRefs(item.label), room.length, (t) => measureWheelLabel(t, room.fontSize));
      // Anchored at its outer end and running inwards along the radius,
      // reading outwards — horizontal once the slice is under the pointer.
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
    });

    rotor = s("g", { class: "wheel-rotor" }, ...paths, ...pictures, ...labels);
    applyRotation();

    // At three o'clock, pointing in at the centre (POINTER_ANGLE).
    const pointer = s("path", {
      class: "wheel-pointer",
      d: `M ${size - 2} ${cy - 10} L ${size - 2} ${cy + 10} L ${cx + pointerTip} ${cy} Z`,
      // Ink, not the accent: the wheel's yellow is close enough to the accent that
      // the pointer would all but vanish on a yellow slice.
      fill: "var(--ink)",
      stroke: "var(--bg-raised)",
      "stroke-width": "1.5",
    });

    // The hub: a circle, and when it rolls, a turning arrow to say so.
    const hub = s("g", { class: opts.onActivate ? "wheel-hub rolls" : "wheel-hub", onclick: () => opts.onActivate?.() },
      s("circle", { cx: String(cx), cy: String(cy), r: String(HUB_RADIUS), fill: "var(--bg-raised)", stroke: "var(--border-strong)" }),
      opts.onActivate ? rollMark() : null,
      opts.onActivate ? s("title", { text: "Roll" }) : null,
    );

    const svg = s(
      "svg",
      {
        class: opts.onSliceEdit ? "wheel-svg editable" : "wheel-svg",
        viewBox: `0 0 ${size} ${size}`,
        role: "img",
        "aria-label": `Wheel with ${segments.length} possible outcomes`,
      },
      s("circle", { cx: String(cx), cy: String(cy), r: String(radius + 2), fill: "var(--border)" }),
      rotor,
      hub,
      pointer,
    );
    svg.addEventListener("pointerup", (e) => sliceTap(e as PointerEvent));
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

  /** A circular arrow inside the hub: this is where the wheel is spun. */
  function rollMark(): SVGElement {
    const r = HUB_RADIUS * 0.5;
    const rad = (deg: number) => (deg * Math.PI) / 180;
    const start = rad(-60);
    const end = rad(210);
    const [x1, y1] = [cx + r * Math.cos(start), cy + r * Math.sin(start)];
    const [x2, y2] = [cx + r * Math.cos(end), cy + r * Math.sin(end)];
    // Clockwise on screen: the way ahead at the end is along (−sin, cos); the
    // head's barbs sit back from its tip, either side of the arc.
    const [tx, ty] = [-Math.sin(end), Math.cos(end)];
    const [nx, ny] = [Math.cos(end), Math.sin(end)];
    const tip = [x2 + tx * 3, y2 + ty * 3];
    const barb = (side: number) => [x2 - tx * 2 + nx * 3.5 * side, y2 - ty * 2 + ny * 3.5 * side];
    const [b1, b2] = [barb(1), barb(-1)];
    return s("g", { class: "wheel-roll-mark", fill: "none", stroke: "var(--ink-soft)", "stroke-width": "2.2", "stroke-linecap": "round", "stroke-linejoin": "round" },
      s("path", { d: `M ${x1} ${y1} A ${r} ${r} 0 1 1 ${x2} ${y2}` }),
      s("path", { d: `M ${b1[0]} ${b1[1]} L ${tip[0]} ${tip[1]} L ${b2[0]} ${b2[1]}` }),
    );
  }

  /**
   * A tap on a slice: the second one close in time and place on the same
   * slice is a double-tap, which opens its weight. Never while spinning — the
   * slice under the finger is moving — and never on the hub, which rolls.
   */
  function sliceTap(e: PointerEvent): void {
    if (!opts.onSliceEdit || cancelSpin) return;
    const hit = (e.target as Element | null)?.closest?.("[data-index]");
    if (!hit) {
      lastTap = null;
      return;
    }
    const index = Number(hit.getAttribute("data-index"));
    const now = performance.now();
    const again = lastTap && lastTap.index === index && now - lastTap.at < DOUBLE_TAP_MS
      && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 24;
    lastTap = again ? null : { index, at: now, x: e.clientX, y: e.clientY };
    if (again) opts.onSliceEdit(index, e.clientX, e.clientY);
  }

  function renderTicker(): HTMLElement {
    const items = opts.items().filter(isRollable);
    tickerStrip = h(
      "div",
      { class: "ticker-strip" },
      ...items.slice(0, 400).map((item, i) =>
        h("div", { class: "ticker-row", style: { background: i % 2 ? "var(--bg-raised)" : "transparent" } }, showRefs(item.label)),
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
   * Run an animation and hand back the way to cut it short. The wheel and the
   * ticker travel differently but wait the same way: a frame loop, a `skip` that
   * jumps to the end, and exactly one settle; `onDone` runs once.
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
      // Frames come from the wheel's own window, so it spins in any window (see
      // windowOf). Time is read here, not taken from the frame: a pop-out's frame
      // times count from when that window opened.
      const view = windowOf(el);
      const step = () => {
        if (done) return;
        const t = Math.min(1, (performance.now() - started) / durationMs);
        onFrame(t);
        if (t >= 1) finish();
        else view.requestAnimationFrame(step);
      };
      view.requestAnimationFrame(step);
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

    // The idle strip holds only the first rows of a long list, so rebuild it
    // around the winner before travelling, or the roll could land on a row that
    // does not exist.
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
