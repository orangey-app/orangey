/**
 * The import wizard (plan C7).
 *
 * Paste or drop, check what was detected, map the columns, read the report,
 * then land in the editor with the table ready to fix — importing is the start
 * of building a wheel, not the end of it (decision D21).
 */

import { detect, guessColumns, guessHeader, type Detection } from "../../import/detect.ts";
import { buildItems, itemsFromJson, type ImportResult, type Mapping } from "../../import/map.ts";
import { delimiterName, looksLikeJson, parseDelimited, type Delimiter } from "../../import/parse.ts";
import { emptyRandomizer, type ListRandomizer, type Randomizer } from "../../model/randomizer.ts";
import { decodeRandomizer } from "../../model/link.ts";
import { parseFile } from "../../model/file.ts";
import { FILE_SUFFIX } from "../../model/file.ts";
import { readZip } from "../../storage/zip.ts";
import { button, h, setChildren } from "../dom.ts";
import { state } from "../state.ts";
import { navigate } from "../router.ts";
import type { View } from "./editor.ts";

export function createImportView(initialText = ""): View {
  let text = initialText;
  let detection: Detection | null = null;
  let mapping: Mapping = { label: 0, weight: null, description: null, color: null, extrasToMetadata: false };
  let outcome: ImportResult | null = null;

  const textarea = h("textarea", {
    placeholder: "Paste a table here, or drop a .csv, .tsv, .txt or .orangey.json file anywhere on this page",
    "aria-label": "Data to import",
  });
  textarea.value = text;
  // A pasted link is unmistakable, so it is read at once rather than waiting
  // for "Read it" — nobody pastes a link expecting to press a button next.
  textarea.addEventListener("paste", () => queueMicrotask(() => {
    if (LINK_PATTERN.test(textarea.value)) analyse();
  }));
  textarea.addEventListener("input", () => {
    if (LINK_PATTERN.test(textarea.value) && !linked && !linkProblem) analyse();
  });

  /** A link with a wheel inside it, pasted instead of a table. */
  let linked: { randomizer: Randomizer; payload: string } | null = null;
  let linkProblem: string | null = null;
  /** Matches the payload in a link someone pasted, however it was wrapped. */
  const LINK_PATTERN = /#\/roll\?(?:[^\s]*?&)?w=([A-Za-z0-9_-]+)/;

  const settings = h("div", { class: "card" });
  const preview = h("div", { class: "card" });
  const nameInput = h("input", { type: "text", value: "Imported wheel", "aria-label": "Name" });
  const folderSelect = h("select", { "aria-label": "Folder" });

  function analyse(): void {
    text = textarea.value;
    linked = null;
    linkProblem = null;
    if (!text.trim()) {
      detection = null;
      outcome = null;
      render();
      return;
    }
    const asLink = LINK_PATTERN.exec(text.trim());
    if (asLink) {
      detection = null;
      outcome = null;
      const payload = asLink[1];
      render();
      void decodeRandomizer(payload).then(
        (randomizer) => {
          if (textarea.value.trim() !== text.trim()) return;
          linked = { randomizer, payload };
          render();
        },
        (error: unknown) => {
          if (textarea.value.trim() !== text.trim()) return;
          linkProblem = (error as Error).message;
          render();
        },
      );
      return;
    }
    if (looksLikeJson(text)) {
      detection = null;
      outcome = itemsFromJson(text);
      render();
      return;
    }
    detection = detect(text);
    mapping = { ...guessColumns(detection.rows, detection.hasHeader), extrasToMetadata: false };
    rebuild();
  }

  function rebuild(): void {
    if (!detection) return;
    outcome = buildItems(detection.rows, detection.hasHeader, mapping);
    render();
  }

  function columnSelect(label: string, current: number | null, allowNone: boolean, onChange: (v: number | null) => void): HTMLElement {
    const header = detection?.hasHeader ? detection.rows[0] : [];
    const width = Math.max(...(detection?.rows ?? [[]]).map((r) => r.length), 1);
    const select = h("select", { "aria-label": label },
      allowNone ? h("option", { value: "" }, "— none —") : null,
      ...Array.from({ length: width }, (_, i) =>
        h("option", { value: String(i), selected: current === i }, header[i]?.trim() || `Column ${i + 1}`)),
    );
    select.addEventListener("change", () => {
      onChange(select.value === "" ? null : Number(select.value));
      rebuild();
    });
    return h("label", { class: "field" }, h("span", { class: "field-label", text: label }), select);
  }

  function render(): void {
    setChildren(settings, );
    setChildren(preview, );
    if (linked || linkProblem) {
      settings.append(linkCard());
      return;
    }
    if (!outcome) {
      settings.append(h("p", { class: "faint", text: "Nothing to import yet." }));
      return;
    }

    if (detection) {
      const delimiterSelect = h("select", { "aria-label": "Separator" },
        ...([",", ";", "\t", "|", "  "] as Delimiter[]).map((d) =>
          h("option", { value: d, selected: detection!.delimiter === d }, delimiterName(d))),
      );
      delimiterSelect.addEventListener("change", () => {
        const delimiter = delimiterSelect.value as Delimiter;
        const rows = parseDelimited(text, delimiter);
        detection = { delimiter, rows, hasHeader: guessHeader(rows), confidence: 1 };
        mapping = { ...guessColumns(rows, detection.hasHeader), extrasToMetadata: mapping.extrasToMetadata };
        rebuild();
      });

      const headerToggle = h("input", { type: "checkbox", checked: detection.hasHeader });
      headerToggle.addEventListener("change", () => {
        detection = { ...detection!, hasHeader: headerToggle.checked };
        rebuild();
      });

      const extrasToggle = h("input", { type: "checkbox", checked: mapping.extrasToMetadata });
      extrasToggle.addEventListener("change", () => {
        mapping = { ...mapping, extrasToMetadata: extrasToggle.checked };
        rebuild();
      });

      settings.append(
        h("h2", { text: "How this was read" }),
        h("div", { class: "row" },
          h("label", { class: "field" }, h("span", { class: "field-label", text: "Separator" }), delimiterSelect),
          h("label", { class: "row tight" }, headerToggle, "First row is a header"),
        ),
        h("h3", { text: "Columns" }),
        h("div", { class: "row" },
          columnSelect("Outcome", mapping.label, false, (v) => (mapping = { ...mapping, label: v ?? 0 })),
          columnSelect("Weight", mapping.weight, true, (v) => (mapping = { ...mapping, weight: v })),
          columnSelect("Description", mapping.description, true, (v) => (mapping = { ...mapping, description: v })),
          columnSelect("Colour", mapping.color, true, (v) => (mapping = { ...mapping, color: v })),
        ),
        h("label", { class: "row tight" }, extrasToggle, "Keep other columns as extra information"),
      );
    }

    const rows = outcome.items.slice(0, 10);
    preview.append(
      h("h2", { text: "Check before creating" }),
      h("pre", { class: "report" },
        ...outcome.report.map((line) =>
          h("div", { class: line.level }, `${line.level === "ok" ? "✓" : line.level === "warn" ? "⚠" : "✗"} ${line.text}`)),
      ),
      rows.length
        ? h("table", { class: "outcomes", style: { marginTop: "12px" } },
            h("thead", {}, h("tr", {}, h("th", { text: "Outcome" }), h("th", { text: "Weight" }), h("th", { text: "Description" }))),
            h("tbody", {},
              ...rows.map((item) =>
                h("tr", {}, h("td", { text: item.label }), h("td", { text: String(item.weight) }), h("td", { text: item.description ?? "" }))),
              outcome.items.length > 10
                ? h("tr", {}, h("td", { colspan: "3", class: "faint", text: `…and ${outcome.items.length - 10} more` }))
                : null,
            ),
          )
        : null,
      h("div", { class: "row", style: { marginTop: "14px" } },
        h("label", { class: "field", style: { flex: "1" } }, h("span", { class: "field-label", text: "Name" }), nameInput),
        h("label", { class: "field" }, h("span", { class: "field-label", text: "Folder" }), folderSelect),
      ),
      button("Create and edit", () => void create(), { class: "primary", disabled: !outcome.usable }),
    );
  }

  /**
   * What a pasted link offers: roll it now without keeping it, or keep it. A
   * link is how a table reaches you from someone else's deck, so both are
   * reasonable and neither is assumed.
   */
  function linkCard(): HTMLElement {
    if (linkProblem) {
      return h("div", { class: "link-import", role: "status" },
        h("h2", { text: "That looks like an Orangey link, but it is damaged" }),
        h("p", { class: "faint", text: linkProblem }),
        h("p", { class: "faint", text: "Links are long, and a line break or a truncation on the way is usually the cause. Ask for it again, or paste the table itself." }),
      );
    }
    const { randomizer, payload } = linked!;
    const outcomes = randomizer.type === "list" ? `${randomizer.items.length} outcomes` : describeLinkType(randomizer);
    return h("div", { class: "link-import", role: "status" },
      h("h2", { text: "This is an Orangey link" }),
      h("p", {}, h("strong", { text: randomizer.name }), h("span", { class: "faint", text: ` · ${outcomes}` })),
      h("p", { class: "faint", text: "The randomizer is inside the link itself, so you can roll it without keeping it, or add it to your library and edit it like any other." }),
      h("div", { class: "row tight" },
        button("Add to my library", () => void saveLinked(), { class: "primary add-linked" }),
        button("Just roll it", () => navigate(`#/roll?w=${payload}`), { class: "open-linked" }),
      ),
    );
  }

  function describeLinkType(r: Randomizer): string {
    if (r.type === "dice") return r.expression;
    if (r.type === "coin") return `${r.faces[0]} or ${r.faces[1]}`;
    return `${r.min} to ${r.max}`;
  }

  async function saveLinked(): Promise<void> {
    if (!linked) return;
    const { randomizer } = linked;
    const taken = state.library.findById(randomizer.id) !== null;
    const path = await state.library.create("", { ...randomizer, id: taken ? crypto.randomUUID() : randomizer.id });
    state.toast(`Added “${randomizer.name}” to your library`);
    navigate(`#/edit/${encodeURIComponent(path)}`);
  }

  async function create(): Promise<void> {
    if (!outcome?.usable) return;
    const base = emptyRandomizer("list", nameInput.value.trim() || "Imported wheel") as ListRandomizer;
    const randomizer: ListRandomizer = { ...base, items: outcome.items };
    const path = await state.library.create(folderSelect.value, randomizer);
    state.toast(`Created "${randomizer.name}" with ${outcome.items.length} outcomes`);
    const problems = outcome.report.filter((l) => l.level !== "ok").length;
    state.tell({ type: "import:done", ok: problems === 0, skipped: problems });
    navigate(`#/edit/${encodeURIComponent(path)}`);
  }

  function fillFolders(): void {
    setChildren(folderSelect, 
      ...state.library.folders().map((f) => h("option", { value: f.path }, f.path || "Top level")),
    );
  }

  /** Three-way answer for a file that already exists in the library. */
  function askCollision(path: string): Promise<"replace" | "keep-both" | "skip"> {
    return new Promise((resolve) => {
      let answered = false;
      const done = (v: "replace" | "keep-both" | "skip") => {
        if (answered) return;
        answered = true;
        resolve(v);
        dialog.close();
      };
      const dialog = h("dialog", { "aria-label": "Already in the library" },
        h("h2", { text: "Already in the library" }),
        h("p", { text: `“${path}” exists. What should happen to it?` }),
        h("div", { class: "row tight", style: { marginTop: "14px" } },
          button("Replace", () => done("replace"), { class: "danger" }),
          button("Keep both", () => done("keep-both"), { class: "primary" }),
          button("Skip", () => done("skip")),
        ),
      );
      dialog.addEventListener("close", () => { done("skip"); dialog.remove(); });
      document.body.appendChild(dialog);
      dialog.showModal();
    });
  }

  /** Dropping a file anywhere on the page opens it here: outcomes, a
   *  randomizer file, or a whole library ZIP — one door for all of them. */
  async function handleFile(file: File): Promise<void> {
    if (file.name.toLowerCase().endsWith(".zip")) {
      try {
        const entries = await readZip(new Uint8Array(await file.arrayBuffer()));
        const result = await state.library.importArchive(entries, askCollision);
        state.toast(
          `Imported ${result.added} file${result.added === 1 ? "" : "s"}` +
            `${result.replaced ? `, replaced ${result.replaced}` : ""}` +
            `${result.skipped ? `, skipped ${result.skipped}` : ""}` +
            `${result.failed ? `, ${result.failed} unreadable` : ""}`,
        );
        navigate("#/library");
      } catch (e) {
        state.toast(`That ZIP could not be read: ${(e as Error).message}`);
      }
      return;
    }
    const content = await file.text();
    if (file.name.toLowerCase().endsWith(FILE_SUFFIX)) {
      try {
        const parsed = parseFile(content);
        const path = await state.library.create("", parsed.file.randomizer);
        state.toast(`Imported "${parsed.file.randomizer.name}"`);
        navigate(`#/r/${encodeURIComponent(path)}`);
        return;
      } catch (e) {
        state.toast(`That file could not be read: ${(e as Error).message}`);
        return;
      }
    }
    textarea.value = content;
    nameInput.value = file.name.replace(/\.[^.]+$/, "");
    analyse();
  }

  const dropZone = h("div", { class: "card" },
    h("h2", { text: "Import" }),
    h("p", { class: "faint", text: "Paste a table of outcomes, or drop a file anywhere on this page: a spreadsheet export (commas, semicolons, tabs, pipes and aligned columns all work), a .orangey.json randomizer, or a library ZIP." }),
    textarea,
    h("div", { class: "row", style: { marginTop: "8px" } },
      button("Read it", analyse, { class: "primary" }),
      button("Clear", () => {
        textarea.value = "";
        analyse();
      }, { class: "ghost" }),
    ),
  );

  const fileInput = h("input", { type: "file", accept: ".csv,.tsv,.txt,.json,.zip", "aria-label": "Choose a file to import", style: { display: "none" } });
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) void handleFile(file);
    fileInput.value = "";
  });

  const el = h("div", { class: "importer" },
    dropZone,
    h("div", { class: "row", style: { marginBottom: "12px" } }, button("Choose a file…", () => fileInput.click()), fileInput),
    settings,
    preview,
  );

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) void handleFile(file);
  };
  const onDragOver = (e: DragEvent) => e.preventDefault();
  document.addEventListener("drop", onDrop);
  document.addEventListener("dragover", onDragOver);

  fillFolders();
  if (initialText) analyse();
  else render();

  return {
    el,
    destroy() {
      document.removeEventListener("drop", onDrop);
      document.removeEventListener("dragover", onDragOver);
    },
  };
}
