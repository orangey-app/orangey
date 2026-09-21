/**
 * History (plan C7/L). Append-only: a roll cannot honestly be un-rolled, so
 * there is "remove entry" and no undo (decision D13). A roll that the table
 * agreed not to count is struck instead: the line stays, drawn through.
 */

import { button, formatTime, h, setChildren } from "../dom.ts";
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

  function render(): void {
    summary.textContent = state.history.length
      ? `${state.history.length} roll${state.history.length === 1 ? "" : "s"} kept on this device`
      : "No rolls yet.";
    setChildren(list, 
      ...state.history.map((entry) =>
        h("li", { class: entry.struck ? "struck" : "" },
          h("span", { class: "when", text: formatTime(entry.at) }),
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

  function exportCsv(): void {
    download("orangey-history.csv", `${historyCsv(state.history)}\n`, "text/csv");
  }

  function exportText(): void {
    const text = state.history
      .map((e) => `${formatTime(e.at)}  ${e.randomizerName}  →  ${e.resultText}`)
      .join("\n");
    download("orangey-history.txt", `${text}\n`, "text/plain");
  }

  const el = h("div", {},
    h("div", { class: "card" },
      h("div", { class: "row" },
        h("h1", { text: "History", style: { margin: "0" } }),
        h("div", { class: "spacer" }),
        button("Export CSV", exportCsv, { class: "ghost" }),
        button("Export text", exportText, { class: "ghost" }),
        button("Clear", () => {
          if (confirm("Clear the whole history?")) void state.clearHistory();
        }, { class: "ghost danger" }),
      ),
      summary,
      list,
    ),
  );

  render();
  const unsubscribe = state.subscribe(render);
  return { el, destroy: () => unsubscribe() };
}
