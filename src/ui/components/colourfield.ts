/**
 * One colour, chosen two ways: the browser's colour picker, and its hex typed
 * beside it.
 *
 * A colour input is awkward on a phone and cannot be pasted into, so the hex
 * field has to work on its own; the two stay in step. Used by the theme card
 * in Settings and by a wheel's own palette in the editor, so the two look and
 * behave the same.
 */

import { hexToRgb, isHex, rgbToHex } from "../../core/color.ts";
import { h } from "../dom.ts";

export interface ColourField {
  el: HTMLElement;
  value(): string;
  set(hex: string): void;
}

/**
 * @param key       names the field for tests and styles (`data-field`)
 * @param onChange  told each time the field holds a whole, valid colour
 */
export function createColourField(label: string, key: string, initial: string, onChange: (hex: string) => void, small = false): ColourField {
  let current = colourFieldHex(initial);
  const picker = h("input", { type: "color", value: current, class: "colour-picker", "aria-label": `${label}, picker` });
  const hex = h("input", {
    type: "text", value: current, class: "colour-hex", spellcheck: "false", maxlength: "7",
    "aria-label": `${label}, as a hex colour`,
  });

  picker.addEventListener("input", () => {
    current = colourFieldHex(picker.value);
    hex.value = current;
    hex.removeAttribute("aria-invalid");
    onChange(current);
  });
  hex.addEventListener("input", () => {
    const typed = hex.value.trim();
    const full = typed.startsWith("#") ? typed : `#${typed}`;
    // Three digits are a colour too, but half-typed six are not: only a
    // complete one is taken, and a wrong one is marked, not guessed at.
    if (!isHex(full)) {
      hex.setAttribute("aria-invalid", "true");
      return;
    }
    hex.removeAttribute("aria-invalid");
    current = colourFieldHex(full);
    picker.value = current;
    onChange(current);
  });

  const el = h("label", { class: `colour-field${small ? " small" : ""}`, dataset: { field: key } },
    h("span", { class: "colour-field-label", text: label }),
    h("span", { class: "row tight colour-field-inputs" }, picker, hex),
  );
  return {
    el,
    value: () => current,
    set(next) {
      current = colourFieldHex(next);
      picker.value = current;
      hex.value = current;
      hex.removeAttribute("aria-invalid");
    },
  };
}

/** Lower-case, six digits: what a colour input gives back and what files hold. */
function colourFieldHex(hex: string): string {
  return rgbToHex(hexToRgb(hex));
}
