/**
 * The coin.
 *
 * It lived in `dice.ts` because both are "things that land on a number", but
 * it shares no code with the dice: the coin is a CSS animation on two
 * elements, and the dice are a canvas and a solid. Its own file says so.
 *
 * The toss is only transforms, so it runs on the compositor and a phone can
 * do it without dropping the rest of the page.
 */

import { h } from "../dom.ts";
import { bounceMs, coinDuration, motionScale, vibrate, type FeelSettings } from "../feel.ts";

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
