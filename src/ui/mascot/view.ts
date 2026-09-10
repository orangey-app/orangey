/**
 * Draws a MascotFrame into the SVG. Nothing here decides anything; it writes
 * attributes. Ten-odd setAttribute calls per frame on one small SVG.
 */

import { MASCOT_FEET_X, MASCOT_FEET_Y, type MascotFrame } from "./model.ts";
import {
  MASCOT_LIMB_KEYS,
  MASCOT_MOUTH_CENTRE,
  MASCOT_MOUTH_KEYS,
  MASCOT_PIVOT,
  mascotMarkup,
  type LimbKey,
  type MouthKey,
} from "./parts.ts";

const f2 = (n: number) => n.toFixed(2);

export class MascotView {
  readonly el: HTMLElement;
  readonly svg: SVGSVGElement;
  #root: SVGGElement;
  #body: SVGPathElement;
  #stem: SVGGElement;
  #eyeGroup: Record<"L" | "R", SVGGElement>;
  #eyeEl: Record<"L" | "R", SVGEllipseElement>;
  #mouth: Record<MouthKey, SVGGElement>;
  #limb: Record<LimbKey, SVGGElement>;
  #lastPose = "";

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "mascot";
    this.el.setAttribute("aria-hidden", "true");
    this.el.innerHTML = mascotMarkup();
    this.svg = this.el.firstElementChild as SVGSVGElement;
    const q = <T extends Element>(sel: string) => this.svg.querySelector(sel) as T;
    this.#root = q(".root");
    this.#body = q(".body");
    this.#stem = q(".stem");
    this.#eyeGroup = { L: q(".eyeL"), R: q(".eyeR") };
    this.#eyeEl = { L: q(".eyeL-el"), R: q(".eyeR-el") };
    this.#mouth = {} as Record<MouthKey, SVGGElement>;
    for (const k of MASCOT_MOUTH_KEYS) this.#mouth[k] = q(`.mouth.${k}`);
    this.#limb = {} as Record<LimbKey, SVGGElement>;
    for (const k of MASCOT_LIMB_KEYS) this.#limb[k] = q(k === "L" ? ".legL" : k === "R" ? ".legR" : `.arm${k}`);
  }

  draw(frame: MascotFrame): void {
    if (frame.pose !== this.#lastPose) {
      this.#lastPose = frame.pose;
      this.svg.setAttribute("data-pose", frame.pose);
    }
    this.#body.setAttribute("d", frame.bodyPath);
    this.#root.setAttribute("transform", `translate(0,${f2(frame.offsetY)}) rotate(${f2(frame.tilt)} ${MASCOT_FEET_X} ${MASCOT_FEET_Y})`);
    this.#stem.setAttribute("transform", `translate(${f2(frame.stem.dx)},${f2(frame.stem.dy)}) rotate(${f2(frame.stem.rot)} 75.82 42.07)`);
    for (const side of ["L", "R"] as const) {
      const e = frame.eyes[side];
      const el = this.#eyeEl[side];
      el.setAttribute("cx", f2(e.cx));
      el.setAttribute("cy", f2(e.cy));
      el.setAttribute("transform", `rotate(${f2(e.rot)} ${f2(e.cx)} ${f2(e.cy)})`);
      this.#eyeGroup[side].setAttribute(
        "transform",
        `translate(${f2(e.dx)},${f2(e.dy)}) translate(${f2(e.cx)},${f2(e.cy)}) scale(${e.scale.toFixed(3)}) translate(${f2(-e.cx)},${f2(-e.cy)})`,
      );
    }
    for (const k of MASCOT_MOUTH_KEYS) {
      const m = frame.mouths[k];
      const [cx, cy] = MASCOT_MOUTH_CENTRE[k];
      this.#mouth[k].setAttribute(
        "transform",
        `translate(${f2(m.dx)},${f2(m.dy)}) translate(${cx},${cy}) scale(${m.scale.toFixed(3)}) translate(${-cx},${-cy})`,
      );
    }
    for (const k of MASCOT_LIMB_KEYS) {
      const [px, py] = MASCOT_PIVOT[k];
      this.#limb[k].setAttribute("transform", `rotate(${f2(frame.limbs[k])} ${px} ${py})`);
    }
  }

  setBlinking(on: boolean): void {
    this.svg.classList.toggle("blinking", on);
  }
}
