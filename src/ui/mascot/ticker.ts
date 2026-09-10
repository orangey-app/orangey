/**
 * One requestAnimationFrame loop for every running mascot.
 *
 * It stops itself when nothing is subscribed and while the tab is hidden, so
 * a mascot standing in a background tab costs nothing. Each subscriber gets
 * the real frame delta, capped so a tab that was asleep does not wake up to
 * a single enormous step.
 */

export type TickFn = (dt: number) => void;

const MAX_STEP = 1 / 24;

class MascotTickerImpl {
  #subs = new Set<TickFn>();
  #handle = 0;
  #last = 0;
  #onVisibility = () => {
    if (document.hidden) this.#stop();
    else this.#start();
  };

  add(fn: TickFn): () => void {
    this.#subs.add(fn);
    if (this.#subs.size === 1) document.addEventListener("visibilitychange", this.#onVisibility);
    this.#start();
    return () => this.remove(fn);
  }

  remove(fn: TickFn): void {
    this.#subs.delete(fn);
    if (this.#subs.size === 0) {
      this.#stop();
      document.removeEventListener("visibilitychange", this.#onVisibility);
    }
  }

  get running(): boolean {
    return this.#handle !== 0;
  }

  get size(): number {
    return this.#subs.size;
  }

  #start(): void {
    if (this.#handle || this.#subs.size === 0 || document.hidden) return;
    this.#last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min((now - this.#last) / 1000, MAX_STEP);
      this.#last = now;
      for (const fn of this.#subs) fn(dt);
      this.#handle = this.#subs.size ? requestAnimationFrame(frame) : 0;
    };
    this.#handle = requestAnimationFrame(frame);
  }

  #stop(): void {
    if (this.#handle) cancelAnimationFrame(this.#handle);
    this.#handle = 0;
  }
}

export const mascotTicker = new MascotTickerImpl();
