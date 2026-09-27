/**
 * Quick edit: a slice's weight, changed where the wheel is played.
 *
 * A double-tap on a slice opens a small box on the wheel with that outcome's
 * weight. Saving writes the randomizer's file, exactly as the editor would,
 * so the change holds everywhere the wheel is used — on its own screen, on
 * every board and in a pop-out. Only randomizers in the library can be
 * edited this way: a wheel from a link or typed as a quick wheel has no file.
 *
 * The box is made in the wheel's own document, so it works in a pop-out too.
 */

import { touch, type ListRandomizer } from "../../model/randomizer.ts";
import { draftProblem } from "../../model/draft.ts";
import { button, h } from "../dom.ts";
import { state } from "../state.ts";

/** Whether this randomizer's slices can be quick-edited: a list in the library. */
export function canQuickEdit(randomizerId: string): boolean {
  return state.library.findById(randomizerId)?.randomizer?.type === "list";
}

/**
 * Save a new weight for one outcome, by its id. Returns the randomizer as
 * saved, or null when nothing was saved (gone from the library, or the weight
 * is not one the file can hold — the box refuses those before it gets here).
 */
export async function saveOutcomeWeight(randomizerId: string, itemId: string, weight: number): Promise<ListRandomizer | null> {
  const node = state.library.findById(randomizerId);
  const current = node?.randomizer;
  if (!node || current?.type !== "list" || !Number.isFinite(weight) || weight < 0) return null;
  const next = touch({ ...current, items: current.items.map((item) => (item.id === itemId ? { ...item, weight } : item)) });
  const problem = draftProblem(next);
  if (problem) {
    state.toast(`Not saved: ${problem}`);
    return null;
  }
  state.library.save(node.path, next);
  await state.library.flush().catch(() => {});
  return next;
}

/** The open box, so a second double-tap replaces it rather than stacking. */
let openWeightBox: { close: () => void } | null = null;

/**
 * Open the box over `host` (a positioned element — the wheel's wrap) at the
 * point of the tap. `onSave` gets the new weight; Escape, ✕ or a press
 * elsewhere closes it unchanged.
 */
export function openWeightEditor(opts: {
  host: HTMLElement;
  clientX: number;
  clientY: number;
  label: string;
  weight: number;
  onSave: (weight: number) => void;
}): void {
  openWeightBox?.close();
  const doc = opts.host.ownerDocument;
  const input = h("input", {
    type: "number", min: "0", step: "any", value: String(opts.weight),
    class: "weight-input", "aria-label": `Weight of ${opts.label}`,
  }) as HTMLInputElement;
  const note = h("p", { class: "faint weight-note" });
  const save = () => {
    const weight = Number(input.value);
    if (input.value.trim() === "" || !Number.isFinite(weight) || weight < 0) {
      note.textContent = "A weight is a number, 0 or more.";
      input.setAttribute("aria-invalid", "true");
      return;
    }
    close();
    opts.onSave(weight);
  };
  const box = h("div", { class: "weight-editor", role: "dialog", "aria-label": `Weight of ${opts.label}` },
    h("div", { class: "weight-head" },
      h("span", { class: "weight-label", text: opts.label }),
      button("✕", () => close(), { class: "ghost weight-close", "aria-label": "Close without saving" }),
    ),
    h("label", { class: "row tight" }, h("span", { class: "faint", text: "Weight" }), input),
    note,
    h("p", { class: "faint weight-hint", text: "0 takes it off the wheel; the editor brings it back." }),
    button("Save", () => save(), { class: "primary weight-save" }),
  );
  input.addEventListener("keydown", (e) => {
    const key = (e as KeyboardEvent).key;
    if (key === "Enter") {
      e.preventDefault();
      save();
    } else if (key === "Escape") {
      e.stopPropagation();
      close();
    }
  });

  // Placed at the tap, kept inside the host.
  const rect = opts.host.getBoundingClientRect();
  opts.host.append(box);
  const left = Math.min(Math.max(0, opts.clientX - rect.left - box.offsetWidth / 2), Math.max(0, rect.width - box.offsetWidth));
  const top = Math.min(Math.max(0, opts.clientY - rect.top + 12), Math.max(0, rect.height - box.offsetHeight));
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;

  // A press outside closes it; the one that opened it has already happened.
  const outside = (e: Event) => {
    if (!box.contains(e.target as Node)) close();
  };
  doc.addEventListener("pointerdown", outside, true);
  function close(): void {
    doc.removeEventListener("pointerdown", outside, true);
    box.remove();
    if (openWeightBox === entry) openWeightBox = null;
  }
  const entry = { close };
  openWeightBox = entry;
  input.focus();
  input.select();
}
