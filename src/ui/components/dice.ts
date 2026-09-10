/**
 * The dice tray and the coin.
 *
 * Two dice styles. "flat" is the plain numbered square. "wireframe" draws the
 * die as the solid it actually is — a tetrahedron for a d4, a cube for a d6,
 * an octahedron, a pentagonal trapezohedron for the ten-siders, a dodecahedron
 * and an icosahedron — using the vertices-edges-project-draw technique from
 * the Rosetta Code rotating cube, with the orientation held as a quaternion so
 * the die can change axis mid-flight and still land flat (see
 * `src/core/polyhedra.ts`).
 *
 * Neither gives the answer away while it is moving: the dice cycle through
 * changing values and settle onto the real ones, and the coin shows nothing
 * until it lands. Both finish with a bounce whose size follows the Settle
 * setting, and both can be skipped straight to the landing at any moment —
 * the result was decided before the animation began.
 */

import { h } from "../dom.ts";
import type { RollResult } from "../../core/dice/evaluate.ts";
import {
  bounceMs,
  coinDuration,
  diceDuration,
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
}

/**
 * Put each die in a wrapper that flies it in. All dice launch from one point
 * below the middle of the tray, scatter to a random spot on the way, and
 * arrive at their own slot — so the scatter is random but the order they end
 * up in is not. Only transform is animated.
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

export function createDiceTray(): DiceTray {
  const el = h("div", { class: "dice-tray" });
  let finish: (() => void) | null = null;

  const classesFor = (die: TrayDie): string => {
    const classes = ["die"];
    if (!die.kept) classes.push("dropped");
    if (die.kept && die.value === die.sides) classes.push("max");
    if (die.kept && die.value === 1) classes.push("min");
    return classes.join(" ");
  };

  const slotClasses = (die: TrayDie): string => {
    const classes = ["die-slot"];
    if (!die.kept) classes.push("dropped");
    if (die.kept && die.value === die.sides) classes.push("max");
    if (die.kept && die.value === 1) classes.push("min");
    return classes.join(" ");
  };

  const titleFor = (die: TrayDie): string =>
    die.kept ? `${die.value} on a d${die.sides}` : `${die.value}, dropped`;

  /* ---- flat ------------------------------------------------------------- */

  function showFlat(dice: TrayDie[], feel: FeelSettings, duration: number, bounce: number): Promise<void> {
    if (duration <= 0) {
      el.replaceChildren(
        ...dice.map((die) => h("div", { class: classesFor(die), title: titleFor(die) }, String(die.value))),
      );
      return Promise.resolve();
    }

    // Tumbling: faces showing values that are not the answer. How fast they
    // tumble and how often the numbers change both come from the settings,
    // so a quick roll looks hurried rather than merely shorter.
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
      }, String(1 + Math.floor(Math.random() * die.sides))),
    );
    const wrappers = elements.map((e) => h("div", { class: "die-flight" }, e));
    el.replaceChildren(...wrappers);
    launch(el, wrappers, feel, duration);

    const spin = setInterval(() => {
      elements.forEach((node, i) => {
        node.textContent = String(1 + Math.floor(Math.random() * dice[i].sides));
      });
    }, faceChange);

    return new Promise<void>((resolve) => {
      const land = () => {
        clearInterval(spin);
        clearTimeout(timer);
        elements.forEach((node, i) => {
          const die = dice[i];
          wrappers[i].classList.remove("flying");
          node.className = classesFor(die);
          node.textContent = String(die.value);
          node.removeAttribute("aria-hidden");
          node.title = titleFor(die);
          if (bounce > 0) {
            node.style.setProperty("--bounce", `${bounce}ms`);
            node.style.animationDelay = `${Math.round(i * 25 * feel.dice.spread)}ms`;
            node.classList.add("landing");
          }
        });
        vibrate(feel, 12);
        finish = null;
        if (bounce > 0) setTimeout(resolve, bounce + dice.length * 25 * feel.dice.spread);
        else resolve();
      };
      finish = land;
      const timer = setTimeout(land, duration);
    });
  }

  /* ---- wireframe -------------------------------------------------------- */

  function showWireframe(dice: TrayDie[], feel: FeelSettings, duration: number, bounce: number): Promise<void> {
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
    if (duration > 0) launch(el, slots.map((s) => s.flight), feel, duration);

    const wires: WireDie[] = dice.map((die, i) => {
      const solid = solidForSides(die.sides);
      const axes = pickTumbleAxes(solid);
      // Two or three whole turns across the tumble, so the die reads as
      // rolling rather than shivering, whatever the duration is set to.
      const turns = 2 + Math.random() * 1.5;
      const base = (Math.PI * 2 * turns) / Math.max(0.2, duration / 1000);
      const now = performance.now();
      const schedule = bounceSchedule(duration, feel.dice.bounces);
      return {
        canvas: slots[i].canvas,
        solid,
        q: quatFromAxisAngle(axes[0], Math.random() * Math.PI * 2),
        axes,
        speeds: [base * (Math.random() < 0.5 ? -1 : 1), base * 0.65 * (Math.random() < 0.5 ? -1 : 1)],
        bounceAt: schedule.bounceAt.map((t) => now + t),
        nextBounce: 0,
        nextAxis: 0,
        settleFrom: null,
        settleStart: now + schedule.settleStart,
        settleEnd: now + schedule.settleEnd,
        // Resting square-on to the viewer, allowing for the camera tilt, so
        // the face is seen undistorted and its number can sit inside it.
        rest: restQuaternion(solid, die.value - 1, Math.random() * Math.PI * 2, VIEW_TILT),
        ink: colours.ink,
        accent: colours.accent,
        radius: size * 0.34,
        faceIndex: (die.value - 1) % solid.faces.length,
        landed: false,
      };
    });

    const reveal = () => {
      wires.forEach((wire, i) => {
        const die = dice[i];
        active.delete(wire);
        wire.q = wire.rest;
        wire.landed = true;
        draw(wire);
        slots[i].flight.classList.remove("flying");
        slots[i].slot.className = slotClasses(die);
        slots[i].value.textContent = String(die.value);
        slots[i].caption.textContent = String(die.value);
      });
      // One size for every number in the tray, comfortable in the smallest
      // face present, so a d12 beside a d6 reads as a set rather than a
      // jumble of type sizes.
      const fits = wires.map((wire, i) => fitValueToFace(wire, slots[i].value));
      const size = Math.min(...fits.map((f) => f?.size ?? Infinity));
      fits.forEach((fit, i) => {
        if (!fit) return;
        slots[i].value.style.fontSize = `${Math.max(8, Number.isFinite(size) ? size : fit.size).toFixed(1)}px`;
        slots[i].value.style.transform = `translate(${fit.centre.x.toFixed(1)}px, ${fit.centre.y.toFixed(1)}px)`;
      });
      wires.forEach((_, i) => {
        if (bounce > 0) {
          slots[i].stage.style.setProperty("--bounce", `${bounce}ms`);
          slots[i].stage.style.animationDelay = `${Math.round(i * 25 * feel.dice.spread)}ms`;
          slots[i].stage.classList.add("landing");
        }
      });
    };

    if (duration <= 0) {
      reveal();
      return Promise.resolve();
    }

    for (const wire of wires) active.add(wire);
    ensureLoop();

    return new Promise<void>((resolve) => {
      const land = () => {
        clearTimeout(timer);
        reveal();
        vibrate(feel, 12);
        finish = null;
        if (bounce > 0) setTimeout(resolve, bounce + dice.length * 25 * feel.dice.spread);
        else resolve();
      };
      finish = land;
      const timer = setTimeout(land, duration);
    });
  }

  return {
    el,
    show(result, feel) {
      const dice: TrayDie[] = result.terms.flatMap((t) =>
        (t.dice ?? []).map((d) => ({ value: d.value, kept: d.kept, sides: t.sides! })),
      );
      const shown = dice.slice(0, 40);
      const duration = motionScale(feel.motion) === 0 ? 0 : diceDuration(feel);
      const bounce = bounceMs(feel);
      // Forty spinning solids is a lot of work for a phone, and forty tiny
      // wireframes are unreadable anyway, so a big handful stays flat.
      const wireframe = feel.dice.style === "wireframe" && shown.length <= WIREFRAME_DICE_LIMIT;
      active.clear();
      return wireframe ? showWireframe(shown, feel, duration, bounce) : showFlat(shown, feel, duration, bounce);
    },
    skip() {
      finish?.();
    },
  };
}

export interface CoinView {
  el: HTMLElement;
  show(face: string, feel: FeelSettings): Promise<void>;
  skip(): void;
}

export function createCoin(): CoinView {
  const disc = h("div", { class: "coin" }, "?");
  const flight = h("div", { class: "coin-flight" }, disc);
  const el = h("div", { class: "coin-wrap" }, flight);
  let finish: (() => void) | null = null;

  return {
    el,
    show(face, feel) {
      const duration = coinDuration(feel);
      const bounce = bounceMs(feel);
      if (duration <= 0 || motionScale(feel.motion) === 0) {
        disc.className = "coin";
        flight.className = "coin-flight";
        disc.textContent = face;
        return Promise.resolve();
      }

      // The toss: the coin rises along a parabola, shrinking as it goes away,
      // spinning about its own axis the whole time, and comes back down to
      // where it started. Only transforms are animated.
      disc.textContent = "";
      disc.className = "coin";
      flight.className = "coin-flight";
      void disc.offsetWidth; // restart the animations
      const size = disc.getBoundingClientRect().height || 96;
      disc.style.setProperty("--coin-duration", `${duration}ms`);
      disc.style.setProperty("--coin-flips", String(feel.coin.flips));
      flight.style.setProperty("--coin-duration", `${duration}ms`);
      flight.style.setProperty("--arc-h", `${(feel.coin.arc * size).toFixed(0)}px`);
      flight.style.setProperty("--travel", `${(feel.coin.arc > 0 ? size * 0.9 : 0).toFixed(0)}px`);
      flight.style.setProperty("--shrink", String(feel.coin.arc > 0 ? 0.62 : 1));
      disc.classList.add("flipping");
      flight.classList.add("tossing");

      return new Promise<void>((resolve) => {
        const land = () => {
          clearTimeout(timer);
          disc.classList.remove("flipping");
          flight.classList.remove("tossing");
          disc.textContent = face;
          vibrate(feel, 12);
          finish = null;
          if (bounce > 0) {
            flight.style.setProperty("--bounce", `${bounce}ms`);
            void flight.offsetWidth;
            flight.classList.add("landing");
            setTimeout(resolve, bounce);
          } else {
            resolve();
          }
        };
        finish = land;
        const timer = setTimeout(land, duration);
      });
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
 * How a wireframe die tumbles.
 *
 * It spins about two of the solid's own diagonals at once. At every bounce one
 * of those two axes is swapped for another diagonal and given a new speed —
 * the other carries on — which is what stops the motion reading as a single
 * mechanical spin. Through the last bounce the orientation is interpolated
 * into a resting pose with a face flat and level, so the die ends the way a
 * real one does rather than frozen mid-tumble.
 */
interface WireDie {
  canvas: HTMLCanvasElement;
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

function pump(now: number): void {
  const dt = lastFrame === 0 ? 16 : Math.min(64, now - lastFrame);
  lastFrame = now;
  for (const die of active) step(die, now, dt / 1000);
  frameHandle = active.size > 0 ? requestAnimationFrame(pump) : null;
  if (active.size === 0) lastFrame = 0;
}

function ensureLoop(): void {
  if (frameHandle === null) frameHandle = requestAnimationFrame(pump);
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
  const ctx = die.canvas.getContext("2d");
  if (!ctx) return;
  const dpr = die.canvas.width / die.canvas.clientWidth || 1;
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
 * Size and place the number so it sits inside the face the die came to rest
 * showing: half the length of one of that face's sides, centred on it.
 *
 * The measurement is taken from the projected vertices rather than worked out
 * from the geometry, so it is right whatever the solid, the camera or the die
 * size happen to be. Two refinements to the plain rule, both of which only
 * ever make the number smaller:
 *
 *  - a kite has two short sides and two long ones, so the mean side is used;
 *    on a regular face every side is the same and the rule is unchanged;
 *  - a number of more than one digit is shrunk until it fits within the
 *    face's inscribed circle, because half a side of a triangle is wider than
 *    a triangle has room for once there are two digits in it.
 */
function fitValueToFace(die: WireDie, label: HTMLElement): { size: number; centre: { x: number; y: number } } | null {
  const face = die.solid.faces[die.faceIndex];
  if (!face || face.length < 3) return null;
  const orientation = quatMultiply(VIEW_TILT, die.q);
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
      // Distance from the centre to this side.
      const area = Math.abs((b.x - a.x) * (a.y - centre.y) - (a.x - centre.x) * (b.y - a.y));
      inradius = Math.min(inradius, area / side);
    }
  }
  const meanSide = sideTotal / ordered.length;
  if (!Number.isFinite(meanSide) || meanSide <= 0 || !Number.isFinite(inradius)) return null;

  let size = meanSide * 0.5;
  const digits = (label.textContent ?? "").length;
  if (digits > 1) {
    // Rough advance width per digit for the interface font, at font-size 1.
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
