/**
 * The dice tray, in two styles: "flat", a numbered square, and "wireframe",
 * the real solid (a tetrahedron for four sides, a cube for six, and so on) drawn
 * with the Rosetta Code rotating-cube technique. The orientation is held as a
 * quaternion so the die can change axis mid-flight and still land flat (see
 * `src/core/polyhedra.ts`).
 *
 * The result is decided before the animation: the dice tumble through other
 * values, settle on the real ones, and can be skipped to the landing at any
 * moment.
 */

import { h, windowOf } from "../dom.ts";
import type { RollResult } from "../../core/dice/evaluate.ts";
import {
  bounceMs,
  diceDuration,
  diceWaves,
  motionScale,
  vibrate,
  WIREFRAME_DICE_LIMIT,
  type FeelSettings,
} from "../feel.ts";
import {
  bounceSchedule,
  pickTumbleAxes,
  project,
  quatFromAxisAngle,
  quatMultiply,
  quatNormalize,
  quatSlerp,
  restQuaternion,
  rotateVec,
  solidForSides,
  type Quat,
  type Solid,
  type Vec3,
} from "../../core/polyhedra.ts";

export interface DiceTray {
  el: HTMLElement;
  show(result: RollResult, feel: FeelSettings): Promise<void>;
  skip(): void;
}

interface TrayDie {
  value: number;
  kept: boolean;
  sides: number;
  /**
   * The lowest and highest this die can show. Not 1 and `sides`: a Fate die runs
   * -1 to +1.
   */
  faceMin: number;
  faceMax: number;
  fate: boolean;
  rerolled: boolean;
  exploded: boolean;
  /** Which throw it arrives in: 0 for the first. See `DieRoll.wave`. */
  wave: number;
  /**
   * Which face of the solid to rest on, from zero. Not `value - 1`: a Fate die's
   * value can be -1.
   */
  face: number;
}

/**
 * Fly each die in: all launch from one point below the tray's middle, scatter
 * to a random spot and arrive at their own slot, so the path is random but the
 * final order is not. Only transform is animated.
 */
function launch(tray: HTMLElement, wrappers: HTMLElement[], feel: FeelSettings, durationMs: number): void {
  const box = tray.getBoundingClientRect();
  const from = { x: box.left + box.width / 2, y: box.bottom + 30 };
  wrappers.forEach((w, i) => {
    const r = w.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const sx = from.x - cx;
    const sy = from.y - cy;
    const spread = feel.dice.spread;
    const mx = (Math.random() - 0.5) * box.width * 0.9 * spread + sx * 0.35;
    const my = -(20 + Math.random() * 70 * spread) - r.height * 0.3;
    w.style.setProperty("--sx", `${sx.toFixed(1)}px`);
    w.style.setProperty("--sy", `${sy.toFixed(1)}px`);
    w.style.setProperty("--mx", `${mx.toFixed(1)}px`);
    w.style.setProperty("--my", `${my.toFixed(1)}px`);
    w.style.setProperty("--flight", `${Math.round(durationMs)}ms`);
    w.style.animationDelay = `${Math.round(i * 30 * spread)}ms`;
    w.classList.add("flying");
  });
}

/**
 * The dice grouped by when they land, earliest first, each group with the
 * time it is thrown in. One group for an ordinary roll; more when something
 * exploded or was rerolled.
 */
function throwsOf(dice: TrayDie[], duration: number): { throwAt: number; landAt: number; indices: number[] }[] {
  const times = diceWaves(duration, dice.map((d) => d.wave));
  const byLanding = new Map<number, { throwAt: number; landAt: number; indices: number[] }>();
  times.forEach((t, i) => {
    const group = byLanding.get(t.landAt) ?? { throwAt: t.throwAt, landAt: t.landAt, indices: [] };
    group.indices.push(i);
    byLanding.set(t.landAt, group);
  });
  return [...byLanding.values()].sort((a, b) => a.landAt - b.landAt);
}

export function createDiceTray(): DiceTray {
  const el = h("div", { class: "dice-tray" });
  let finish: (() => void) | null = null;

  /**
   * How a die reads: dropped by a keep/drop, or a natural high or low. Shared by
   * both tray styles; only the base class differs.
   */
  const dieClasses = (die: TrayDie, base: string): string => {
    const classes = [base];
    // A rerolled die reads like a dropped one: it happened, it does not count.
    if (!die.kept) classes.push(die.rerolled ? "dropped rerolled" : "dropped");
    if (die.exploded) classes.push("exploded");
    if (die.kept && die.value === die.faceMax) classes.push("max");
    if (die.kept && die.value === die.faceMin) classes.push("min");
    return classes.join(" ");
  };

  /** What a face reads as: a Fate die is a sign, not a number. */
  const faceText = (die: TrayDie, value = die.value): string => {
    if (!die.fate) return String(value);
    return value > 0 ? "+" : value < 0 ? "−" : "0";
  };

  const titleFor = (die: TrayDie): string => {
    const what = die.fate
      ? `${die.value > 0 ? "plus" : die.value < 0 ? "minus" : "blank"} on a Fate die`
      : `${die.value} on a d${die.sides}`;
    if (die.rerolled) return `${what}, rerolled`;
    if (!die.kept) return `${die.value}, dropped`;
    return die.exploded ? `${what}, exploded` : what;
  };

  /** A face that is not the answer, for the tumble (cosmetic only). */
  const tumbleFace = (die: TrayDie): string =>
    die.fate ? faceText(die, Math.floor(Math.random() * 3) - 1) : String(1 + Math.floor(Math.random() * die.sides));

  /**
   * The wireframe dice this tray put in the animation loop. Every tray on the
   * page shares that loop (a board rolls several at once), so a tray may only
   * remove its own dice; clearing the whole set would freeze other trays' dice.
   */
  let mine: WireDie[] = [];

  /* ---- flat ------------------------------------------------------------- */

  function showFlat(dice: TrayDie[], feel: FeelSettings, duration: number, bounce: number): Promise<void> {
    const clock = windowOf(el);
    if (duration <= 0) {
      el.replaceChildren(
        ...dice.map((die) => h("div", { class: dieClasses(die, "die"), title: titleFor(die) }, faceText(die))),
      );
      return Promise.resolve();
    }

    // Tumble speed and face changes both follow the duration, so a quick roll looks
    // hurried rather than merely shorter.
    const tumbleCycle = Math.min(500, Math.max(140, duration / 3));
    const faceChange = Math.min(140, Math.max(45, duration / 10));

    const elements = dice.map((die) =>
      h("div", {
        class: "die rolling",
        style: {
          animationDelay: `${Math.round(Math.random() * 120 * feel.dice.spread)}ms`,
          animationDuration: `${Math.round(tumbleCycle)}ms`,
        } as Partial<CSSStyleDeclaration>,
        "aria-hidden": "true",
      }, tumbleFace(die)),
    );
    const wrappers = elements.map((e) => h("div", { class: "die-flight" }, e));
    el.replaceChildren(...wrappers);

    // A die an explosion or a reroll adds is not in the air until the throw
    // before it has landed: it waits, unseen, in the place it will land.
    const throws = throwsOf(dice, duration);
    const landed = new Set<number>();
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const t of throws) {
      const flight = t.indices.map((i) => wrappers[i]);
      if (t.throwAt === 0) {
        launch(el, flight, feel, t.landAt);
        continue;
      }
      for (const w of flight) w.classList.add("waiting");
      timers.push(clock.setTimeout(() => {
        for (const w of flight) w.classList.remove("waiting");
        launch(el, flight, feel, t.landAt - t.throwAt);
      }, t.throwAt));
    }

    const spin = clock.setInterval(() => {
      elements.forEach((node, i) => {
        if (!landed.has(i)) node.textContent = tumbleFace(dice[i]);
      });
    }, faceChange);

    return new Promise<void>((resolve) => {
      /** Put these dice down on their real faces. */
      const put = (indices: number[]) => {
        indices.forEach((i, n) => {
          if (landed.has(i)) return;
          landed.add(i);
          const node = elements[i];
          const die = dice[i];
          wrappers[i].classList.remove("flying", "waiting");
          node.className = dieClasses(die, "die");
          node.textContent = faceText(die);
          node.removeAttribute("aria-hidden");
          node.title = titleFor(die);
          if (bounce > 0) {
            node.style.setProperty("--bounce", `${bounce}ms`);
            node.style.animationDelay = `${Math.round(n * 25 * feel.dice.spread)}ms`;
            node.classList.add("landing");
          }
        });
        vibrate(feel, 12);
      };
      /** The last throw is down: the roll is over once its bounce is. */
      const done = (lastCount: number) => {
        clock.clearInterval(spin);
        for (const timer of timers) clock.clearTimeout(timer);
        finish = null;
        if (bounce > 0) clock.setTimeout(resolve, bounce + lastCount * 25 * feel.dice.spread);
        else resolve();
      };
      throws.forEach((t, k) => {
        timers.push(clock.setTimeout(() => {
          put(t.indices);
          if (k === throws.length - 1) done(t.indices.length);
        }, t.landAt));
      });
      // Skipping puts every die down at once, the later throws included.
      finish = () => {
        const rest = dice.map((_, i) => i).filter((i) => !landed.has(i));
        put(rest);
        done(rest.length);
      };
    });
  }

  /* ---- wireframe -------------------------------------------------------- */

  function showWireframe(dice: TrayDie[], feel: FeelSettings, duration: number, bounce: number): Promise<void> {
    const clock = windowOf(el);
    const colours = readColours();
    const size = 92;
    const dpr = Math.min(3, globalThis.devicePixelRatio || 1);

    const slots = dice.map((die) => {
      const canvas = h("canvas", {
        class: "die-canvas",
        width: String(Math.round(size * dpr)),
        height: String(Math.round(size * dpr)),
        style: { width: `${size}px`, height: `${size}px` } as Partial<CSSStyleDeclaration>,
        "aria-hidden": "true",
      });
      const value = h("span", { class: "die-value" });
      const stage = h("div", { class: "die-stage" }, canvas, value);
      const caption = h("span", { class: "die-caption" });
      const slot = h("div", { class: "die-slot rolling", title: titleFor(die) }, stage, caption);
      const flight = h("div", { class: "die-flight" }, slot);
      return { slot, stage, canvas, value, caption, flight };
    });
    el.replaceChildren(...slots.map((s) => s.flight));

    // As in the flat tray: a later throw waits, unseen, where it will land.
    const throws = throwsOf(dice, duration);
    const timing = new Map<number, { throwAt: number; landAt: number }>();
    for (const t of throws) for (const i of t.indices) timing.set(i, t);
    const timers: ReturnType<typeof setTimeout>[] = [];
    if (duration > 0) {
      for (const t of throws) {
        const flight = t.indices.map((i) => slots[i].flight);
        if (t.throwAt === 0) {
          launch(el, flight, feel, t.landAt);
          continue;
        }
        for (const f of flight) f.classList.add("waiting");
        timers.push(clock.setTimeout(() => {
          for (const f of flight) f.classList.remove("waiting");
          launch(el, flight, feel, t.landAt - t.throwAt);
        }, t.throwAt));
      }
    }

    const start = performance.now();
    const wires: WireDie[] = dice.map((die, i) => {
      const solid = solidForSides(die.sides);
      const axes = pickTumbleAxes(solid);
      // Each die tumbles for its own flight: the whole duration for the first
      // throw, the gap before it lands for a later one.
      const when = timing.get(i) ?? { throwAt: 0, landAt: duration };
      const flight = Math.max(1, when.landAt - when.throwAt);
      // Two or three whole turns across the tumble, so the die reads as
      // rolling rather than shivering, whatever the duration is set to.
      const turns = 2 + Math.random() * 1.5;
      const base = (Math.PI * 2 * turns) / Math.max(0.2, flight / 1000);
      const from = start + when.throwAt;
      const schedule = bounceSchedule(flight, feel.dice.bounces);
      return {
        canvas: slots[i].canvas,
        ctx: slots[i].canvas.getContext("2d"),
        dpr,
        solid,
        q: quatFromAxisAngle(axes[0], Math.random() * Math.PI * 2),
        axes,
        speeds: [base * (Math.random() < 0.5 ? -1 : 1), base * 0.65 * (Math.random() < 0.5 ? -1 : 1)],
        bounceAt: schedule.bounceAt.map((t) => from + t),
        nextBounce: 0,
        nextAxis: 0,
        settleFrom: null,
        settleStart: from + schedule.settleStart,
        settleEnd: from + schedule.settleEnd,
        // Resting square-on to the viewer, allowing for the camera tilt, so
        // the face is seen undistorted and its number can sit inside it.
        rest: restQuaternion(solid, die.face % solid.faces.length, Math.random() * Math.PI * 2, VIEW_TILT),
        ink: colours.ink,
        accent: colours.accent,
        radius: size * 0.34,
        faceIndex: die.face % solid.faces.length,
        landed: false,
      };
    });

    // One number size for the whole tray, set by the smallest face, so mixed dice
    // read as a set. Worked out once, at the first landing, so a later throw does
    // not resize numbers already down.
    let fits: ReturnType<typeof fitValueToFace>[] | null = null;
    let fitSize = Infinity;

    /** Put these dice down on their real faces. */
    const reveal = (indices: number[]) => {
      if (!fits) {
        fits = wires.map((wire, i) => fitValueToFace(wire, slots[i].value));
        fitSize = Math.min(...fits.map((f) => f?.size ?? Infinity));
      }
      indices.forEach((i, n) => {
        const wire = wires[i];
        if (wire.landed) return;
        const die = dice[i];
        active.delete(wire);
        wire.q = wire.rest;
        wire.landed = true;
        draw(wire);
        slots[i].flight.classList.remove("flying", "waiting");
        slots[i].slot.className = dieClasses(die, "die-slot");
        slots[i].value.textContent = faceText(die);
        slots[i].caption.textContent = faceText(die);
        const fit = fits![i];
        if (fit) {
          const label = slots[i].value;
          label.style.fontSize = `${Math.max(8, Number.isFinite(fitSize) ? fitSize : fit.size).toFixed(1)}px`;
          placeOnFace(label, fit.centre);
        }
        if (bounce > 0) {
          slots[i].stage.style.setProperty("--bounce", `${bounce}ms`);
          slots[i].stage.style.animationDelay = `${Math.round(n * 25 * feel.dice.spread)}ms`;
          slots[i].stage.classList.add("landing");
        }
      });
    };

    mine = wires;

    if (duration <= 0) {
      reveal(dice.map((_, i) => i));
      return Promise.resolve();
    }

    for (const wire of wires) active.add(wire);
    ensureLoop();

    return new Promise<void>((resolve) => {
      const done = (lastCount: number) => {
        for (const timer of timers) clock.clearTimeout(timer);
        finish = null;
        if (bounce > 0) clock.setTimeout(resolve, bounce + lastCount * 25 * feel.dice.spread);
        else resolve();
      };
      throws.forEach((t, k) => {
        timers.push(clock.setTimeout(() => {
          reveal(t.indices);
          vibrate(feel, 12);
          if (k === throws.length - 1) done(t.indices.length);
        }, t.landAt));
      });
      // Skipping puts every die down at once, the later throws included.
      finish = () => {
        const rest = wires.map((_, i) => i).filter((i) => !wires[i].landed);
        reveal(rest);
        vibrate(feel, 12);
        done(rest.length);
      };
    });
  }

  return {
    el,
    show(result, feel) {
      const dice: TrayDie[] = result.terms.flatMap((t) =>
        (t.dice ?? []).map((d) => ({
          value: d.value,
          kept: d.kept,
          sides: t.sides!,
          faceMin: t.faceMin ?? 1,
          faceMax: t.faceMax ?? t.sides!,
          fate: t.fate === true,
          rerolled: d.rerolled === true,
          exploded: d.exploded === true,
          wave: d.wave ?? 0,
          // Fate runs -1..1, so its zero-based face is value + 1.
          face: t.fate ? d.value + 1 : d.value - 1,
        })),
      );
      const shown = dice.slice(0, 40);
      const duration = motionScale(feel.motion) === 0 ? 0 : diceDuration(feel);
      const bounce = bounceMs(feel);
      // Forty spinning solids is a lot of work for a phone, and forty tiny
      // wireframes are unreadable anyway, so a big handful stays flat.
      const wireframe = feel.dice.style === "wireframe" && shown.length <= WIREFRAME_DICE_LIMIT;
      for (const wire of mine) active.delete(wire);
      mine = [];
      return wireframe ? showWireframe(shown, feel, duration, bounce) : showFlat(shown, feel, duration, bounce);
    },
    skip() {
      finish?.();
    },
  };
}

/* -------------------------------------------------------------------------- */
/* wireframe dice                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A wireframe die in flight. It spins about two of the solid's diagonals at
 * once; each bounce swaps one axis for another diagonal with a new speed, so the
 * motion never reads as one mechanical spin. Through the last bounce it eases
 * into a resting pose with a face flat and level.
 */
interface WireDie {
  canvas: HTMLCanvasElement;
  /**
   * Cached: `draw` runs per die per frame, and reading `clientWidth` forces a
   * layout.
   */
  ctx: CanvasRenderingContext2D | null;
  dpr: number;
  solid: Solid;
  /** Current orientation. */
  q: Quat;
  /** The two axes it is spinning about, and their speeds in radians a second. */
  axes: [Vec3, Vec3];
  speeds: [number, number];
  /** Times, in ms from the start, at which a bounce changes an axis. */
  bounceAt: number[];
  /** Index of the next bounce to apply. */
  nextBounce: number;
  /** Which axis the next bounce changes; alternates. */
  nextAxis: 0 | 1;
  /** Which face it will come to rest showing. */
  faceIndex: number;
  /** Once settled, that face is outlined so it is clear which one is read. */
  landed: boolean;
  /** When the final settle begins and where it starts from. */
  settleFrom: Quat | null;
  settleStart: number;
  settleEnd: number;
  rest: Quat;
  ink: string;
  accent: string;
  radius: number;
}

/**
 * The camera looks slightly down at the dice, the way you look at a table.
 * Without it a die at rest — which by definition has a face pointing straight
 * up — is seen exactly edge-on, and its top face is invisible.
 */
const VIEW_TILT = quatFromAxisAngle([1, 0, 0], 0.42);

const active = new Set<WireDie>();
let frameHandle: number | null = null;
let lastFrame = 0;

function pump(): void {
  // This page's clock, not the frame's timestamp: frames may come from a
  // pop-out, whose timestamps count from when that window opened.
  const now = performance.now();
  const dt = lastFrame === 0 ? 16 : Math.min(64, now - lastFrame);
  lastFrame = now;
  for (const die of active) step(die, now, dt / 1000);
  frameHandle = active.size > 0 ? frameSource().requestAnimationFrame(pump) : null;
  if (active.size === 0) lastFrame = 0;
}

/**
 * The window to take frames from. One loop draws every tumbling die; when some
 * are in a pop-out and the main window is hidden, frames must come from the
 * window still on screen, or its dice stop mid-air.
 */
function frameSource(): Window {
  for (const die of active) {
    const view = windowOf(die.canvas);
    if (view.document.visibilityState === "visible") return view;
  }
  return window;
}

function ensureLoop(): void {
  if (frameHandle === null) frameHandle = frameSource().requestAnimationFrame(pump);
}

function step(die: WireDie, now: number, dt: number): void {
  if (now >= die.settleEnd) {
    die.q = die.rest;
    draw(die);
    active.delete(die);
    return;
  }

  if (now >= die.settleStart) {
    // The last bounce: ease from wherever the tumble had got to onto the
    // resting pose, so the die arrives flat instead of stopping dead.
    if (!die.settleFrom) die.settleFrom = die.q;
    const t = (now - die.settleStart) / (die.settleEnd - die.settleStart);
    // Smooth ease-out, no overshoot: the die is coming to rest, and the hop is
    // the wrapper's job.
    die.q = quatSlerp(die.settleFrom, die.rest, 1 - (1 - t) ** 3);
    draw(die);
    return;
  }

  while (die.nextBounce < die.bounceAt.length && now >= die.bounceAt[die.nextBounce]) {
    const axis = die.nextAxis;
    die.axes[axis] = die.solid.diagonals[Math.floor(Math.random() * die.solid.diagonals.length)];
    // Each bounce takes some energy out, and can reverse the spin.
    die.speeds[axis] = die.speeds[axis] * (0.55 + Math.random() * 0.3) * (Math.random() < 0.35 ? -1 : 1);
    die.nextAxis = axis === 0 ? 1 : 0;
    die.nextBounce++;
  }

  const a = quatFromAxisAngle(die.axes[0], die.speeds[0] * dt);
  const b = quatFromAxisAngle(die.axes[1], die.speeds[1] * dt);
  die.q = quatNormalize(quatMultiply(die.q, quatMultiply(a, b)));
  draw(die);
}

function draw(die: WireDie): void {
  const ctx = die.ctx;
  if (!ctx) return;
  const dpr = die.dpr;
  const w = die.canvas.width;
  const h = die.canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.setTransform(dpr, 0, 0, dpr, w / 2, h / 2);

  const orientation = quatMultiply(VIEW_TILT, die.q);
  const points = die.solid.vertices.map((v) => project(rotateVec(orientation, v), die.radius));

  // Far edges first and fainter, so the solid reads as three-dimensional
  // without any shading.
  const edges = die.solid.edges
    .map(([a, b]) => ({ a, b, depth: (points[a].z + points[b].z) / 2 }))
    .sort((x, y) => x.depth - y.depth);

  ctx.lineCap = "round";
  for (const edge of edges) {
    const near = (edge.depth + 1) / 2; // 0 far, 1 near
    ctx.globalAlpha = 0.28 + near * 0.72;
    ctx.lineWidth = 0.9 + near * 0.8;
    ctx.strokeStyle = die.ink;
    ctx.beginPath();
    ctx.moveTo(points[edge.a].x, points[edge.a].y);
    ctx.lineTo(points[edge.b].x, points[edge.b].y);
    ctx.stroke();
  }

  // Once it has settled, outline the face being read: a wireframe is
  // see-through, so without this it is not obvious which polygon the number
  // belongs to.
  if (die.landed) {
    const face = die.solid.faces[die.faceIndex];
    if (face && face.length >= 3) {
      const centre = face.reduce(
        (a, i) => ({ x: a.x + points[i].x / face.length, y: a.y + points[i].y / face.length }),
        { x: 0, y: 0 },
      );
      const ordered = [...face].sort(
        (a, b) =>
          Math.atan2(points[a].y - centre.y, points[a].x - centre.x) -
          Math.atan2(points[b].y - centre.y, points[b].x - centre.x),
      );
      ctx.globalAlpha = 1;
      ctx.lineWidth = 2;
      ctx.strokeStyle = die.accent;
      ctx.beginPath();
      ordered.forEach((i, n) => (n === 0 ? ctx.moveTo(points[i].x, points[i].y) : ctx.lineTo(points[i].x, points[i].y)));
      ctx.closePath();
      ctx.stroke();
    }
  }

  ctx.fillStyle = die.accent;
  for (const p of points) {
    if (p.z < 0) continue;
    ctx.globalAlpha = 0.35 + ((p.z + 1) / 2) * 0.65;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 1.7, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/**
 * Centre a die's number on its face by the digits actually drawn, not their
 * box: in some fonts "13" sits lower than "8", so a centred box hangs low. If
 * the dice font is still loading, the number is placed again once it arrives.
 */
let inkContext: CanvasRenderingContext2D | null | undefined;
function placeOnFace(label: HTMLElement, centre: { x: number; y: number }): void {
  const ink = inkOffset(label);
  label.style.transform = `translate(${(centre.x - ink.x).toFixed(1)}px, ${(centre.y - ink.y).toFixed(1)}px)`;
  if (!ink.fontReady) void document.fonts?.load(ink.font, label.textContent ?? "").then(() => {
    const again = inkOffset(label);
    label.style.transform = `translate(${(centre.x - again.x).toFixed(1)}px, ${(centre.y - again.y).toFixed(1)}px)`;
  }, () => {});
}

function inkOffset(label: HTMLElement): { x: number; y: number; font: string; fontReady: boolean } {
  if (inkContext === undefined) inkContext = document.createElement("canvas").getContext("2d");
  const text = label.textContent ?? "";
  const style = getComputedStyle(label);
  const font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const fontReady = document.fonts?.check(font, text) ?? true;
  if (!inkContext || !text) return { x: 0, y: 0, font, fontReady };
  inkContext.font = font;
  const m = inkContext.measureText(text);
  // With line-height 1 the baseline sits (ascent - descent) / 2 below the
  // middle of the box; the ink's middle is measured from that baseline.
  const baseline = (m.fontBoundingBoxAscent - m.fontBoundingBoxDescent) / 2;
  const y = baseline + (m.actualBoundingBoxDescent - m.actualBoundingBoxAscent) / 2;
  const x = (m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2 - m.width / 2;
  return { x, y, font, fontReady };
}

function fitValueToFace(die: WireDie, label: HTMLElement): { size: number; centre: { x: number; y: number } } | null {
  const face = die.solid.faces[die.faceIndex];
  if (!face || face.length < 3) return null;
  // The number is half the face's mean side (a kite's sides differ), measured on
  // the resting pose, not the current one: with dice landing in throws this runs
  // before every die has come to rest.
  const orientation = quatMultiply(VIEW_TILT, die.rest);
  const points = face.map((i) => {
    const p = project(rotateVec(orientation, die.solid.vertices[i]), die.radius);
    return { x: p.x, y: p.y };
  });

  const centre = points.reduce(
    (a, p) => ({ x: a.x + p.x / points.length, y: a.y + p.y / points.length }),
    { x: 0, y: 0 },
  );
  // Walk the vertices round the centre so that consecutive ones are the
  // polygon's actual sides; the face list is a set, not a loop.
  const ordered = [...points].sort(
    (a, b) => Math.atan2(a.y - centre.y, a.x - centre.x) - Math.atan2(b.y - centre.y, b.x - centre.x),
  );

  let sideTotal = 0;
  let inradius = Infinity;
  for (let i = 0; i < ordered.length; i++) {
    const a = ordered[i];
    const b = ordered[(i + 1) % ordered.length];
    const side = Math.hypot(b.x - a.x, b.y - a.y);
    sideTotal += side;
    if (side > 0) {
      // Distance from the centre to this side; the smallest is the inscribed radius.
      const area = Math.abs((b.x - a.x) * (a.y - centre.y) - (a.x - centre.x) * (b.y - a.y));
      inradius = Math.min(inradius, area / side);
    }
  }
  const meanSide = sideTotal / ordered.length;
  if (!Number.isFinite(meanSide) || meanSide <= 0 || !Number.isFinite(inradius)) return null;

  let size = meanSide * 0.5;
  const digits = (label.textContent ?? "").length;
  if (digits > 1) {
    // Two or more digits must also fit the inscribed circle; 0.62 is a rough
    // advance width per digit at font-size 1.
    const width = size * 0.62 * digits;
    const room = inradius * 1.7;
    if (width > room) size *= room / width;
  }

  return { size, centre };
}

function readColours(): { ink: string; accent: string } {
  const style = getComputedStyle(document.documentElement);
  return {
    ink: style.getPropertyValue("--ink").trim() || "#23201c",
    accent: style.getPropertyValue("--accent").trim() || "#c96a1f",
  };
}
