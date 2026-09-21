/**
 * History (plan C7/L). Append-only: a roll cannot honestly be un-rolled, so
 * there is "remove entry" and no undo (decision D13). A roll that the table
 * agreed not to count is struck instead: the line stays, drawn through.
 */

import { button, formatWhen, h, setChildren } from "../dom.ts";
import { appdb, HISTORY_CAP } from "../../storage/appdb.ts";
import { state, type HistoryRow } from "../state.ts";
import { navigate } from "../router.ts";
import { download } from "./library.ts";
import type { View } from "./editor.ts";

/**
 * The history as a spreadsheet. A struck roll is exported like any other,
 * with the column saying it was struck: the log of a session is only complete
 * if what the table set aside is in it too.
 */
export function historyCsv(rows: HistoryRow[]): string {
  const table = [
    ["time", "randomizer", "type", "result", "seed", "struck"],
    ...rows.map((e) => [
      new Date(e.at).toISOString(),
      e.randomizerName,
      e.type,
      e.resultText,
      e.seed ?? "",
      e.struck ? "yes" : "",
    ]),
  ];
  return table
    .map((r) => r.map((cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(","))
    .join("\n");
}

export function createHistoryView(): View {
  const list = h("ul", { class: "history-list" });
  const summary = h("p", { class: "faint" });

  /** How many rolls the store holds, which may be more than are shown. */
  let stored: number | null = null;

  function render(): void {
    const shown = state.history.length;
    if (!shown) {
      summary.textContent = "No rolls yet.";
    } else if (stored !== null && stored > shown) {
      summary.textContent =
        `${stored} rolls kept on this device, showing the most recent ${shown}. An export includes all of them.`;
    } else {
      summary.textContent = `${shown} roll${shown === 1 ? "" : "s"} kept on this device`;
    }
    setChildren(list, 
      ...state.history.map((entry) =>
        h("li", { class: entry.struck ? "struck" : "" },
          h("span", { class: "when", text: formatWhen(entry.at) }),
          h("span", { class: "what" },
            h("span", { class: "name", text: entry.randomizerName }),
            " ",
            h("span", { class: "detail", text: entry.resultText }),
            entry.seed ? h("span", { class: "faint", text: ` · seed ${entry.seed}` }) : null,
          ),
          button("Repeat", () => {
            if (entry.repeat?.kind === "randomizer") {
              const node = state.library.findById(entry.repeat.id);
              if (node) {
                navigate(`#/r/${encodeURIComponent(node.path)}`);
                return;
              }
            }
            state.toast("That randomizer is no longer in your library.");
          }, { class: "ghost" }),
          button(entry.struck ? "Unstrike" : "Strike", () => void state.setStruck(entry.id, !entry.struck), { class: "ghost" }),
          button("Copy", () => {
            void navigator.clipboard?.writeText(`${entry.randomizerName}: ${entry.resultText}`);
            state.toast("Copied");
          }, { class: "ghost" }),
          button("Remove", () => void state.removeHistory(entry.id), { class: "ghost danger" }),
        ),
      ),
    );
  }

  /**
   * Everything the store holds, not the recent slice held in memory: an
   * export of "my history" that quietly stopped at the most recent few
   * hundred would be wrong in the one way that matters.
   *
   * The rows in memory carry `struck`, which the stored ones may predate, so
   * the two are merged on id rather than one replacing the other.
   */
  async function allRows(): Promise<HistoryRow[]> {
    const known = new Map(state.history.map((row) => [row.id, row]));
    const rows = await appdb.history(HISTORY_CAP);
    return rows.map((row) => known.get(row.id) ?? row);
  }

  async function exportCsv(): Promise<void> {
    download("orangey-history.csv", `${historyCsv(await allRows())}\n`, "text/csv");
  }

  async function exportText(): Promise<void> {
    const text = (await allRows())
      .map((e) => `${formatWhen(e.at)}  ${e.randomizerName}  →  ${e.resultText}`)
      .join("\n");
    download("orangey-history.txt", `${text}\n`, "text/plain");
  }

  const el = h("div", {},
    h("div", { class: "card" },
      h("div", { class: "row" },
        h("h1", { text: "History", style: { margin: "0" } }),
        h("div", { class: "spacer" }),
        button("Export CSV", () => void exportCsv(), { class: "ghost" }),
        button("Export text", () => void exportText(), { class: "ghost" }),
        button("Clear", () => {
          if (confirm("Clear the whole history?")) void state.clearHistory();
        }, { class: "ghost danger" }),
      ),
      summary,
      list,
    ),
  );

  render();
  // How many are really there, so the summary can say when it is showing a
  // slice. It arrives a moment after the list, which is soon enough.
  void appdb.history(HISTORY_CAP).then((rows) => {
    stored = rows.length;
    render();
  });
  const unsubscribe = state.subscribe(render, ["history"]);
  return { el, destroy: () => unsubscribe() };
}
