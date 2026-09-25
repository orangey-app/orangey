/**
 * The "Your own theme" card in Settings.
 *
 * Four choices — background, text, accent, the wheel's colours — and a live
 * preview painted with everything derived from them. Readability is checked
 * as you pick: every pair that fails is listed with its numbers, and beside
 * your version the closest readable one appears, same hues, nudged as little
 * as will do. Either can be used; yours only with the warning left in view.
 *
 * It keeps its own draft and redraws only itself while you type — the rest of
 * Settings is rebuilt on other changes, which would take the focus from the
 * field under your fingers. Saving goes through `state.savePrefs`, and so
 * through `state.applyTheme()`, the one place theme colours are set.
 */

import { deriveTheme, fixTheme, themeProblems, THEME_NAME_MAX, type CustomScheme, type ThemeProblem } from "../../core/theme.ts";
import { WHEEL_COLOURS, WHEEL_SPARE } from "../../core/palette-assign.ts";
import { makeItem } from "../../model/randomizer.ts";
import { button, h, setChildren } from "../dom.ts";
import { state } from "../state.ts";
import { createWheel } from "./wheel.ts";
import { createColourField } from "./colourfield.ts";

const THEME_PREVIEW_ITEMS = ["Goblins", "Merchant", "Wolves", "Dragon", "Nothing", "Storm"].map((l) => makeItem(l, 1));

/** Where a first theme starts: the Orangey scheme's own colours, to change from. */
const THEME_START: CustomScheme = {
  name: "My theme",
  bg: "#fff8ef",
  ink: "#253122",
  accent: "#f3a257",
  wheel: [WHEEL_COLOURS[0], WHEEL_COLOURS[1], WHEEL_COLOURS[2], WHEEL_SPARE],
};

/** One problem as a line: the pair, and its numbers when it has any. */
export function describeThemeProblem(p: ThemeProblem): string {
  const numbers = p.ratio !== undefined && p.needs !== undefined ? ` — ${(Math.floor(p.ratio * 10) / 10).toFixed(1)} : 1, needs ${p.needs}` : "";
  return `${p.note ? "Note: " : ""}${p.pair}${numbers}`;
}

export function createThemeCard(onApplied: () => void): HTMLElement {
  let draft: CustomScheme = structuredClone(state.prefs.customScheme ?? THEME_START);

  const nameInput = h("input", { type: "text", value: draft.name, maxlength: String(THEME_NAME_MAX), class: "theme-name", "aria-label": "Theme name" });
  nameInput.addEventListener("input", () => {
    draft = { ...draft, name: nameInput.value.trim() || "My theme" };
  });

  const field = (label: string, key: "bg" | "ink" | "accent") =>
    createColourField(label, key, draft[key], (hex) => {
      draft = { ...draft, [key]: hex };
      update();
    });
  const wheelField = (label: string, i: 0 | 1 | 2 | 3) =>
    createColourField(label, `wheel${i}`, draft.wheel[i], (hex) => {
      const wheel = [...draft.wheel] as CustomScheme["wheel"];
      wheel[i] = hex;
      draft = { ...draft, wheel };
      update();
    }, true);
  const fields = {
    bg: field("Background", "bg"),
    ink: field("Text", "ink"),
    accent: field("Accent", "accent"),
    wheel: [wheelField("Wheel 1", 0), wheelField("Wheel 2", 1), wheelField("Wheel 3", 2), wheelField("Spare", 3)],
  };

  /** A preview box painted with a scheme: the tokens set on the box, so everything inside uses them. */
  function preview(caption: string, extraClass: string) {
    let shown = draft;
    const box = h("div", { class: `theme-preview ${extraClass}` });
    const wheel = createWheel({ items: () => THEME_PREVIEW_ITEMS, id: () => `theme-${extraClass}`, size: 150, colours: () => shown.wheel });
    wheel.el.classList.add("wheel-small");
    const note = h("p", { class: "faint theme-moved" });
    setChildren(box,
      h("p", { class: "theme-preview-caption", text: caption }),
      h("div", { class: "row theme-preview-row" },
        wheel.el,
        h("div", { class: "theme-preview-sample" },
          h("p", { text: "The answer is read here." }),
          h("p", { class: "faint", text: "Faint text, like a roll's details." }),
          h("button", { type: "button", class: "primary", tabindex: "-1", text: "Roll" }),
        ),
      ),
      note,
    );
    return {
      box,
      paint(s: CustomScheme, moved: string[] = []) {
        shown = s;
        for (const [token, value] of Object.entries(deriveTheme(s))) box.style.setProperty(token, value);
        note.textContent = moved.length ? `${moved.join(", ")}.` : "";
        wheel.refresh();
      },
    };
  }

  const mine = preview("Yours", "theme-mine");
  const suggestion = preview("Closest readable version", "theme-suggestion");
  const problemsList = h("ul", { class: "theme-problems" });
  const actions = h("div", { class: "row tight theme-actions" });
  let suggested: CustomScheme | null = null;

  function use(s: CustomScheme): void {
    draft = structuredClone(s);
    void state.savePrefs({ customScheme: draft, scheme: "custom" }).then(onApplied);
    syncFields();
    update();
  }

  function syncFields(): void {
    fields.bg.set(draft.bg);
    fields.ink.set(draft.ink);
    fields.accent.set(draft.accent);
    draft.wheel.forEach((hex, i) => fields.wheel[i].set(hex));
    nameInput.value = draft.name;
  }

  function update(): void {
    const problems = themeProblems(draft);
    const failing = problems.filter((p) => !p.note);
    setChildren(problemsList, ...problems.map((p) => h("li", { class: p.note ? "faint" : "warning", text: describeThemeProblem(p) })));
    problemsList.hidden = problems.length === 0;
    mine.paint(draft);
    if (failing.length) {
      const fixed = fixTheme(draft);
      suggested = fixed.scheme;
      suggestion.paint(fixed.scheme, fixed.moved);
      suggestion.box.hidden = false;
      setChildren(actions,
        button("Use the suggestion", () => suggested && use(suggested), { class: "primary use-suggestion" }),
        button("Use mine anyway", () => use(draft), { class: "ghost use-mine" }),
      );
    } else {
      suggested = null;
      suggestion.box.hidden = true;
      setChildren(actions, button("Use this theme", () => use(draft), { class: "primary use-theme" }));
    }
  }

  const card = h("div", { class: "card theme-card" },
    h("h2", { text: "Your own theme" }),
    h("p", { class: "faint", text: "Pick a background, a text colour, an accent and the wheel's colours; the rest is worked out from them. Anything hard to read is listed as you go, with the closest readable version beside yours." }),
    h("label", { class: "field" }, h("span", { class: "field-label", text: "Name" }), nameInput),
    h("div", { class: "theme-fields" }, fields.bg.el, fields.ink.el, fields.accent.el),
    h("div", { class: "theme-fields theme-wheel-fields" }, ...fields.wheel.map((f) => f.el)),
    h("div", { class: "theme-previews" }, mine.box, suggestion.box),
    problemsList,
    actions,
  );
  update();
  return card;
}
