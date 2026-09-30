/**
 * An inkblot on its card. The blot for a seed is worked out in core/inkblot.ts;
 * this puts it on screen: a bloom on a small canvas while the full-size blot
 * is computed a slice per frame, then the finished blot as an ordinary picture,
 * so right-click "Save image" and a long-press "Save to Photos" both work.
 * `download()` saves a larger copy; the play screen offers it as an icon in
 * its top bar.
 */

import { downloadBytes, h, windowOf } from "../dom.ts";
import { INKBLOT_BLOOM_MS, INKBLOT_FRAME_WAIT_MS, INKBLOT_SLICE_MS, motionScale, type FeelSettings } from "../feel.ts";
import { inkField, inkFieldRows, inkHeight, inkPaint, inkResolve, type InkBlot, type InkField } from "../../core/inkblot.ts";

/** The bloom's canvas: small enough to paint every frame. */
const INKBLOT_BLOOM_WIDTH = 560;
/** The picture left on the card; the card scales it to fit. */
const INKBLOT_CARD_WIDTH = 1200;
/** What Download saves. */
const INKBLOT_DOWNLOAD_WIDTH = 2000;
/** Rows computed between checks of the clock. */
const INKBLOT_ROW_STEP = 4;

export interface InkblotView {
  el: HTMLElement;
  /** Bloom the blot for this seed onto the card; resolves when it is finished. */
  show(seed: number, feel: FeelSettings): Promise<void>;
  /** Jump a bloom to the finished blot. */
  skip(): void;
  /** A finished blot is on the card, so there is something to download. */
  readonly ready: boolean;
  /** Save a larger copy of the blot on the card, as a PNG named after it. */
  download(): Promise<void>;
}

/**
 * @param placeholder what the empty card says before the first blot
 * @param onReady     told when a finished blot arrives or goes (a new one starts)
 */
export function createInkblotView(placeholder = "Press Generate", onReady?: (ready: boolean) => void): InkblotView {
  const canvas = h("canvas", { class: "inkblot-canvas", "aria-hidden": "true" });
  canvas.hidden = true;
  const picture = h("img", { class: "inkblot-picture", alt: "" });
  picture.hidden = true;
  const empty = h("p", { class: "inkblot-empty faint", text: placeholder });
  const card = h("div", { class: "inkblot-card" }, empty, canvas, picture);
  const el = h("div", { class: "inkblot-wrap" }, card);
  const offerDownload = (on: boolean) => onReady?.(on);
  let saving = false;

  /** Each show() takes a turn; an older one that sees a newer turn stops. */
  let turn = 0;
  let skipping = false;
  let shown: InkBlot | null = null;
  let pictureUrl: string | null = null;

  /** The next animation frame of the card's own window, or a timer if it gets none. */
  function nextFrame(): Promise<void> {
    const win = windowOf(el);
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        win.cancelAnimationFrame(frame);
        win.clearTimeout(timer);
        resolve();
      };
      const frame = win.requestAnimationFrame(finish);
      const timer = win.setTimeout(finish, INKBLOT_FRAME_WAIT_MS);
    });
  }

  /** Work on a field for one slice of time; true once it is complete. */
  function work(field: InkField): boolean {
    const until = performance.now() + INKBLOT_SLICE_MS;
    let done = false;
    while (!done && performance.now() < until) done = inkFieldRows(field, INKBLOT_ROW_STEP);
    return done;
  }

  async function complete(field: InkField, mine: number): Promise<boolean> {
    while (!work(field)) {
      await nextFrame();
      if (mine !== turn) return false;
    }
    return true;
  }

  function paint(target: HTMLCanvasElement, field: InkField, prog: number): void {
    if (target.width !== field.W || target.height !== field.H) {
      target.width = field.W;
      target.height = field.H;
    }
    const ctx = target.getContext("2d");
    if (!ctx) return;
    const image = ctx.createImageData(field.W, field.H);
    inkPaint(field, prog, image.data);
    ctx.putImageData(image, 0, 0);
  }

  function toBlob(target: HTMLCanvasElement): Promise<Blob | null> {
    return new Promise((resolve) => target.toBlob(resolve, "image/png"));
  }

  async function show(seed: number, feel: FeelSettings): Promise<void> {
    const mine = ++turn;
    skipping = false;
    const blot = inkResolve(seed);
    const bloomMs = INKBLOT_BLOOM_MS * motionScale(feel.motion);
    const full = inkField(INKBLOT_CARD_WIDTH, inkHeight(INKBLOT_CARD_WIDTH), blot);
    shown = null;
    offerDownload(false);

    if (bloomMs > 0) {
      const small = inkField(INKBLOT_BLOOM_WIDTH, inkHeight(INKBLOT_BLOOM_WIDTH), blot);
      if (!(await complete(small, mine))) return;
      paint(canvas, small, 0);
      empty.hidden = true;
      picture.hidden = true;
      canvas.hidden = false;
      const start = performance.now();
      for (;;) {
        await nextFrame();
        if (mine !== turn) return;
        const prog = skipping ? 1 : Math.min(1, (performance.now() - start) / bloomMs);
        if (prog >= 1) {
          paint(canvas, small, 1);
          break;
        }
        paint(canvas, small, prog);
        // What is left of the frame goes to the full-size blot.
        work(full);
      }
    }
    if (!(await complete(full, mine))) return;
    const target = document.createElement("canvas");
    paint(target, full, 1);
    const blob = await toBlob(target);
    if (mine !== turn) return;
    if (pictureUrl) URL.revokeObjectURL(pictureUrl);
    pictureUrl = blob ? URL.createObjectURL(blob) : null;
    if (pictureUrl) picture.src = pictureUrl;
    // Wait until the picture can be drawn, or the card is empty for a frame.
    if (pictureUrl) await picture.decode().catch(() => {});
    if (mine !== turn) return;
    picture.alt = `An inkblot (blot ${seed})`;
    picture.hidden = pictureUrl === null;
    canvas.hidden = pictureUrl !== null;
    if (!pictureUrl) paint(canvas, full, 1);
    empty.hidden = true;
    shown = blot;
    offerDownload(true);
  }

  /** A larger copy, on its paper, as a PNG named after the blot. */
  async function save(): Promise<void> {
    const blot = shown;
    if (!blot || saving) return;
    saving = true;
    try {
      const field = inkField(INKBLOT_DOWNLOAD_WIDTH, inkHeight(INKBLOT_DOWNLOAD_WIDTH), blot);
      while (!work(field)) await nextFrame();
      const target = document.createElement("canvas");
      paint(target, field, 1);
      const blob = await toBlob(target);
      if (blob) downloadBytes(`inkblot-${blot.seed}.png`, new Uint8Array(await blob.arrayBuffer()), "image/png");
    } finally {
      saving = false;
    }
  }

  return {
    el,
    show,
    skip() {
      skipping = true;
    },
    get ready() {
      return shown !== null;
    },
    download: save,
  };
}
