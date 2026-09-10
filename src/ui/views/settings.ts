/**
 * Settings, most of which is Feel (plan C10, decision D22).
 *
 * Every animation timing in the app is one of these values, so the sliders
 * genuinely change how rolling feels rather than nudging one hard-coded
 * constant. Each section previews itself: you cannot tune a spin you cannot
 * watch.
 */

import { DEFAULT_FEEL, MASCOT_WOBBLE_STOPS, normalizeFeel, prefersReducedMotion, type FeelSettings, type MascotPresence, type MotionLevel } from "../feel.ts";
import { createMascot, type Mascot } from "../mascot/mascot.ts";
import { DEFAULT_REACTIONS } from "../mascot/reactions.ts";
import { MASCOT_BUILTIN_STATES } from "../mascot/states.ts";
import { choice, coinControls, diceControls, wheelControls } from "../components/feelpanel.ts";
import { button, h, setChildren } from "../dom.ts";
import { state } from "../state.ts";
import { createWheel } from "../components/wheel.ts";
import { createCoin, createDiceTray } from "../components/dice.ts";
import { makeItem } from "../../model/randomizer.ts";
import { rollDice } from "../../core/dice/evaluate.ts";
import { CryptoSource } from "../../core/rng.ts";
import { download } from "./library.ts";
import { SETTINGS_FILE_NAME, MAX_COLOUR_NAME, MAX_CUSTOM_COLOURS } from "../../model/settings-file.ts";
import { ValidationError } from "../../model/validate.ts";
import { SINGLE_FILE_NAME, isSingleFile, releasesUrl } from "../single.ts";
import type { View } from "./editor.ts";

const PREVIEW_ITEMS = ["Goblin patrol", "Merchant", "Wolf pack", "Dragon", "Nothing", "Storm"].map((l) => makeItem(l, 1));

export function createSettingsView(): View {
  const container = h("div");

  const previewWheel = createWheel({ items: () => PREVIEW_ITEMS, id: () => "settings-preview", size: 220 });
  previewWheel.el.classList.add("wheel-small");
  const previewTray = createDiceTray();
  const previewCoin = createCoin();
  let previewMascot: Mascot | null = null;

  const feel = (): FeelSettings => state.prefs.feel;
  const setFeel = (patch: Partial<FeelSettings>) => {
    state.setFeel(patch);
    render();
  };

  function render(): void {
    const f = feel();
    const disabled = f.motion === "instant";
    const dim = (el: HTMLElement) => {
      if (disabled) {
        el.style.opacity = "0.5";
        for (const control of el.querySelectorAll("input, button, select")) {
          const isPreview = /preview-(wheel|dice|coin)/.test(control.className);
          // The dice style is not a timing: instant mode still draws the
          // chosen style at rest, so it stays available.
          const isStyle = control.closest('[aria-label="Style"]') !== null;
          if (!isPreview && !isStyle) control.setAttribute("disabled", "");
        }
      }
      return el;
    };

    setChildren(container, 
      h("div", { class: "card" },
        h("h1", { text: "Settings" }),
        h("div", { class: "field" },
          h("span", { class: "field-label", text: "Colour scheme" }),
          h("div", { class: "scheme-grid", role: "group", "aria-label": "Colour scheme" },
            ...([
              ["system", "Follow system", "Orangey by day, Night in the dark"],
              ["orangey", "Orangey", "Warm cream and brand orange"],
              ["night", "Night", "The brand black as the ground"],
              ["meadow", "Meadow", "Mint and fresh green"],
              ["ocean", "Ocean", "Pale sky and clear blue"],
              ["berry", "Berry", "Blush and warm pink"],
            ] as const).map(([key, label, blurb]) =>
              h("button", {
                type: "button",
                class: `scheme-card scheme-${key}`,
                "aria-pressed": (state.prefs.scheme ?? "system") === key ? "true" : "false",
                onclick: () => { void state.savePrefs({ scheme: key }); render(); },
              },
                h("span", { class: "scheme-swatch" }),
                h("span", { class: "scheme-name", text: label }),
                h("span", { class: "faint", text: blurb }),
              )),
          ),
        ),
      ),

      h("div", { class: "card" },
        h("h2", { text: "Feel" }),
        h("p", { class: "faint", text: "How rolling looks and how long it takes. The result is always decided before the animation starts, so skipping never changes it." }),
        choice("Animation", ["full", "quick", "instant"] as const, f.motion, (v: MotionLevel) => {
          void state.savePrefs({ reducedMotionOverridden: true });
          setFeel({ motion: v });
        }),
        prefersReducedMotion() && !state.prefs.reducedMotionOverridden
          ? h("p", { class: "faint", text: "Your system asks for reduced motion, so animation starts switched off. Changing it here overrides that." })
          : null,
      ),

      dim(h("div", { class: "card" },
        h("h2", { text: "Wheel" }),
        wheelControls(f.wheel, (patch) => setFeel({ wheel: { ...f.wheel, ...patch } }), [
          h("div", { class: "row" },
            previewWheel.el,
            h("div", {},
              button("Preview", () => {
                previewWheel.refresh();
                void previewWheel.spinTo(Math.floor(Math.random() * PREVIEW_ITEMS.length), feel());
              }, { class: "preview-wheel" }),
              button("Reset", () => setFeel({ wheel: DEFAULT_FEEL.wheel }), { class: "ghost" }),
            ),
          ),
        ]),
      )),

      dim(h("div", { class: "card" },
        h("h2", { text: "Dice" }),
        diceControls(f.dice, (patch) => setFeel({ dice: { ...f.dice, ...patch } }), [
          h("p", { class: "faint", text: f.dice.style === "wireframe"
            ? "Wireframe dice are drawn as the solid they are — a tetrahedron for a d4, a cube for a d6, an octahedron, a ten-sided trapezohedron, a dodecahedron, an icosahedron. Anything without a shape of its own tumbles as a cube. Numbers appear when the dice land."
            : "Flat dice are plain numbered squares, showing every value as it settles." }),
          previewTray.el,
          h("div", { class: "row tight" },
            button("Preview", () => void previewTray.show(rollDice("4d6kh3", new CryptoSource()), feel()), { class: "preview-dice" }),
            button("Reset", () => setFeel({ dice: DEFAULT_FEEL.dice }), { class: "ghost" }),
          ),
        ]),
      )),

      dim(h("div", { class: "card" },
        h("h2", { text: "Coin" }),
        coinControls(f.coin, (patch) => setFeel({ coin: { ...f.coin, ...patch } }), [
          previewCoin.el,
          h("div", { class: "row tight" },
            button("Preview", () => void previewCoin.show(Math.random() < 0.5 ? "Heads" : "Tails", feel()), { class: "preview-coin" }),
            button("Reset", () => setFeel({ coin: DEFAULT_FEEL.coin }), { class: "ghost" }),
          ),
        ]),
      )),

      mascotCard(f),

      coloursCard(),

      h("div", { class: "card" },
        h("h2", { text: "Other" }),
        h("label", { class: "row tight" },
          checkbox(f.haptics, (v) => setFeel({ haptics: v })),
          "Vibrate on a result (where the device supports it)",
        ),
        h("label", { class: "field", style: { marginTop: "12px" } },
          h("span", { class: "field-label", text: "Seed" }),
          seedInput(),
          h("span", { class: "field-hint", text: "Set a seed and everyone using it sees the same sequence of rolls. Leave it empty for ordinary random rolls." }),
        ),
        button("Reset everything about feel", () => setFeel(normalizeFeel(DEFAULT_FEEL)), { class: "ghost" }),
      ),

      settingsFileCard(),

      h("div", { class: "card about-card" },
        h("h2", { text: "About" }),
        h("p", { class: "faint", text: "Orangey keeps everything on this device. It makes no network requests after loading, has no account, and stores your randomizers as ordinary JSON files you can copy, share or keep in version control." }),
        isSingleFile()
          ? h("p", { class: "faint", text: `This is the single-file Orangey — the file you opened is the whole app. Copy ${SINGLE_FILE_NAME} anywhere and it works there too.` })
          : h("div", { class: "field" },
              h("span", { class: "field-label", text: "Keep a copy" }),
              h("div", { class: "row tight" },
                button(`Download ${SINGLE_FILE_NAME}`, () => void downloadCopy(), { class: "download-copy" }),
              ),
              h("span", { class: "field-hint", text: "The whole app in one file that opens from your own disk, with no server and no network. Your randomizers stay in this browser; export them from the library to carry them along." }),
            ),
      ),
    );
  }

  /* ---- a copy of the app --------------------------------------------------- */

  async function downloadCopy(): Promise<void> {
    try {
      const res = await fetch(SINGLE_FILE_NAME, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (!text.includes("<title>Orangey")) throw new Error("not the app");
      download(SINGLE_FILE_NAME, text, "text/html");
      state.toast(`Saved ${SINGLE_FILE_NAME}`);
    } catch {
      state.toast("Could not fetch a copy from here; get it from the releases page", "Open", () => window.open(releasesUrl(), "_blank", "noopener"));
    }
  }

  /* ---- my colours ----------------------------------------------------------- */

  function coloursCard(): HTMLElement {
    const colours = state.prefs.colours;
    const colourInput = h("input", { type: "color", value: "#a33a30", "aria-label": "New colour" });
    const nameInput = h("input", { type: "text", placeholder: "Name it", maxlength: String(MAX_COLOUR_NAME), "aria-label": "Name for the new colour" });
    const add = () => {
      const name = nameInput.value.trim();
      if (!name) {
        nameInput.setAttribute("aria-invalid", "true");
        nameInput.focus();
        return;
      }
      state.addColour({ name, hex: colourInput.value });
      render();
    };
    nameInput.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") {
        e.preventDefault();
        add();
      }
    });
    const full = colours.length >= MAX_CUSTOM_COLOURS;
    return h("div", { class: "card colours-card" },
      h("h2", { text: "My colours" }),
      h("p", { class: "faint", text: "Colours you add here join the top of the colour picker in every editor. The automatic colours a wheel gets when you have not chosen any stay with the built-in palette, which is checked for contrast and for neighbours that can be told apart." }),
      colours.length
        ? h("div", { class: "my-colours" },
            ...colours.map((c) =>
              h("div", { class: "my-colour", dataset: { hex: c.hex } },
                h("span", { class: "my-colour-swatch", style: { background: c.hex } }),
                h("span", { class: "my-colour-name", text: c.name }),
                h("span", { class: "faint my-colour-hex", text: c.hex }),
                button("Remove", () => { state.removeColour(c.hex); render(); }, { class: "ghost remove-colour", "aria-label": `Remove ${c.name}` }),
              )),
          )
        : h("p", { class: "faint", text: "None yet." }),
      h("div", { class: "row tight add-colour-row", style: { marginTop: "8px" } },
        colourInput,
        nameInput,
        button("Add", add, { class: "add-colour", disabled: full ? "" : null }),
      ),
      full ? h("span", { class: "field-hint", text: `That is the most (${MAX_CUSTOM_COLOURS}); remove one to add another.` }) : null,
    );
  }

  /* ---- settings file --------------------------------------------------------- */

  function settingsFileCard(): HTMLElement {
    const fileInput = h("input", { type: "file", accept: ".json,application/json", hidden: "", "aria-label": "Settings file" });
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      fileInput.value = "";
      if (!file) return;
      try {
        await state.importSettings(await file.text());
        state.toast(`Settings loaded from ${file.name}`);
        render();
      } catch (e) {
        const why = e instanceof ValidationError ? e.issues.map((i) => `${i.path}: ${i.message}`).join("; ") : (e as Error).message;
        state.toast(`Could not load ${file.name} — ${why}`);
      }
    });
    return h("div", { class: "card settings-file-card" },
      h("h2", { text: "Settings file" }),
      h("p", { class: "faint", text: "Save the colour scheme, every Feel setting, Orangey's rules, the seed and your own colours as one small file; load it on another device or after clearing the browser. Your randomizers are not in it — they are files of their own in the library." }),
      h("div", { class: "row tight" },
        button("Save settings…", () => download(SETTINGS_FILE_NAME, state.exportSettings(), "application/json"), { class: "save-settings" }),
        button("Load settings…", () => fileInput.click(), { class: "load-settings" }),
        fileInput,
      ),
    );
  }

  /* ---- Orangey ---------------------------------------------------------- */

  function mascotCard(f: FeelSettings): HTMLElement {
    const m = f.mascot;
    const setMascot = (patch: Partial<FeelSettings["mascot"]>) => setFeel({ mascot: { ...m, ...patch } });

    previewMascot?.destroy();
    previewMascot = createMascot({ state: "idle", wobble: m.wobble, motion: f.motion });
    const previewBox = h("div", { class: "mascot-preview" }, previewMascot.el);

    const presenceOptions: [MascotPresence, string, string][] = [
      ["hidden", "Hidden", "Never shown."],
      ["triggers", "On triggers", "Appears when something happens — a roll, a maximum, a minimum, a failed link — and goes again."],
      ["always", "Always", "Sits by the result between rolls."],
    ];
    const wobbleLabel = (v: number) => (v === 0 ? "None" : v === 1 ? "Soft" : "More");

    return h("div", { class: "card mascot-card" },
      h("h2", { text: "Orangey" }),
      h("p", { class: "faint", text: "The mascot. Whether he appears is the game master's choice; what he reacts to is yours to switch." }),
      h("div", { class: "field" },
        h("span", { class: "field-label", text: "Presence" }),
        h("div", { class: "segmented", role: "group", "aria-label": "Presence" },
          ...presenceOptions.map(([key, label]) =>
            button(label, () => setMascot({ presence: key }), { "aria-pressed": m.presence === key ? "true" : "false" })),
        ),
        h("span", { class: "field-hint", text: presenceOptions.find(([k]) => k === m.presence)?.[2] ?? "" }),
      ),
      h("div", { class: "field" },
        h("span", { class: "field-label", text: "Wobble" }),
        h("div", { class: "segmented", role: "group", "aria-label": "Wobble" },
          ...MASCOT_WOBBLE_STOPS.map((v) =>
            button(wobbleLabel(v), () => setMascot({ wobble: v }), { "aria-pressed": m.wobble === v ? "true" : "false" })),
        ),
        h("span", { class: "field-hint", text: "However much he wobbles, at rest he is the drawing." }),
      ),
      h("div", { class: "row mascot-preview-row" },
        previewBox,
        h("div", { class: "mascot-preview-controls" },
          h("span", { class: "field-label", text: "Preview" }),
          h("div", { class: "row tight wrap" },
            ...MASCOT_BUILTIN_STATES.map((name) =>
              button(name[0].toUpperCase() + name.slice(1), () => previewMascot?.setState(name), { class: `preview-mascot preview-mascot-${name}` })),
          ),
        ),
      ),
      h("div", { class: "field" },
        h("span", { class: "field-label", text: "Reacts to" }),
        h("div", { class: "mascot-rules" },
          ...DEFAULT_REACTIONS.map((r) =>
            h("label", { class: "row tight" },
              checkbox(m.rules[r.id] !== false, (on) => {
                const rules = { ...m.rules };
                if (on) delete rules[r.id];
                else rules[r.id] = false;
                setMascot({ rules });
              }, { "data-rule": r.id }),
              r.label,
            )),
        ),
      ),
      button("Reset Orangey", () => setMascot(DEFAULT_FEEL.mascot), { class: "ghost" }),
    );
  }

  function checkbox(value: boolean, onChange: (v: boolean) => void, extra: Record<string, string> = {}): HTMLInputElement {
    const input = h("input", { type: "checkbox", checked: value, ...extra });
    input.addEventListener("change", () => onChange(input.checked));
    return input;
  }

  function seedInput(): HTMLInputElement {
    const input = h("input", { type: "text", value: state.prefs.seed ?? "", placeholder: "none", "aria-label": "Seed" });
    input.addEventListener("change", () => {
      const seed = input.value.trim() || null;
      state.resetSeedSequence();
      void state.savePrefs({ seed });
      state.toast(seed ? `Seeded rolls: ${seed}` : "Back to ordinary random rolls");
    });
    return input;
  }

  render();
  return {
    el: container,
    destroy() {
      previewMascot?.destroy();
      previewMascot = null;
    },
  };
}
