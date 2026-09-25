/**
 * The result panel: the largest thing on the screen, and the only place a
 * result is ever announced.
 *
 * Its height is reserved, not discovered. `reserve()` is called with the
 * longest outcome the current randomizer can produce, and from that the panel
 * fixes its type size and how many lines it keeps — so the card never grows
 * when a roll lands, and never grows again when a longer outcome comes up
 * later. An outcome that still does not fit is clipped with an ellipsis; the
 * spoken announcement is always the whole thing.
 *
 * The live region is updated when the animation ends (or immediately in
 * instant mode) so that a screen reader is never told the answer before the
 * table can see it.
 */

import { h, setChildren } from "../dom.ts";
import { imageUrl, imageUrlSync } from "../../storage/images.ts";
import type { Outcome } from "../roll.ts";

export interface ResultPanel {
  el: HTMLElement;
  show(outcome: Outcome, opts?: { announce?: boolean }): void;
  /** While an animation runs: hold the slot without giving the answer away. */
  pending(text?: string): void;
  clear(placeholder?: string): void;
  announce(text: string): void;
  /**
   * Fix the panel's size from the longest outcome that can come up, and say
   * whether a seed line needs room. Called when a randomizer is opened or
   * swapped, never per roll.
   */
  reserve(longest: string, opts?: { seed?: boolean; offer?: number }): void;
  /**
   * Make a choice: lay out the offered outcomes as cards and wait for a pick.
   * Face down for a hidden roll, until it is revealed. `prompt` goes where
   * the answer will go.
   */
  offer(texts: readonly string[], opts: OfferOptions): void;
  /** The card that was picked stays, the others fade, and none can be picked again. */
  chose(at: number): void;
}

export interface OfferOptions {
  onPick: (at: number) => void;
  prompt: string;
  faceDown?: boolean;
  /** How long the cards take to turn over; 0 shows them at once. */
  flipMs: number;
  /** Put the keyboard on the first card, when the press that rolled came from this panel's owner. */
  focus?: boolean;
}

/** Beyond this many characters the result drops to the smaller type size. */
export const RESULT_SMALL_AT = 18;
/** Beyond this many characters a second line is kept, so wrapping cannot push. */
export const RESULT_TWO_LINES_AT = 12;

export function resultLines(longest: string): 1 | 2 {
  return longest.length > RESULT_TWO_LINES_AT ? 2 : 1;
}

export function resultIsSmall(longest: string): boolean {
  return longest.length > RESULT_SMALL_AT;
}

export function createResultPanel(placeholder = "Ready"): ResultPanel {
  const value = h("div", { class: "result-value", text: placeholder });
  const slot = h("div", { class: "result-slot" }, value);
  const detail = h("div", { class: "result-detail" });
  const meta = h("div", { class: "result-meta" });
  const live = h("div", { class: "sr-only", role: "status", "aria-live": "polite", "aria-atomic": "true" });
  // The picture an outcome carries sits above its name: the table looks at the
  // picture, the name is what gets written down.
  const picture = h("img", { class: "result-picture", alt: "" });
  picture.hidden = true;
  // The cards of an offer. The row is laid out from the moment a randomizer
  // that offers is opened, with invisible stand-ins for every card, so the
  // panel is already as tall as it will be when the cards arrive.
  const cards = h("div", { class: "offer-cards", role: "group", "aria-label": "Choose one" });
  cards.hidden = true;
  let slots = 0;
  const el = h("div", { class: "result-panel" }, picture, slot, cards, detail, meta, live);

  /** The empty row: one invisible card per slot, holding the height. */
  function resetCards(): void {
    setChildren(cards, ...Array.from({ length: slots }, () => standIn()));
  }
  const standIn = () => h("span", { class: "offer-card placeholder", "aria-hidden": "true" }, h("span", { class: "offer-text", text: "\u00a0" }));

  // Arrow keys walk the row; the digits 1 to 9 pick. On the play screen the
  // digits also work from anywhere, which the view handles; here they work
  // wherever this panel is, a board cell included, once focus is on a card.
  cards.addEventListener("keydown", (e) => {
    const all = [...cards.querySelectorAll<HTMLButtonElement>("button.offer-card")];
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const key = (e as KeyboardEvent).key;
    const step = key === "ArrowRight" || key === "ArrowDown" ? 1 : key === "ArrowLeft" || key === "ArrowUp" ? -1 : 0;
    if (step) {
      e.preventDefault();
      all[(at + step + all.length) % all.length].focus();
    } else if (/^[1-9]$/.test(key) && Number(key) <= all.length) {
      e.preventDefault();
      all[Number(key) - 1].click();
    }
  });

  function showPicture(id: string | undefined, alt: string): void {
    if (!id) {
      picture.hidden = true;
      picture.removeAttribute("src");
      return;
    }
    const url = imageUrlSync(id);
    if (!url) {
      void imageUrl(id).then((ready) => {
        if (ready) showPicture(id, alt);
      });
      return;
    }
    (picture as HTMLImageElement).src = url;
    picture.alt = alt;
    picture.hidden = false;
  }

  return {
    el,
    show(outcome, { announce = true } = {}) {
      // A dice total is set in the dice's own numerals; a wheel's answer is not,
      // even when it holds a number ("3 wolves").
      el.classList.toggle("is-dice", outcome.kind === "dice");
      el.classList.remove("is-pending");
      value.textContent = outcome.text;
      value.classList.toggle("is-max", outcome.isMaximum === true);
      value.classList.toggle("is-min", outcome.isMinimum === true);
      value.title = outcome.text;
      detail.textContent = outcome.detail ?? "";
      meta.textContent = outcome.seed ? `seed ${outcome.seed}` : "";
      showPicture(outcome.image, outcome.text);
      // A pick keeps its cards on show, faded around the one taken; any
      // other answer empties the row.
      if (!outcome.offered) resetCards();
      if (announce) live.textContent = outcome.speak;
    },
    pending(text = "Rolling…") {
      el.classList.add("is-pending");
      resetCards();
      showPicture(undefined, "");
      value.textContent = text;
      value.classList.remove("is-max", "is-min");
      value.removeAttribute("title");
      detail.textContent = "";
      meta.textContent = "";
    },
    clear(text = placeholder) {
      el.classList.remove("is-pending");
      resetCards();
      showPicture(undefined, "");
      value.textContent = text;
      value.classList.remove("is-max", "is-min");
      value.removeAttribute("title");
      detail.textContent = "";
      meta.textContent = "";
    },
    reserve(longest, { seed = false, offer = 0 } = {}) {
      // Only when the count changes: this runs again whenever settings or
      // history change, and an offer on the table must not be swept away.
      if (offer !== slots) {
        slots = offer;
        cards.hidden = slots === 0;
        resetCards();
      }
      const lines = resultLines(longest);
      slot.classList.toggle("small", resultIsSmall(longest));
      el.style.setProperty("--result-lines", String(lines));
      // Full screen uses this: two lines of the largest type is a lot of a
      // short window, so the type there gives way rather than the wheel.
      el.classList.toggle("two-lines", lines === 2);
      el.classList.toggle("seeded", seed);
    },
    announce(text) {
      live.textContent = text;
    },
    offer(texts, { onPick, prompt, faceDown = false, flipMs, focus = false }) {
      el.classList.add("is-pending");
      showPicture(undefined, "");
      value.textContent = prompt;
      value.classList.remove("is-max", "is-min");
      value.removeAttribute("title");
      detail.textContent = "";
      meta.textContent = "";
      cards.hidden = false;
      cards.classList.toggle("flipping", flipMs > 0 && !faceDown);
      cards.style.setProperty("--offer-flip", `${flipMs}ms`);
      const made = texts.map((text, i) => {
        const card = h("button", {
          type: "button",
          class: faceDown ? "offer-card face-down" : "offer-card",
          style: `--i: ${i}`,
          ...(faceDown ? { disabled: true, "aria-label": `Card ${i + 1}, face down` } : { title: text }),
        },
          h("span", { class: "offer-key", "aria-hidden": "true", text: i < 9 ? String(i + 1) : "" }),
          h("span", { class: "offer-text", text: faceDown ? "" : text }),
        );
        card.addEventListener("click", () => {
          if (card.getAttribute("aria-disabled") === "true") return;
          onPick(i);
        });
        return card;
      });
      setChildren(cards, ...made, ...Array.from({ length: Math.max(0, slots - made.length) }, () => standIn()));
      // Said once the cards can be read, like any answer (P15).
      live.textContent = faceDown ? "" : `Choose one: ${texts.join(", ")}.`;
      if (focus && !faceDown) made[0]?.focus({ preventScroll: true });
    },
    chose(at) {
      const all = [...cards.querySelectorAll<HTMLButtonElement>("button.offer-card")];
      // A digit can pick a card other than the focused one; the keyboard
      // follows the pick, or the focus ring would sit on a card not taken.
      if (all.includes(document.activeElement as HTMLButtonElement)) all[at]?.focus({ preventScroll: true });
      all.forEach((card, i) => {
        card.classList.add(i === at ? "chosen" : "not-chosen");
        // aria-disabled rather than disabled: the card keeps the keyboard's
        // focus, which a disabled button would drop onto the page.
        card.setAttribute("aria-disabled", "true");
      });
    },
  };
}
