/**
 * A list randomizer shown as a list: every outcome with its odds, and each
 * one a button — pressing it picks that outcome as the answer, as Roll picks
 * one at random. The play screen, a board's cell and the pop-out all use it.
 *
 * A pick lands through the roll controller (`roller.choose`), so it is an
 * answer like any other: announced, recorded (as *picked*), taken out of the
 * bag, and followed when the outcome leads to another randomizer. The list
 * scrolls within itself, so a hundred-row table does not push its Roll off
 * the screen.
 */

import type { ListItem } from "../../model/randomizer.ts";
import { displayPercents, isRollable } from "../../core/weighted.ts";
import { h, setChildren } from "../dom.ts";

export interface OutcomeListView {
  el: HTMLElement;
  /** Draw the outcomes again as they stand (a bag draw, an edit). */
  refresh(): void;
  /** Mark the outcome that is the answer now, or none. */
  mark(itemIndex: number | null): void;
}

export function createOutcomeList(opts: {
  /** The outcomes in play, drawn ones marked disabled (see `withoutDrawn`). */
  items: () => readonly ListItem[];
  onPick: (itemIndex: number) => void;
  /** What the list is, for a screen reader: the randomizer's name. */
  name: string;
}): OutcomeListView {
  const el = h("ul", { class: "outcome-list", "aria-label": `${opts.name}: pick an outcome` });
  let marked: number | null = null;
  let buttons: HTMLButtonElement[] = [];

  function refresh(): void {
    const items = opts.items();
    const percents = displayPercents(items);
    buttons = items.map((item, i) => {
      const live = isRollable(item);
      const pick = h("button", {
        type: "button",
        class: "outcome-pick",
        title: live ? `Pick ${item.label}` : "Cannot come up now",
        onclick: () => opts.onPick(i),
      },
        h("span", { class: "outcome-label", text: item.label }),
        h("span", { class: "outcome-odds", text: live ? `${percents[i].toFixed(1)}%` : "—" }),
      ) as HTMLButtonElement;
      pick.disabled = !live;
      return pick;
    });
    setChildren(el, ...buttons.map((b) => h("li", {}, b)));
    mark(marked);
  }

  function mark(itemIndex: number | null): void {
    marked = itemIndex;
    buttons.forEach((b, i) => b.setAttribute("aria-current", String(i === itemIndex)));
    // The answer in view, without moving the page: only the list scrolls.
    const current = itemIndex === null ? undefined : buttons[itemIndex];
    if (current) {
      // Relative to the list itself, which is positioned for this.
      const top = current.offsetTop;
      if (top < el.scrollTop || top + current.offsetHeight > el.scrollTop + el.clientHeight) {
        el.scrollTop = Math.max(0, top - el.clientHeight / 2);
      }
    }
  }

  refresh();
  return { el, refresh, mark };
}
