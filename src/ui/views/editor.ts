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
import { makeItem, newId, OFFER_MAX, OFFER_MIN } from "../../model/randomizer.ts";
import { labelFor } from "../../core/color.ts";
import { wheelProblems } from "../../core/theme.ts";
import { createColourField } from "../components/colourfield.ts";
import { describeThemeProblem } from "../components/themecard.ts";
import { draftProblem } from "../../model/draft.ts";
import type { View } from "../view.ts";
import type { LibraryNode } from "../../storage/library.ts";
import { button, h, iconButton, setChildren } from "../dom.ts";
import { state } from "../state.ts";
import { createWheel } from "../components/wheel.ts";
import { openSwatchPicker } from "../components/swatch.ts";
import { reactionControl } from "../components/reaction.ts";
import { pictureCell } from "../components/picture.ts";
import { pickRandomizer } from "../components/picker.ts";
import { pruneImages } from "../../storage/images.ts";
import { usedImageIds } from "../storage-actions.ts";
import { longestOutcome } from "../roll.ts";
import { createRoller } from "../rolling.ts";
import { createResultPanel } from "../components/result.ts";
import { backTarget, currentRoute, editHash, navigate, parseRoute, referrer } from "../router.ts";
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

/**
 * `from` is the address of the screen that opened this editor, if any; Back
 * returns there. See `referrer` in router.ts.
 */
export function createEditorView(node: LibraryNode, from?: string): View {
  const randomizer = node.randomizer!;
  if (randomizer.type !== "list") return createSimpleEditor(node);
  return createListEditor(node, randomizer, from);
}

function inLibrary(path: string): boolean {
  return state.library.find(path)?.randomizer != null;
}

/**
 * The editor's own Back, which goes exactly where the top bar's does, so the
 * two can never disagree. It names the place when that is not simply this
 * randomizer's play screen: "Back to play" from a new wheel made on a board
 * would be a promise the button does not keep.
 */
function editorBackButton(): HTMLElement {
  const there = referrer(currentRoute(), inLibrary);
  const target = there ? parseRoute(there) : null;
  const name = target && "path" in target ? state.library.find(target.path)?.randomizer?.name : undefined;
  return button(name ? `← Back to ${name}` : "← Back to play", () => navigate(backTarget(currentRoute(), null, inLibrary)), { class: "ghost" });
}

function formatWeight(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

/* -------------------------------------------------------------------------- */

function createListEditor(node: LibraryNode, initial: ListRandomizer, from?: string): View {
  let model: ListRandomizer = structuredClone(initial);
  let selection = new Set<string>();
  let filter = "";
  let sortBy: "none" | "label" | "weight" = "none";

  const savedLabel = h("span", { class: "faint", text: "All changes saved" });

  /**
   * Save, unless the draft is one the app could not read back.
   *
   * The file on disk keeps the last good state and the draft stays in the
   * editor, marked invalid, so the half-typed weight or the empty label can
   * be finished rather than thrown away. `source` is the field whose handler
   * asked to save, which is the one to mark.
   */
  const save = (source?: HTMLElement) => {
    const problem = draftProblem(model);
    if (problem) {
      savedLabel.textContent = `Not saved: ${problem}`;
      source?.setAttribute("aria-invalid", "true");
      return;
    }
    for (const marked of el.querySelectorAll("[aria-invalid]")) marked.removeAttribute("aria-invalid");
    savedLabel.textContent = "Saving…";
    // Queue it and nothing more. The library debounces the write; flushing
    // here meant every keystroke serialised the whole file and waited for the
    // disk.
    model = { ...model, modified: new Date().toISOString() };
    state.library.save(node.path, model);
  };

  /**
   * A structural change: a button, not a keystroke.
   *
   * Typing is debounced by the library, but a press that also moves focus
   * fires `focusout` on mousedown — before the handler that changes anything
   * — so a blur alone would leave the change it made waiting on the timer.
   * These are rare and deliberate, so they go to disk at once.
   */
  const saveNow = (source?: HTMLElement) => {
    save(source);
    flushNow();
  };

  /** Put what is queued on disk now, and say how it went. */
  function flushNow(): void {
    if (!state.library.hasUnsavedChanges) return;
    void state.library.flush().then(
      () => {
        if (!draftProblem(model)) savedLabel.textContent = "All changes saved";
      },
      () => {
        savedLabel.textContent = "Not saved";
      },
    );
  }

  const wheel = createWheel({
    items: () => model.items,
    id: () => model.id,
    slices: () => model.slices,
    colours: () => state.wheelColours(model.palette),
    onActivate: () => void rollNow(),
  });
  const result = createResultPanel("Try it");

  // ---- header --------------------------------------------------------------

  const nameInput = h("input", { type: "text", value: model.name, "aria-label": "Name" });
  nameInput.addEventListener("input", () => {
    model = { ...model, name: nameInput.value };
    save(nameInput);
  });
  nameInput.addEventListener("blur", async () => {
    if (!model.name.trim()) return;
    // Renaming moves the file. An invalid draft has not been written to the
    // old name, so moving it would carry the wrong contents to the new one.
    if (draftProblem(model)) return;
    await state.library.flush();
    const path = await state.library.rename(node.path, model.name);
    if (path !== node.path) navigate(editHash(path, from), true);
  });

  const descInput = h("input", { type: "text", value: model.description ?? "", "aria-label": "Description" });
  descInput.addEventListener("input", () => {
    model = { ...model, description: descInput.value || undefined };
    save(descInput);
  });

  // Bag mode. Editing the outcomes does not empty or refill the bag: what has
  // been drawn is per device and lives in the app database, not in the file.
  const bagToggle = h("input", { type: "checkbox", class: "bag-toggle", checked: model.withoutReplacement === true });
  bagToggle.addEventListener("change", () => {
    model = { ...model, withoutReplacement: bagToggle.checked || undefined };
    if (!bagToggle.checked) delete (model as { withoutReplacement?: boolean }).withoutReplacement;
    saveNow(bagToggle);
  });
  const bagField = h("label", { class: "row tight" }, bagToggle, "Draw without putting back");

  // Make a choice. Empty is off. What is typed is kept in the draft even when
  // it is out of range, so it can be finished; `draftProblem` holds the file
  // at its last good state meanwhile, as for any other field.
  const offerInput = h("input", {
    type: "number", min: String(OFFER_MIN), max: String(OFFER_MAX), class: "offer-input",
    value: model.offer !== undefined ? String(model.offer) : "", placeholder: "–",
    "aria-label": "Offer this many outcomes to choose from",
  });
  offerInput.addEventListener("input", () => {
    const raw = offerInput.value.trim();
    model = { ...model, offer: raw === "" ? undefined : Number(raw) };
    if (raw === "") delete (model as { offer?: number }).offer;
    // Cards drawn for the old number would not fit the row the new one lays out.
    previewRoller.discard();
    result.clear("Try it");
    save(offerInput);
  });
  const offerField = h("label", { class: "row tight offer-field" }, "Offer", offerInput, "to choose from");

  const viewToggle = h("div", { class: "segmented", role: "group", "aria-label": "How this looks when rolled" });
  const renderViewToggle = () => {
    setChildren(viewToggle, 
      ...(["wheel", "list"] as const).map((v) =>
        button(v === "wheel" ? "Wheel" : "List", () => {
          model = { ...model, view: v };
          saveNow();
          renderViewToggle();
          renderSlicesToggle();
          renderPalette();
        }, { "aria-pressed": model.view === v ? "true" : "false" }),
      ),
    );
  };
  renderViewToggle();

  // A wheel's own colours, over the theme's. Three in turn and an optional
  // spare, chosen with the same fields as the theme card; the same check runs
  // on them, and its findings are shown, not enforced — as with an outcome's
  // own colour, a clash the person chose is reported, not refused.
  const paletteGroup = h("div", { class: "segmented palette-toggle", role: "group", "aria-label": "Slice colours" });
  const paletteField = h("div", { class: "row tight palette-field" }, h("span", { class: "faint", text: "Colours" }), paletteGroup);
  const paletteFields = h("div", { class: "palette-fields" });
  const paletteProblems = h("ul", { class: "palette-problems" });
  const setPalette = (next: string[] | undefined): void => {
    model = { ...model, palette: next };
    if (!next) delete (model as { palette?: string[] }).palette;
    save();
    renderPaletteProblems();
    renderRows();
  };
  const renderPaletteProblems = (): void => {
    // The spare is the theme's unless this wheel has its own; a note about
    // someone else's colour is not this editor's business.
    const problems = model.palette
      ? wheelProblems(state.wheelColours(model.palette)).filter((p) => !p.note || (model.palette?.length ?? 0) > 3)
      : [];
    setChildren(paletteProblems, ...problems.map((p) => h("li", { class: p.note ? "faint" : "warning", text: describeThemeProblem(p) })));
    paletteProblems.hidden = problems.length === 0;
  };
  const renderPalette = (): void => {
    const own = model.palette !== undefined;
    paletteField.hidden = model.view !== "wheel";
    setChildren(paletteGroup,
      button("Theme's", () => { setPalette(undefined); renderPalette(); }, { "aria-pressed": own ? "false" : "true", class: "palette-theme" }),
      button("This wheel's", () => {
        if (!model.palette) setPalette(state.wheelColours().slice(0, 3));
        renderPalette();
      }, { "aria-pressed": own ? "true" : "false", class: "palette-own" }),
    );
    paletteFields.hidden = !own || model.view !== "wheel";
    if (!own || !model.palette) {
      setChildren(paletteFields);
      renderPaletteProblems();
      return;
    }
    const current = model.palette;
    const colour = (label: string, i: number, value: string) =>
      createColourField(label, `palette${i}`, value, (hex) => {
        const next = [...(model.palette ?? current)];
        next[i] = hex;
        setPalette(next);
      }, true).el;
    const spareBox = h("input", { type: "checkbox", class: "palette-spare-toggle", checked: current.length > 3, "aria-label": "This wheel has its own spare colour" });
    spareBox.addEventListener("change", () => {
      const base = (model.palette ?? current).slice(0, 3);
      setPalette(spareBox.checked ? [...base, state.wheelColours()[3]] : base);
      renderPalette();
    });
    setChildren(paletteFields,
      colour("Wheel 1", 0, current[0]),
      colour("Wheel 2", 1, current[1]),
      colour("Wheel 3", 2, current[2]),
      current.length > 3
        ? h("div", {}, colour("Spare", 3, current[3]), h("label", { class: "row tight faint" }, spareBox, "Own spare"))
        : h("label", { class: "row tight faint palette-spare" }, spareBox, "Own spare (else the theme's)"),
    );
    renderPaletteProblems();
  };

  // What a slice with a picture shows. Offered only where it changes
  // something — a wheel with at least one picture — and written to the file
  // only when it is not the default, so most files never carry it.
  const slicesGroup = h("div", { class: "segmented", role: "group", "aria-label": "Slices show" });
  const slicesField = h("div", { class: "row tight slices-field" }, h("span", { class: "faint", text: "Slices show" }), slicesGroup);
  const SLICE_NAMES = { pictures: "Pictures", names: "Names", both: "Both" } as const;
  const renderSlicesToggle = () => {
    slicesField.hidden = model.view !== "wheel" || !model.items.some((i) => i.image);
    const current = model.slices ?? "pictures";
    setChildren(slicesGroup,
      ...(["pictures", "names", "both"] as const).map((v) =>
        button(SLICE_NAMES[v], () => {
          model = { ...model, slices: v };
          if (v === "pictures") delete (model as { slices?: string }).slices;
          saveNow();
          renderSlicesToggle();
          wheel.refresh();
        }, { "aria-pressed": current === v ? "true" : "false" }),
      ),
    );
  };

  // ---- table ---------------------------------------------------------------

  const tbody = h("tbody");
  const footer = h("div", { class: "faint" });
  const bulkBar = h("div", { class: "row tight gap-s" });

  const filterInput = h("input", { type: "search", placeholder: "Filter outcomes", "aria-label": "Filter outcomes" });
  filterInput.addEventListener("input", () => {
    filter = filterInput.value.trim().toLowerCase();
    rowLimit = ROW_BLOCK;
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

  /**
   * How many rows the table draws at once.
   *
   * An imported table can be thousands of outcomes, and a browser asked for
   * a thousand rows of eleven cells each — with an input in four of them —
   * stops being usable. The filter still searches every outcome; this is
   * only how many are on screen.
   */
  const ROW_BLOCK = 300;
  let rowLimit = ROW_BLOCK;

  /** The row an event happened in, and the outcome it belongs to. */
  function rowFor(target: EventTarget | null): { item: ListItem; index: number; tr: HTMLElement } | null {
    const tr = (target as Element | null)?.closest?.("tr[data-item]") as HTMLElement | null;
    if (!tr) return null;
    const id = tr.dataset.item;
    const index = Number(tr.dataset.index);
    const item = model.items.find((i) => i.id === id);
    if (!item || !Number.isFinite(index)) return null;
    return { item, index, tr };
  }

  tbody.addEventListener("input", (e) => {
    const where = rowFor(e.target);
    if (!where) return;
    const el = e.target as HTMLInputElement;
    if (el.closest(".label-cell")) update(where.item.id, (i) => ({ ...i, label: el.value }), false, el);
    else if (el.closest(".weight-cell")) {
      const v = Number.parseFloat(el.value);
      if (Number.isFinite(v) && v >= 0) update(where.item.id, (i) => ({ ...i, weight: v }), false, el);
    } else if (el.closest(".desc-cell")) {
      update(where.item.id, (i) => ({ ...i, description: el.value || undefined }), false, el);
    }
  });

  tbody.addEventListener("change", (e) => {
    const where = rowFor(e.target);
    const el = e.target as HTMLInputElement;
    if (!where || !el.classList.contains("row-select")) return;
    if (el.checked) selection.add(where.item.id);
    else selection.delete(where.item.id);
    renderBulkBar();
  });

  tbody.addEventListener("keydown", (e) => {
    const where = rowFor(e.target);
    if (!where) return;
    const el = e.target as HTMLElement;
    const field = el.closest(".weight-cell") ? "weight" : el.closest(".label-cell") ? "label" : null;
    if (field) onRowKey(e as KeyboardEvent, where.item, where.index, field);
  });

  tbody.addEventListener("click", (e) => {
    const where = rowFor(e.target);
    if (!where) return;
    const el = e.target as HTMLElement;
    const { item } = where;
    if (el.closest(".disable-button")) toggleDisabled(item.id);
    else if (el.closest(".duplicate-button")) duplicateItem(item.id);
    else if (el.closest(".delete-button")) deleteItems([item.id]);
    else if (el.closest(".clear-goes-to")) update(item.id, (i) => ({ ...i, goesTo: undefined }));
    else if (el.closest(".goes-to-button")) void chooseTarget(item);
    else {
      const swatch = el.closest(".swatch") as HTMLElement | null;
      if (!swatch) return;
      openSwatchPicker(swatch, {
        current: item.color ?? null,
        autoColor: wheel.colors()[where.index] ?? "#888888",
        custom: state.prefs.colours,
        onAddCustom: (colour) => state.addColour(colour),
        onPick: (hex) => update(item.id, (i) => ({ ...i, color: hex ?? undefined })),
      });
    }
  });

  tbody.addEventListener("dragstart", (e) => {
    const where = rowFor(e.target);
    if (!where) return;
    (e as DragEvent).dataTransfer?.setData("text/plain", where.item.id);
    where.tr.classList.add("dragging");
  });
  tbody.addEventListener("dragend", (e) => rowFor(e.target)?.tr.classList.remove("dragging"));
  tbody.addEventListener("dragover", (e) => {
    const where = rowFor(e.target);
    if (!where) return;
    e.preventDefault();
    where.tr.classList.add("drop-target");
  });
  tbody.addEventListener("dragleave", (e) => rowFor(e.target)?.tr.classList.remove("drop-target"));
  tbody.addEventListener("drop", (e) => {
    const where = rowFor(e.target);
    if (!where) return;
    e.preventDefault();
    where.tr.classList.remove("drop-target");
    const draggedId = (e as DragEvent).dataTransfer?.getData("text/plain");
    if (draggedId && draggedId !== where.item.id) moveItem(draggedId, where.index);
  });

  function renderRows(focusItemId?: string, focusField: "label" | "weight" = "label"): void {
    const percents = displayPercents(model.items);
    // Before the colours are read, not after: `refresh` is what recomputes
    // them, so asking first showed each row the colour its outcome had one
    // edit ago.
    wheel.refresh();
    // A picture added or removed decides whether the choice is offered at all.
    renderSlicesToggle();
    const colors = wheel.colors();
    const rows = rowsToShow();
    // If the one to focus is past the end of what is drawn, draw far enough
    // to include it: Enter on the last visible row must still reach the next.
    if (focusItemId) {
      const at = rows.findIndex(({ item }) => item.id === focusItemId);
      if (at >= rowLimit) rowLimit = Math.ceil((at + 1) / ROW_BLOCK) * ROW_BLOCK;
    }
    const visible = rows.slice(0, rowLimit);
    const hidden = rows.length - visible.length;
    setChildren(tbody, 
      ...visible.map(({ item, index }) => renderRow(item, index, percents[index], colors[index] ?? "#888888")),
      hidden > 0
        ? h("tr", { class: "more-rows" },
            h("td", { colspan: "11" },
              button(`Show ${Math.min(ROW_BLOCK, hidden)} more of ${hidden}`, () => {
                rowLimit += ROW_BLOCK;
                renderRows();
              }, { class: "ghost show-more-rows" }),
            ),
          )
        : null,
    );
    updateFooter();
    renderBulkBar();
    if (focusItemId) {
      const input = tbody.querySelector(`[data-item="${focusItemId}"] .${focusField}-cell input`);
      (input as HTMLInputElement | null)?.focus();
    }
  }

  /** The buttons' work is done by the delegated click handler. */
  const noop = (): void => {};

  function renderRow(item: ListItem, index: number, percent: number, autoColor: string): HTMLTableRowElement {
    const tr = h("tr", { dataset: { item: item.id, index: String(index) }, draggable: "true" });
    if (item.disabled) tr.classList.add("disabled");

    // No listeners on the row itself: `tbody` carries one of each for the
    // whole table (see `delegate` below). Forty rows used to mean six hundred
    // listeners, all of them torn down and rebuilt on every edit.
    const check = h("input", { type: "checkbox", class: "row-select", checked: selection.has(item.id), "aria-label": `Select ${item.label}` });

    const swatch = h("button", {
      class: `swatch${item.color ? "" : " auto"}`,
      type: "button",
      // The "A" on an automatic swatch in whichever ink reads on that colour:
      // white vanished on a pale theme's wheel colours.
      style: `background: ${item.color ?? autoColor}; --auto-ink: ${labelFor(item.color ?? autoColor).ink}`,
      title: item.color ? `Colour ${item.color}` : "Automatic colour",
      "aria-label": item.color ? `Colour, currently ${item.color}` : "Colour, currently automatic",
    });

    const label = h("input", { type: "text", value: item.label, "aria-label": "Outcome" });
    const weight = h("input", { type: "number", min: "0", step: "any", value: String(item.weight), "aria-label": "Weight" });
    const description = h("input", {
      type: "text",
      value: item.description ?? "",
      "aria-label": "Description",
      placeholder: "—",
    });

    const reaction = reactionControl({
      current: item.reaction,
      subject: item.label,
      onChange: (next) => update(item.id, (i) => ({ ...i, reaction: next ?? undefined })),
    });

    const picture = pictureCell({
      current: () => item.image,
      subject: () => item.label,
      onChange: (id) => update(item.id, (i) => ({ ...i, image: id })),
    });

    // Where this outcome sends you. A table that points at another table is
    // how encounter tables have always been written. A dropdown of every
    // randomizer was fine with six of them; a real game has folders, so this
    // opens the library instead.
    const target = item.goesTo ? state.library.findById(item.goesTo) : null;
    const goesToLabel = item.goesTo
      ? (target?.randomizer?.name ?? "(not in your library)")
      : "—";
    const goesTo = h("span", { class: "row tight goes-to" },
      button(goesToLabel, noop, {
        class: `ghost goes-to-button${item.goesTo && !target ? " missing" : ""}`,
        "aria-label": `Where ${item.label} sends you: ${goesToLabel}`,
      }),
      ...(item.goesTo
        ? [iconButton(`Stop ${item.label} sending you anywhere`, "✕", noop, { class: "icon-button clear-goes-to" })]
        : []),
    );

    const disableButton = iconButton(
      item.disabled ? `Enable ${item.label}` : `Disable ${item.label}`,
      item.disabled ? "☐" : "☑",
      noop,
      { class: "icon-button disable-button" },
    );
    const duplicateButton = iconButton(`Duplicate ${item.label}`, "⧉", noop, {
      class: "icon-button duplicate-button",
    });
    const deleteButton = iconButton(`Delete ${item.label}`, "🗑", noop, {
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
      h("td", { class: "picture-col" }, picture),
      h("td", { class: "goes-to-cell" }, goesTo),
      h("td", { class: "desc-cell" }, description),
      h("td", { class: "actions" }, disableButton, duplicateButton, deleteButton),
    );
    return tr;
  }

  /** Pick what this outcome sends you to, from the library or a link. */
  async function chooseTarget(item: ListItem): Promise<void> {
    const picked = await pickRandomizer({
      title: `Where does "${item.label}" send you?`,
      taken: () => new Set([model.id]),
      allowNew: true,
      allowLink: true,
      allowNotation: true,
    });
    if (!picked) return;
    update(item.id, (i) => ({ ...i, goesTo: picked.randomizer.id }));
    // A randomizer made for this is empty, so it opens where you can fill it in.
    if (picked.fresh) {
      await state.library.flush();
      // Back from there returns here, to this editor, not to its play screen.
      navigate(editHash(picked.path, editHash(node.path, from)));
    }
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

  function update(id: string, fn: (item: ListItem) => ListItem, redraw = true, source?: HTMLElement): void {
    model = { ...model, items: model.items.map((i) => (i.id === id ? fn(i) : i)) };
    save(source);
    if (redraw) {
      // Not typing: a colour, a reaction, a picture, a row disabled.
      flushNow();
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
    refreshWheelSoon();
    updateFooter();
  }

  /**
   * At most one wheel redraw per frame.
   *
   * Typing a label fires an input event per character, and each redraw lays
   * out and re-measures every slice. The screen only updates once a frame in
   * any case, so the ones in between were work nobody saw.
   */
  let wheelFrame = 0;
  function refreshWheelSoon(): void {
    if (wheelFrame) return;
    wheelFrame = requestAnimationFrame(() => {
      wheelFrame = 0;
      wheel.refresh();
    });
  }

  function addOutcome(): void {
    const item = makeItem("New outcome", 1);
    model = { ...model, items: [...model.items, item] };
    saveNow();
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
    saveNow();
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
    saveNow();
    renderRows();
    const what = removed.length === 1 ? `"${removed[0].item.label}"` : `${removed.length} outcomes`;
    state.toast(`Deleted ${what}`, "Undo", () => {
      const items = [...model.items];
      for (const { item, index } of removed) items.splice(Math.min(index, items.length), 0, item);
      model = { ...model, items };
      saveNow();
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
    saveNow();
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
              saveNow();
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
        saveNow();
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

  // A preview, not a roll: `live: false` keeps it out of history and says
  // nothing to Orangey, because trying out a wheel you are building is not
  // the table rolling it.
  const previewRoller = createRoller({
    randomizer: () => model,
    result,
    wheel: () => (model.view === "wheel" ? wheel : null),
    feel: () => effectiveFeel(state.prefs.feel, model.feel),
    live: false,
  });

  async function rollNow(): Promise<void> {
    // The labels change as they are typed, so the preview re-reserves its
    // height on every try rather than once at the start.
    const offer = model.offer !== undefined && Number.isInteger(model.offer) && model.offer >= OFFER_MIN && model.offer <= OFFER_MAX ? model.offer : 0;
    result.reserve(longestOutcome(model), { seed: state.prefs.seed !== null, offer });
    // Trying it again while cards are out deals a fresh hand: this is a
    // preview, and nothing it draws is kept.
    if (previewRoller.choosing) previewRoller.discard();
    await previewRoller.roll();
  }

  const feel = feelCard(
    () => model,
    (next) => {
      model = { ...model, feel: next };
      if (!next) delete (model as { feel?: FeelOverride }).feel;
      saveNow();
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
        h("th", { text: "Picture", title: "Shown when this outcome comes up" }),
        h("th", { text: "Goes to", title: "Rolling this outcome opens another randomizer beside the wheel" }),
        h("th", { text: "Description" }),
        h("th", { text: "Actions" }),
      ),
    ),
    tbody,
  );

  const el = h("div", { class: "editor" },
    h("div", { class: "row", style: { marginBottom: "12px" } },
      editorBackButton(),
      h("div", { class: "spacer" }),
      savedLabel,
    ),
    h("div", { class: "editor-layout" },
      h("div", { class: "card" },
        h("label", { class: "field" }, h("span", { class: "field-label", text: "Name" }), nameInput),
        h("label", { class: "field" }, h("span", { class: "field-label", text: "Description" }), descInput),
        h("div", { class: "row", style: { marginBottom: "12px" } }, viewToggle, bagField, offerField, paletteField, slicesField, h("div", { class: "spacer" }), filterInput),
        paletteFields,
        paletteProblems,
        h("div", { class: "table-scroll" }, table),
        bulkBar,
        h("div", { class: "gap-s" }, footer),
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
  renderPalette();

  // Leaving a field is the moment a person expects their change to be safe,
  // and it is rare enough to write on. Typing is not.
  el.addEventListener("focusout", () => flushNow());

  const onKey = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && state.undoLast()) e.preventDefault();
  };
  document.addEventListener("keydown", onKey);

  return {
    el,
    destroy() {
      document.removeEventListener("keydown", onKey);
      if (wheelFrame) cancelAnimationFrame(wheelFrame);
      const problem = draftProblem(model);
      if (problem) state.toast(`Your last change to ${model.name} was not saved: ${problem}`);
      // Pictures taken off an outcome are swept up when the editor closes,
      // not when the ✕ is pressed: the same picture may be on another outcome
      // or another randomizer, and undo may yet bring this one back.
      void state.library
        .flush()
        .then(() => pruneImages(usedImageIds(state.library.files().map((f) => f.randomizer!).filter(Boolean))))
        .catch(() => {});
    },
  };
}

/* -------------------------------------------------------------------------- */

/** Dice, coin and number randomizers have a handful of fields each. */
function createSimpleEditor(node: LibraryNode): View {
  let model = structuredClone(node.randomizer!) as Randomizer;
  const savedLabel = h("span", { class: "faint", text: "All changes saved" });
  const el = h("div");

  // As in the list editor: a draft the app could not read back is kept in the
  // editor and marked, and the file on disk keeps its last good state. Half a
  // dice expression is the ordinary way to type a whole one.
  const save = (source?: HTMLElement) => {
    const problem = draftProblem(model);
    if (problem) {
      savedLabel.textContent = `Not saved: ${problem}`;
      source?.setAttribute("aria-invalid", "true");
      return;
    }
    for (const marked of el.querySelectorAll("[aria-invalid]")) marked.removeAttribute("aria-invalid");
    savedLabel.textContent = "Saving…";
    model = { ...model, modified: new Date().toISOString() } as Randomizer;
    state.library.save(node.path, model);
  };

  function flushNow(): void {
    if (!state.library.hasUnsavedChanges) return;
    void state.library.flush().then(
      () => {
        if (!draftProblem(model)) savedLabel.textContent = "All changes saved";
      },
      () => {
        savedLabel.textContent = "Not saved";
      },
    );
  }

  el.addEventListener("focusout", () => flushNow());

  const fields = h("div");
  const name = h("input", { type: "text", value: model.name, "aria-label": "Name" });
  name.addEventListener("input", () => {
    model = { ...model, name: name.value } as Randomizer;
    save(name);
  });

  if (model.type === "dice") {
    const expr = h("input", { type: "text", value: model.expression, "aria-label": "Dice expression" });
    expr.addEventListener("input", () => {
      model = { ...model, expression: expr.value } as Randomizer;
      save(expr);
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
          save(input);
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
          save(input);
        }
      });
      return h("label", { class: "field" }, h("span", { class: "field-label", text: label }), input);
    };
    const toggle = (key: "integer" | "unique" | "inclusiveMax", label: string) => {
      const input = h("input", { type: "checkbox", checked: (model as never)[key] as unknown as boolean });
      input.addEventListener("change", () => {
        model = { ...model, [key]: input.checked } as Randomizer;
        save(input);
        flushNow();
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

  el.append(
    h("div", { class: "card" },
      h("div", { class: "row", style: { marginBottom: "12px" } }, h("div", { class: "spacer" }), savedLabel),
      h("h1", { text: `Edit ${model.name}` }),
      h("label", { class: "field" }, h("span", { class: "field-label", text: "Name" }), name),
      fields,
      editorBackButton(),
    ),
    feel,
  );

  return {
    el,
    destroy() {
      const problem = draftProblem(model);
      if (problem) state.toast(`Your last change to ${model.name} was not saved: ${problem}`);
      void state.library.flush().catch(() => {});
    },
  };
}
