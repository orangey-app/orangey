/**
 * The Recent rolls panel: the last few rolls, wherever the table can see them.
 *
 * The panel belongs to a set of randomizers — the one a play screen has open,
 * the several a board shows — and both the rows and the Clear beside the
 * heading are about that set, so Clear removes what is in front of the user
 * and nothing behind it. No ids at all means the whole history, which is what
 * the quick play screen has in front of it.
 */

import { askConfirm, button, formatTime, h, setChildren } from "../dom.ts";
import { rollDetails, rollsInScope, state, type HistoryRow } from "../state.ts";
import { navigate } from "../router.ts";

export interface RecentRollsOptions {
  /** Which randomizers this panel is about; empty means "everything". */
  ids: () => string[];
  /** What Clear should say it is clearing, e.g. "Forest Encounters" or "this board". */
  scopeName: () => string;
  /** How many rows to show. Defaults to 8. */
  limit?: number;
}

export interface RecentRollsView {
  el: HTMLElement;
  refresh(): void;
}

export const RECENT_ROLLS_LIMIT = 8;

/**
 * The faint lines under a row's result, for this panel and the History view
 * alike: "3 wolves" stays the headline and the dice behind the 3 sit beneath.
 */
export function rollDetailLines(row: HistoryRow): HTMLElement[] {
  const { parts, from } = rollDetails(row);
  return [
    parts ? h("span", { class: "roll-note roll-parts", text: parts }) : null,
    from ? h("span", { class: "roll-note roll-from", text: from }) : null,
  ].filter((el): el is HTMLSpanElement => el !== null);
}

/**
 * What Clear is about to take, named. An empty scope is the whole history.
 *
 * The count is every roll of those randomizers, not the few rows on screen:
 * the confirm is the last chance to see how much is going.
 */
export function clearRollsPrompt(count: number, scope: string): string {
  if (!scope) return "Clear the whole history?";
  // "6 rolls of Forest Encounters", but "12 rolls from this board": a name
  // takes "of", a phrase that already points at the screen takes "from".
  const preposition = scope.startsWith("this ") ? "from" : "of";
  return `Clear ${count} roll${count === 1 ? "" : "s"} ${preposition} ${scope}?`;
}

export function createRecentRolls(opts: RecentRollsOptions): RecentRollsView {
  const limit = opts.limit ?? RECENT_ROLLS_LIMIT;
  const list = h("ul", { class: "history-list recent-rolls" });

  const scoped = () => rollsInScope(state.history, opts.ids());

  async function clearScope(): Promise<void> {
    const ids = opts.ids();
    const rows = scoped();
    if (rows.length === 0) {
      state.toast("There is nothing here to clear.");
      return;
    }
    // The app's own dialog rather than the browser's: it returns the keyboard
    // where it came from, and it looks like the rest of Orangey.
    const sure = await askConfirm("Clear these rolls", clearRollsPrompt(rows.length, ids.length === 0 ? "" : opts.scopeName()), {
      confirm: "Clear",
      danger: true,
    });
    if (sure) void state.clearHistoryFor(ids);
  }

  function refresh(): void {
    setChildren(list,
      ...scoped().slice(0, limit).map((row) =>
        h("li", { class: row.struck ? "struck" : "" },
          h("span", { class: "when", text: formatTime(row.at) }),
          h("span", { class: "what" },
            h("span", { class: "name", text: row.randomizerName }),
            " ",
            h("span", { class: "detail", text: row.resultText }),
            ...rollDetailLines(row),
          ),
          button(row.struck ? "Unstrike" : "Strike", () => void state.setStruck(row.id, !row.struck), { class: "ghost" }),
        ),
      ),
    );
  }

  const el = h("div", { class: "card" },
    h("div", { class: "row" },
      h("h2", { text: "Recent rolls", style: { margin: "0" } }),
      h("div", { class: "spacer" }),
      button("Clear", () => void clearScope(), { class: "ghost danger" }),
      button("All history", () => navigate("#/history"), { class: "ghost" }),
    ),
    list,
  );

  refresh();
  return { el, refresh };
}
