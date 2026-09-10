/**
 * The colour cell: a grid of named palette swatches, a free hex field, and a
 * way back to the automatic colour (plan C8.2).
 */

import { chroma, hexToOklab, hueAngle, isHex } from "../../core/color.ts";
import { PALETTE, type PaletteColor } from "../styles/palette.ts";
import { MAX_COLOUR_NAME, MAX_CUSTOM_COLOURS, type CustomColour } from "../../model/settings-file.ts";
import { button, h } from "../dom.ts";

/**
 * The palette, grouped by hue and ordered light to dark within each group,
 * so a colour can be found by eye rather than by scrolling a long strip.
 */
const HUE_GROUPS: [string, number, number][] = [
  ["Reds", 345, 25],
  ["Oranges", 25, 65],
  ["Yellows", 65, 105],
  ["Greens", 105, 175],
  ["Teals & blues", 175, 265],
  ["Purples", 265, 310],
  ["Pinks", 310, 345],
];

export function groupedPalette(colours: PaletteColor[] = PALETTE): { title: string; colours: PaletteColor[] }[] {
  const with_ = colours.map((c) => {
    const lab = hexToOklab(c.hex);
    return { colour: c, hue: hueAngle(lab), chroma: chroma(lab), L: lab.L };
  });
  const neutral = with_.filter((c) => c.chroma < 0.035);
  const groups = HUE_GROUPS.map(([title, from, to]) => ({
    title,
    colours: with_
      .filter((c) => c.chroma >= 0.035 && (from < to ? c.hue >= from && c.hue < to : c.hue >= from || c.hue < to))
      .sort((a, b) => b.L - a.L)
      .map((c) => c.colour),
  })).filter((g) => g.colours.length > 0);
  if (neutral.length) groups.push({ title: "Neutrals", colours: neutral.sort((a, b) => b.L - a.L).map((c) => c.colour) });
  return groups;
}

export interface SwatchPickerOptions {
  current: string | null;
  autoColor: string;
  onPick: (hex: string | null) => void;
  /** The user's own colours, shown first. */
  custom?: readonly CustomColour[];
  /** Offered when given: a colour input and a name, saved to the user's palette. */
  onAddCustom?: (colour: CustomColour) => void;
}

/** The name of a colour, from the user's own colours first, then the dictionary. */
export function colourName(hex: string, custom: readonly CustomColour[] = []): string {
  const h = hex.toLowerCase();
  return custom.find((c) => c.hex === h)?.name ?? PALETTE.find((c) => c.hex.toLowerCase() === h)?.name ?? hex;
}

export function openSwatchPicker(anchor: HTMLElement, opts: SwatchPickerOptions): void {
  const dialog = h("dialog", { class: "swatch-dialog", "aria-label": "Choose a colour" });

  const custom = opts.custom ?? [];
  const grid = h("div", { class: "swatch-groups", role: "group", "aria-label": "Palette" });
  const nameOut = h("div", { class: "faint swatch-name", text: opts.current ? colourName(opts.current, custom) : "Automatic" });
  const groups = [...(custom.length ? [{ title: "My colours", colours: custom as PaletteColor[] }] : []), ...groupedPalette()];
  for (const group of groups) {
    const row = h("div", { class: `swatch-grid${group.title === "My colours" ? " swatch-grid-custom" : ""}` });
    for (const colour of group.colours) {
      const b = button("", () => {
        opts.onPick(colour.hex);
        dialog.close();
      }, {
        style: { background: colour.hex },
        title: `${colour.name} ${colour.hex}`,
        "aria-label": colour.name,
        "aria-pressed": opts.current?.toLowerCase() === colour.hex.toLowerCase() ? "true" : "false",
        onmouseenter: () => { nameOut.textContent = `${colour.name} · ${colour.hex}`; },
        onfocus: () => { nameOut.textContent = `${colour.name} · ${colour.hex}`; },
      });
      row.appendChild(b);
    }
    grid.append(h("h3", { class: "swatch-group-title", text: group.title }), row);
  }

  const hexInput = h("input", {
    type: "text",
    value: opts.current ?? "",
    placeholder: opts.autoColor,
    "aria-label": "Colour as hex",
    spellcheck: "false",
  });
  const apply = () => {
    const v = hexInput.value.trim();
    if (v === "") {
      opts.onPick(null);
      dialog.close();
      return;
    }
    if (!isHex(v)) {
      hexInput.setAttribute("aria-invalid", "true");
      return;
    }
    opts.onPick(v.startsWith("#") ? v : `#${v}`);
    dialog.close();
  };
  hexInput.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") {
      e.preventDefault();
      apply();
    }
  });

  // Add to my colours: the browser's own picker plus a name. Saving also
  // applies it, because that is why anyone opens this dialog.
  let addRow: HTMLElement | null = null;
  if (opts.onAddCustom) {
    const colourInput = h("input", { type: "color", value: isHex(opts.current ?? "") ? opts.current! : "#a33a30", "aria-label": "New colour" });
    const nameInput = h("input", { type: "text", placeholder: "Name it", maxlength: String(MAX_COLOUR_NAME), "aria-label": "Name for the new colour" });
    const full = custom.length >= MAX_CUSTOM_COLOURS;
    const save = () => {
      const name = nameInput.value.trim();
      if (!name) {
        nameInput.setAttribute("aria-invalid", "true");
        nameInput.focus();
        return;
      }
      const hex = colourInput.value.toLowerCase();
      opts.onAddCustom!({ name, hex });
      opts.onPick(hex);
      dialog.close();
    };
    nameInput.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") {
        e.preventDefault();
        save();
      }
    });
    addRow = h("div", { class: "field swatch-add", style: { marginTop: "12px" } },
      h("span", { class: "field-label", text: "Add to my colours" }),
      h("div", { class: "row tight" }, colourInput, nameInput, button("Save", save, { class: "swatch-add-save" })),
      full ? h("span", { class: "field-hint", text: `You have ${MAX_CUSTOM_COLOURS} already; remove one in Settings to add another.` }) : null,
    );
    if (full) for (const c of addRow.querySelectorAll("input, button")) c.setAttribute("disabled", "");
  }

  dialog.append(
    h("h2", { text: "Colour" }),
    nameOut,
    grid,
    h("div", { class: "row hex-row", style: { marginTop: "12px" } },
      hexInput,
      button("Use", apply, { class: "primary" }),
    ),
    addRow,
    h("div", { class: "row", style: { marginTop: "12px" } },
      button("Back to automatic", () => {
        opts.onPick(null);
        dialog.close();
      }),
      h("div", { class: "spacer" }),
      button("Cancel", () => dialog.close()),
    ),
  );

  dialog.addEventListener("close", () => {
    dialog.remove();
    anchor.focus();
  });
  document.body.appendChild(dialog);
  dialog.showModal();
  (grid.querySelector("button") as HTMLElement | null)?.focus();
}
