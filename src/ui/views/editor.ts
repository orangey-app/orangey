/**
 * The editor, and inside it the outcome table (plan C9).
 *
 * This is where a randomizer actually gets built, and where an imported table
 * lands, so it is built for fixing forty rows quickly: every row can be
 * disabled, duplicated or deleted in place, destructive edits are undoable for
 * ten seconds, and everything is reachable from the keyboard.
 */

import { displayPercents, isRollable } from "../../core/weighted.ts";
import type { CoinRandomizer, ListItem, ListRandomizer, OutcomeReaction, Randomizer } from "../../model/randomizer.ts";
import { makeItem, newId } from "../../model/randomizer.ts";
import type { LibraryNode } from "../../storage/library.ts";
import { button, debounce, h, iconButton, setChildren } from "../dom.ts";
import { state } from "../state.ts";
import { createWheel } from "../components/wheel.ts";
import { openSwatchPicker } from "../components/swatch.ts";
import { reactionControl } from "../components/reaction.ts";
import { rollRandomizer, whyCannotRoll } from "../roll.ts";
import { createResultPanel } from "../components/result.ts";
import { navigate } from "../router.ts";
import { effectiveFeel, normalizeOverride, type FeelOverride } from "../feel.ts";
import { coinControls, diceControls, sectionFor, wheelControls } from "../components/feelpanel.ts";

/**
 * The Feel card in an editor: this randomizer's own animation settings,
 * merged over the global ones. Only the section for its type is shown — a
 * wheel gets the wheel controls — and one button returns it to the global
 * settings.
 */
function feelCard(get: () => Randomizer, set: (feel: FeelOverride | undefined) => void, preview?: () => void): HTMLElement {
  const card = h("div", { class: "card feel-card" });
  const render = () => {
    const model = get();
    const section = sectionFor(model.type);
    if (!section) {
      card.hidden = true;
      return;
    }
    const effective = effectiveFeel(state.prefs.feel, model.feel);
    const overridden = Object.keys(model.feel?.[section] ?? {}).length;
    const apply = (patch: object) => {
      const next = normalizeOverride({ ...(model.feel ?? {}), [section]: { ...(model.feel?.[section] ?? {}), ...patch } });
      set(next);
      render();
    };
    const controls =
      section === "wheel" ? wheelControls(effective.wheel, apply)
      : section === "dice" ? diceControls(effective.dice, apply)
      : coinControls(effective.coin, apply);
    setChildren(card,
      h("div", { class: "row" },
        h("h2", { text: "Feel", style: { margin: "0" } }),
        h("div", { class: "spacer" }),
        h("span", { class: "faint", text: overridden ? `${overridden} setting${overridden === 1 ? "" : "s"} set for this one` : "Using the global settings" }),
      ),
      h("p", { class: "faint", text: "Changes here are saved with this randomizer and apply only to it. Settings covers the defaults." }),
      controls,
      h("div", { class: "row tight" },
        preview ? button("Preview", preview, { class: "preview-feel" }) : null,
        overridden ? button("Use global settings", () => { set(normalizeOverride({ ...(model.feel ?? {}), [section]: undefined })); render(); }, { class: "ghost reset-feel" }) : null,
      ),
    );
  };
  render();
  return card;
}

export interface View {
  el: HTMLElement;
  destroy?(): void;
}

export function createEditorView(node: LibraryNode): View {
  const randomizer = node.randomizer!;
  if (randomizer.type !== "list") return createSimpleEditor(node);
  return createListEditor(node, randomizer);
}

function formatWeight(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

/* -------------------------------------------------------------------------- */

function createListEditor(node: LibraryNode, initial: ListRandomizer): View {
  let model: ListRandomizer = structuredClone(initial);
  let selection = new Set<string>();
  let filter = "";
  let sortBy: "none" | "label" | "weight" = "none";

  const savedLabel = h("span", { class: "faint", text: "All changes saved" });

  const save = () => {
    savedLabel.textContent = "Saving…";
    model = { ...model, modified: new Date().toISOString() };
    state.library.save(node.path, model);
    void state.library.flush().then(() => {
      savedLabel.textContent = "All changes saved";
    });
  };
  const saveSoon = debounce(save, 250);

  const wheel = createWheel({
    items: () => model.items,
    id: () => model.id,
    onActivate: () => void rollNow(),
  });
  const result = createResultPanel("Try it");

  // ---- header --------------------------------------------------------------

  const nameInput = h("input", { type: "text", value: model.name, "aria-label": "Name" });
  nameInput.addEventListener("input", () => {
    model = { ...model, name: nameInput.value };
    saveSoon();
  });
  nameInput.addEventListener("blur", async () => {
    if (!model.name.trim()) return;
    await state.library.flush();
    const path = await state.library.rename(node.path, model.name);
    if (path !== node.path) navigate(`#/edit/${encodeURIComponent(path)}`, true);
  });

  const descInput = h("input", { type: "text", value: model.description ?? "", "aria-label": "Description" });
  descInput.addEventListener("input", () => {
    model = { ...model, description: descInput.value || undefined };
    saveSoon();
  });

  const viewToggle = h("div", { class: "segmented", role: "group", "aria-label": "How this looks when rolled" });
  const renderViewToggle = () => {
    setChildren(viewToggle, 
      ...(["wheel", "list"] as const).map((v) =>
        button(v === "wheel" ? "Wheel" : "List", () => {
          model = { ...model, view: v };
          save();
          renderViewToggle();
        }, { "aria-pressed": model.view === v ? "true" : "false" }),
      ),
    );
  };
  renderViewToggle();

  // ---- table ---------------------------------------------------------------

  const tbody = h("tbody");
  const footer = h("div", { class: "faint" });
  const bulkBar = h("div", { class: "row tight", style: { marginTop: "8px" } });

  const filterInput = h("input", { type: "search", placeholder: "Filter outcomes", "aria-label": "Filter outcomes" });
  filterInput.addEventListener("input", () => {
    filter = filterInput.value.trim().toLowerCase();
    renderRows();
  });

  const selectAll = h("input", { type: "checkbox", "aria-label": "Select all outcomes" });
  selectAll.addEventListener("change", () => {
    selection = selectAll.checked ? new Set(model.items.map((i) => i.id)) : new Set();
    renderRows();
  });

  function rowsToShow(): { item: ListItem; index: number }[] {
    const all = model.items.map((item, index) => ({ item, index }));
    const filtered = filter
      ? all.filter(({ item }) =>
          item.label.toLowerCase().includes(filter) || (item.description ?? "").toLowerCase().includes(filter))
      : all;
    if (sortBy === "label") return [...filtered].sort((a, b) => a.item.label.localeCompare(b.item.label));
    if (sortBy === "weight") return [...filtered].sort((a, b) => b.item.weight - a.item.weight);
    return filtered;
  }

  function updateFooter(): void {
    const active = model.items.filter(isRollable).length;
    const total = model.items.reduce((a, i) => a + (isRollable(i) ? i.weight : 0), 0);
    const shown = rowsToShow().length;
    footer.textContent =
      `${model.items.length} outcome${model.items.length === 1 ? "" : "s"} · ${active} active · ` +
      `total weight ${formatWeight(total)}${filter ? ` · showing ${shown}` : ""}`;
  }

  function renderRows(focusItemId?: string, focusField: "label" | "weight" = "label"): void {
    const percents = displayPercents(model.items);
    const colors = wheel.colors();
    setChildren(tbody, 
      ...rowsToShow().map(({ item, index }) => renderRow(item, index, percents[index], colors[index] ?? "#888888")),
    );
    updateFooter();
    renderBulkBar();
    wheel.refresh();
    if (focusItemId) {
      const input = tbody.querySelector(`[data-item="${focusItemId}"] .${focusField}-cell input`);
      (input as HTMLInputElement | null)?.focus();
    }
  }

  function renderRow(item: ListItem, index: number, percent: number, autoColor: string): HTMLTableRowElement {
    const tr = h("tr", { dataset: { item: item.id, index: String(index) }, draggable: "true" });
    if (item.disabled) tr.classList.add("disabled");

    tr.addEventListener("dragstart", (e) => {
      (e as DragEvent).dataTransfer?.setData("text/plain", item.id);
      tr.classList.add("dragging");
    });
    tr.addEventListener("dragend", () => tr.classList.remove("dragging"));
    tr.addEventListener("dragover", (e) => {
      e.preventDefault();
      tr.classList.add("drop-target");
    });
    tr.addEventListener("dragleave", () => tr.classList.remove("drop-target"));
    tr.addEventListener("drop", (e) => {
      e.preventDefault();
      tr.classList.remove("drop-target");
      const draggedId = (e as DragEvent).dataTransfer?.getData("text/plain");
      if (draggedId && draggedId !== item.id) moveItem(draggedId, index);
    });

    const check = h("input", { type: "checkbox", checked: selection.has(item.id), "aria-label": `Select ${item.label}` });
    check.addEventListener("change", () => {
      if (check.checked) selection.add(item.id);
      else selection.delete(item.id);
      renderBulkBar();
    });

    const swatch = h("button", {
      class: `swatch${item.color ? "" : " auto"}`,
      type: "button",
      style: { background: item.color ?? autoColor },
      title: item.color ? `Colour ${item.color}` : "Automatic colour",
      "aria-label": item.color ? `Colour, currently ${item.color}` : "Colour, currently automatic",
    });
    swatch.addEventListener("click", () =>
      openSwatchPicker(swatch, {
        current: item.color ?? null,
        autoColor,
        custom: state.prefs.colours,
        onAddCustom: (colour) => state.addColour(colour),
        onPick: (hex) => {
          update(item.id, (i) => ({ ...i, color: hex ?? undefined }));
        },
      }),
    );

    const label = h("input", { type: "text", value: item.label, "aria-label": "Outcome" });
    label.addEventListener("input", () => update(item.id, (i) => ({ ...i, label: label.value }), false));
    label.addEventListener("keydown", (e) => onRowKey(e as KeyboardEvent, item, index, "label"));

    const weight = h("input", { type: "number", min: "0", step: "any", value: String(item.weight), "aria-label": "Weight" });
    weight.addEventListener("input", () => {
      const v = Number.parseFloat(weight.value);
      if (Number.isFinite(v) && v >= 0) update(item.id, (i) => ({ ...i, weight: v }), false);
    });
    weight.addEventListener("keydown", (e) => onRowKey(e as KeyboardEvent, item, index, "weight"));

    const description = h("input", {
      type: "text",
      value: item.description ?? "",
      "aria-label": "Description",
      placeholder: "—",
    });
    description.addEventListener("input", () =>
      update(item.id, (i) => ({ ...i, description: description.value || undefined }), false));

    const reaction = reactionControl({
      current: item.reaction,
      subject: item.label,
      onChange: (next) => update(item.id, (i) => ({ ...i, reaction: next ?? undefined })),
    });

    const disableButton = iconButton(
      item.disabled ? `Enable ${item.label}` : `Disable ${item.label}`,
      item.disabled ? "☐" : "☑",
      () => toggleDisabled(item.id),
      { class: "icon-button disable-button" },
    );
    const duplicateButton = iconButton(`Duplicate ${item.label}`, "⧉", () => duplicateItem(item.id), {
      class: "icon-button duplicate-button",
    });
    const deleteButton = iconButton(`Delete ${item.label}`, "🗑", () => deleteItems([item.id]), {
      class: "icon-button danger delete-button",
    });

    tr.append(
      h("td", { class: "handle", title: "Drag to reorder" }, "⠿"),
      h("td", {}, check),
      h("td", {}, swatch),
      h("td", { class: "label-cell" }, label),
      h("td", { class: "weight-cell" }, weight),
      h("td", { class: "pct", text: `${percent.toFixed(1)}%` }),
      h("td", { class: "reaction-cell" }, reaction),
      h("td", { class: "desc-cell" }, description),
      h("td", { class: "actions" }, disableButton, duplicateButton, deleteButton),
    );
    return tr;
  }

  function onRowKey(e: KeyboardEvent, item: ListItem, index: number, field: "label" | "weight"): void {
    const meta = e.ctrlKey || e.metaKey;
    if (e.key === "Enter" && !meta) {
      e.preventDefault();
      if (index === model.items.length - 1) addOutcome();
      else renderRows(model.items[index + 1].id, field);
      return;
    }
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      moveItem(item.id, index + (e.key === "ArrowUp" ? -1 : 1));
      return;
    }
    if (meta && e.key.toLowerCase() === "d") {
      e.preventDefault();
      duplicateItem(item.id);
    }
  }

  // ---- mutations -----------------------------------------------------------

  function update(id: string, fn: (item: ListItem) => ListItem, redraw = true): void {
    model = { ...model, items: model.items.map((i) => (i.id === id ? fn(i) : i)) };
    save();
    if (redraw) {
      renderRows();
      return;
    }
    // Update only what does not steal the caret.
    const percents = displayPercents(model.items);
    for (const tr of tbody.querySelectorAll("tr")) {
      const idx = Number((tr as HTMLElement).dataset.index);
      const cell = tr.querySelector(".pct");
      if (cell && Number.isFinite(idx)) cell.textContent = `${percents[idx].toFixed(1)}%`;
    }
    wheel.refresh();
    updateFooter();
  }

  function addOutcome(): void {
    const item = makeItem("New outcome", 1);
    model = { ...model, items: [...model.items, item] };
    save();
    renderRows(item.id, "label");
    const input = tbody.querySelector(`[data-item="${item.id}"] .label-cell input`) as HTMLInputElement | null;
    input?.select();
  }

  function toggleDisabled(id: string): void {
    update(id, (i) => ({ ...i, disabled: i.disabled ? undefined : true }));
  }

  function duplicateItem(id: string): void {
    const index = model.items.findIndex((i) => i.id === id);
    if (index < 0) return;
    const source = model.items[index];
    const copy: ListItem = { ...source, id: newId(), label: `${source.label} (copy)` };
    const items = [...model.items];
    items.splice(index + 1, 0, copy);
    model = { ...model, items };
    save();
    renderRows(copy.id, "label");
  }

  function deleteItems(ids: string[]): void {
    if (model.items.length - ids.length < 1) {
      state.toast("A randomizer needs at least one outcome.");
      return;
    }
    const removed = model.items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => ids.includes(item.id));
    model = { ...model, items: model.items.filter((i) => !ids.includes(i.id)) };
    for (const id of ids) selection.delete(id);
    save();
    renderRows();
    const what = removed.length === 1 ? `"${removed[0].item.label}"` : `${removed.length} outcomes`;
    state.toast(`Deleted ${what}`, "Undo", () => {
      const items = [...model.items];
      for (const { item, index } of removed) items.splice(Math.min(index, items.length), 0, item);
      model = { ...model, items };
      save();
      renderRows();
    });
  }

  function moveItem(id: string, toIndex: number): void {
    const from = model.items.findIndex((i) => i.id === id);
    const to = Math.max(0, Math.min(model.items.length - 1, toIndex));
    if (from < 0 || from === to) return;
    const items = [...model.items];
    const [moved] = items.splice(from, 1);
    items.splice(to, 0, moved);
    model = { ...model, items };
    save();
    renderRows(id);
  }

  function renderBulkBar(): void {
    if (selection.size === 0) {
      const sort = h("select", { "aria-label": "Sort view" },
        ...(["none", "label", "weight"] as const).map((o) =>
          h("option", { value: o, selected: o === sortBy }, o === "none" ? "list order" : `by ${o}`)),
      );
      sort.addEventListener("change", () => {
        sortBy = sort.value as typeof sortBy;
        renderRows();
      });
      setChildren(bulkBar, 
        button("Add outcome", addOutcome, { class: "primary add-outcome" }),
        h("div", { class: "spacer" }),
        h("label", { class: "row tight faint" }, "Sort view", sort),
        sortBy !== "none"
          ? button("Apply order", () => {
              model = { ...model, items: rowsToShow().map(({ item }) => item) };
              sortBy = "none";
              save();
              renderRows();
            })
          : null,
      );
      return;
    }
    const ids = [...selection];
    const bulk = (label: string, fn: (item: ListItem) => ListItem, cls = "") =>
      button(label, () => {
        model = { ...model, items: model.items.map((i) => (selection.has(i.id) ? fn(i) : i)) };
        save();
        renderRows();
      }, { class: cls });

    setChildren(bulkBar, 
      h("span", { class: "faint", text: `${ids.length} selected` }),
      bulk("Disable", (i) => ({ ...i, disabled: true })),
      bulk("Enable", (i) => ({ ...i, disabled: undefined })),
      bulk("Set weight to 1", (i) => ({ ...i, weight: 1 })),
      bulk("Cheer", (i) => ({ ...i, reaction: "cheer" }), "bulk-cheer"),
      bulk("Wince", (i) => ({ ...i, reaction: "wince" }), "bulk-wince"),
      bulk("No reaction", (i) => ({ ...i, reaction: undefined }), "bulk-no-reaction"),
      button("Delete", () => deleteItems(ids), { class: "danger" }),
      button("Clear selection", () => {
        selection = new Set();
        selectAll.checked = false;
        renderRows();
      }, { class: "ghost" }),
    );
  }

  // ---- try it --------------------------------------------------------------

  async function rollNow(): Promise<void> {
    const problem = whyCannotRoll(model);
    if (problem) {
      result.clear(problem);
      return;
    }
    const outcome = rollRandomizer(model, state.source());
    if (model.view === "wheel" && outcome.itemIndex !== undefined) {
      result.pending();
      await wheel.spinTo(outcome.itemIndex, effectiveFeel(state.prefs.feel, model.feel));
    }
    result.show(outcome);
  }

  const feel = feelCard(
    () => model,
    (next) => {
      model = { ...model, feel: next };
      if (!next) delete (model as { feel?: FeelOverride }).feel;
      save();
    },
    () => void rollNow(),
  );

  // ---- layout --------------------------------------------------------------

  const table = h("table", { class: "outcomes" },
    h("thead", {},
      h("tr", {},
        h("th", { "aria-label": "Reorder" }),
        h("th", {}, selectAll),
        h("th", { "aria-label": "Colour" }),
        h("th", { text: "Outcome" }),
        h("th", { text: "Weight" }),
        h("th", { class: "pct", text: "%" }),
        h("th", { text: "Orangey", title: "What the mascot does when this outcome comes up" }),
        h("th", { text: "Description" }),
        h("th", { text: "Actions" }),
      ),
    ),
    tbody,
  );

  const el = h("div", { class: "editor" },
    h("div", { class: "row", style: { marginBottom: "12px" } },
      button("← Back to play", () => navigate(`#/r/${encodeURIComponent(node.path)}`), { class: "ghost" }),
      h("div", { class: "spacer" }),
      savedLabel,
    ),
    h("div", { class: "editor-layout" },
      h("div", { class: "card" },
        h("label", { class: "field" }, h("span", { class: "field-label", text: "Name" }), nameInput),
        h("label", { class: "field" }, h("span", { class: "field-label", text: "Description" }), descInput),
        h("div", { class: "row", style: { marginBottom: "12px" } }, viewToggle, h("div", { class: "spacer" }), filterInput),
        h("div", { class: "table-scroll" }, table),
        bulkBar,
        h("div", { style: { marginTop: "8px" } }, footer),
      ),
      h("div", {},
        h("div", { class: "card" },
          h("h2", { text: "Preview" }),
          wheel.el,
          result.el,
          button("Roll", () => void rollNow(), { class: "primary roll-button", style: { width: "100%" } }),
        ),
        feel,
      ),
    ),
  );

  renderRows();

  const onKey = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && state.undoLast()) e.preventDefault();
  };
  document.addEventListener("keydown", onKey);

  return {
    el,
    destroy() {
      document.removeEventListener("keydown", onKey);
      void state.library.flush();
    },
  };
}

/* -------------------------------------------------------------------------- */

/** Dice, coin and number randomizers have a handful of fields each. */
function createSimpleEditor(node: LibraryNode): View {
  let model = structuredClone(node.randomizer!) as Randomizer;
  const save = () => {
    model = { ...model, modified: new Date().toISOString() } as Randomizer;
    state.library.save(node.path, model);
    void state.library.flush();
  };

  const fields = h("div");
  const name = h("input", { type: "text", value: model.name, "aria-label": "Name" });
  name.addEventListener("input", () => {
    model = { ...model, name: name.value } as Randomizer;
    save();
  });

  if (model.type === "dice") {
    const expr = h("input", { type: "text", value: model.expression, "aria-label": "Dice expression" });
    expr.addEventListener("input", () => {
      model = { ...model, expression: expr.value } as Randomizer;
      save();
    });
    fields.append(h("label", { class: "field" }, h("span", { class: "field-label", text: "Expression" }), expr));
  } else if (model.type === "coin") {
    const faceRows = h("div");
    const renderFaces = () => {
      const coin = model as CoinRandomizer;
      setChildren(faceRows, ...coin.faces.map((face, i) => {
        const input = h("input", { type: "text", value: face, "aria-label": `Face ${i + 1}` });
        input.addEventListener("input", () => {
          const faces = [...(model as CoinRandomizer).faces] as [string, string];
          faces[i] = input.value;
          model = { ...model, faces } as Randomizer;
          save();
        });
        const reaction = reactionControl({
          current: coin.faceReactions?.[i] ?? null,
          subject: face || `face ${i + 1}`,
          onChange: (next) => {
            const fr = [...(coin.faceReactions ?? [null, null])] as [OutcomeReaction | null, OutcomeReaction | null];
            fr[i] = next;
            const cleared = fr.every((r) => r === null);
            model = { ...model, faceReactions: cleared ? undefined : fr } as Randomizer;
            if (cleared) delete (model as CoinRandomizer).faceReactions;
            save();
            renderFaces();
          },
        });
        return h("label", { class: "field" },
          h("span", { class: "field-label", text: `Face ${i + 1}` }),
          h("div", { class: "row tight face-row" }, input, h("span", { class: "faint", text: "Orangey" }), reaction),
        );
      }));
    };
    renderFaces();
    fields.append(faceRows);
  } else if (model.type === "number") {
    const numberField = (key: "min" | "max" | "count", label: string) => {
      const input = h("input", { type: "number", value: String((model as never)[key]), "aria-label": label });
      input.addEventListener("input", () => {
        const v = Number.parseFloat(input.value);
        if (Number.isFinite(v)) {
          model = { ...model, [key]: v } as Randomizer;
          save();
        }
      });
      return h("label", { class: "field" }, h("span", { class: "field-label", text: label }), input);
    };
    const toggle = (key: "integer" | "unique" | "inclusiveMax", label: string) => {
      const input = h("input", { type: "checkbox", checked: (model as never)[key] as unknown as boolean });
      input.addEventListener("change", () => {
        model = { ...model, [key]: input.checked } as Randomizer;
        save();
      });
      return h("label", { class: "row tight" }, input, label);
    };
    fields.append(
      numberField("min", "Minimum"),
      numberField("max", "Maximum"),
      numberField("count", "How many"),
      toggle("integer", "Whole numbers"),
      toggle("unique", "No repeats"),
      toggle("inclusiveMax", "Include the maximum"),
    );
  }

  const feel = feelCard(
    () => model,
    (next) => {
      model = { ...model, feel: next } as Randomizer;
      if (!next) delete (model as { feel?: FeelOverride }).feel;
      save();
    },
  );

  return {
    el: h("div", {},
      h("div", { class: "card" },
        h("h1", { text: `Edit ${model.name}` }),
        h("label", { class: "field" }, h("span", { class: "field-label", text: "Name" }), name),
        fields,
        button("← Back to play", () => navigate(`#/r/${encodeURIComponent(node.path)}`), { class: "ghost" }),
      ),
      feel,
    ),
    destroy() {
      void state.library.flush();
    },
  };
}
