/**
 * The play surface: the screen a GM keeps open during a game.
 *
 * One tap to roll, the result in the largest type on screen, and nothing that
 * can be pressed by accident. The quick presets belong to the plain play
 * screen; with a randomizer open from the library they are replaced by a way
 * home, so that a stray press cannot swap out what the table is rolling.
 */

import { emptyRandomizer, newId, type Randomizer } from "../../model/randomizer.ts";
import type { LibraryNode } from "../../storage/library.ts";
import { tryParse } from "../../core/dice/grammar.ts";
import { button, formatTime, h, setChildren } from "../dom.ts";
import { state } from "../state.ts";
import { createWheel } from "../components/wheel.ts";
import { createCoin, createDiceTray } from "../components/dice.ts";
import { createResultPanel } from "../components/result.ts";
import { longestOutcome, rollRandomizer, whyCannotRoll, type Outcome } from "../roll.ts";
import { summarize } from "../mascot/events.ts";
import { effectiveFeel, motionScale } from "../feel.ts";
import { appBase, isLinkableBase, navigate, slideLink, wheelLink, type LinkParams } from "../router.ts";
import { LINK_HARD_LIMIT, LINK_SOFT_LIMIT, encodeRandomizer } from "../../model/link.ts";
import type { View } from "./editor.ts";
import { displayPercents } from "../../core/weighted.ts";

const PRESETS = [4, 6, 8, 10, 12, 20, 100];

/**
 * @param node     a randomizer from the library, or null
 * @param linked   a randomizer that arrived inside a link, when there is one
 */
export function createPlayView(
  node: LibraryNode | null,
  params: LinkParams = { roll: false, present: false },
  linked: Randomizer | null = null,
): View {
  let randomizer: Randomizer = node?.randomizer ?? linked ?? adHocDice("d20");
  let rolling = false;
  /** Opened from the library or from a link: either way, one fixed randomizer. */
  const fixed = node !== null || linked !== null;

  const result = createResultPanel(fixed ? "Ready" : "Pick something to roll");
  const stage = h("div", { class: "stage" });
  const rollButton = button("Roll", () => void doRoll(), { class: "primary roll-button", style: { width: "100%", minHeight: "52px", fontSize: "17px" } });

  let wheel: ReturnType<typeof createWheel> | null = null;
  const tray = createDiceTray();
  const coin = createCoin();

  function adHocDice(expression: string): Randomizer {
    const r = emptyRandomizer("dice", expression) as Randomizer & { expression: string };
    r.expression = expression;
    return r;
  }

  function buildStage(): void {
    wheel = null;
    setChildren(stage);
    if (randomizer.type === "list") {
      if (randomizer.view === "wheel") {
        wheel = createWheel({
          items: () => (randomizer as { items: never[] }).items,
          id: () => randomizer.id,
          onActivate: () => void doRoll(),
        });
        stage.append(wheel.el);
      } else {
        stage.append(renderOutcomeList());
      }
    } else if (randomizer.type === "dice") {
      stage.append(tray.el);
    } else if (randomizer.type === "coin") {
      stage.append(coin.el);
    }
  }

  function renderOutcomeList(): HTMLElement {
    const r = randomizer as Extract<Randomizer, { type: "list" }>;
    const percents = displayPercents(r.items);
    return h("ul", { class: "outcome-list" },
      ...r.items.map((item, i) =>
        h("li", { class: item.disabled ? "disabled muted" : "" },
          h("span", { text: item.label }),
          h("span", { class: "faint", text: ` ${percents[i].toFixed(1)}%` }),
        ),
      ),
    );
  }

  /** The settings this roll uses: global, this randomizer's own, and the play-time switch. */
  const feelNow = () => effectiveFeel(state.prefs.feel, randomizer.feel, state.prefs.animationsOff);

  async function doRoll(): Promise<void> {
    if (rolling) {
      skip();
      return;
    }
    const problem = whyCannotRoll(randomizer);
    if (problem) {
      result.clear(problem);
      state.tell({ type: "roll:fail", source: randomizer.type, reason: problem });
      return;
    }
    let outcome: Outcome;
    try {
      outcome = rollRandomizer(randomizer, state.source());
    } catch (e) {
      result.clear((e as Error).message);
      state.tell({ type: "roll:fail", source: randomizer.type, reason: (e as Error).message });
      return;
    }

    const feel = feelNow();
    const instant = motionScale(feel.motion) === 0;
    // A list shown as a list has nothing to animate, so it reveals at once.
    const willAnimate =
      !instant &&
      ((randomizer.type === "list" && wheel !== null && outcome.itemIndex !== undefined) ||
        (randomizer.type === "dice" && outcome.dice !== undefined) ||
        randomizer.type === "coin");
    rolling = true;
    rollButton.textContent = willAnimate ? "Skip" : "Roll";

    // The outcome is already decided; nothing shows it until the animation has
    // finished arriving at it, so the table finds out when the dice stop, not
    // when they start. The screen reader is told at the same moment.
    if (willAnimate) {
      result.pending();
      state.tell({ type: "roll:start", source: randomizer.type });
    } else result.show(outcome);

    if (randomizer.type === "list" && wheel && outcome.itemIndex !== undefined) {
      await wheel.spinTo(outcome.itemIndex, feel);
    } else if (randomizer.type === "dice" && outcome.dice) {
      await tray.show(outcome.dice, feel);
    } else if (randomizer.type === "coin") {
      await coin.show(outcome.text, feel);
    }

    if (willAnimate) result.show(outcome);
    // The landing: the result, the announcement and the mascot's reaction
    // all happen here, never at the start (plan C10).
    state.tell({ type: "roll:land", source: randomizer.type, summary: summarize(outcome) });
    rolling = false;
    rollButton.textContent = "Roll";
    void state.record(randomizer, outcome);
  }

  function skip(): void {
    wheel?.skip();
    tray.skip();
    coin.skip();
  }

  // ---- quick bar -----------------------------------------------------------

  const expression = h("input", {
    type: "text",
    placeholder: "2d6 + 3",
    "aria-label": "Dice expression",
    spellcheck: "false",
    style: { maxWidth: "160px" },
  });
  const expressionError = h("span", { class: "faint" });
  expression.addEventListener("input", () => {
    const v = expression.value.trim();
    if (!v) {
      expressionError.textContent = "";
      expression.removeAttribute("aria-invalid");
      return;
    }
    const parsed = tryParse(v);
    expressionError.textContent = parsed.ok ? "" : parsed.error.message;
    if (parsed.ok) expression.removeAttribute("aria-invalid");
    else expression.setAttribute("aria-invalid", "true");
  });
  expression.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key !== "Enter") return;
    e.preventDefault();
    const parsed = tryParse(expression.value.trim());
    if (!parsed.ok) return;
    setRandomizer(adHocDice(parsed.expression.normalized));
    void doRoll();
  });

  const quickbar = h("div", { class: "quickbar" },
    ...PRESETS.map((sides) =>
      button(`d${sides}`, () => {
        setRandomizer(adHocDice(`d${sides}`));
        void doRoll();
      }, { class: "preset" }),
    ),
    button("Coin", () => {
      setRandomizer(emptyRandomizer("coin", "Coin"));
      void doRoll();
    }),
    button("1–100", () => {
      setRandomizer(emptyRandomizer("number", "Number"));
      void doRoll();
    }),
    expression,
    expressionError,
  );

  // With a randomizer open from the library the quick presets are replaced by
  // a way back to them: pressing one used to swap out the randomizer the table
  // was in the middle of, which is never what a press meant.
  const homeBar = h("div", { class: "quickbar home-bar" },
    button("← Home", () => navigate("#/"), { class: "ghost home-button", title: "Dice, coins and numbers" }),
  );

  function setRandomizer(next: Randomizer): void {
    randomizer = next;
    title.textContent = next.type === "dice" ? (next as { expression: string }).expression : next.name;
    subtitle.textContent = next.description ?? describeType(next);
    editLink.style.display = node && next.id === node.randomizer?.id ? "" : "none";
    reserveResult();
    result.clear("Ready");
    buildStage();
  }

  /** Fix the result panel's height from what this randomizer can produce. */
  function reserveResult(): void {
    result.reserve(longestOutcome(randomizer), { seed: state.prefs.seed !== null });
  }

  const title = h("h1", { text: randomizer.type === "dice" ? (randomizer as { expression: string }).expression : randomizer.name });
  const subtitle = h("p", { class: "muted", text: randomizer.description ?? describeType(randomizer) });
  const editLink = button("Edit", () => node && navigate(`#/edit/${encodeURIComponent(node.path)}`), { class: "ghost edit-link" });
  editLink.style.display = node ? "" : "none";

  // A wheel that arrived in a link is nobody's until it is saved. The button
  // is one more quiet item in this row rather than anything that interrupts a
  // game: it is not offered at all in full screen, where the row is hidden.
  const saveAdHoc = button(linked ? "Save to my library" : "Save to library", async () => {
    // Keep the identity it came with when nothing here already has it, so a
    // slide link by id finds this copy afterwards.
    const taken = state.library.findById(randomizer.id) !== null;
    const path = await state.library.create("", { ...randomizer, id: taken ? newId() : randomizer.id });
    state.toast("Saved to your library");
    navigate(`#/r/${encodeURIComponent(path)}`);
  }, { class: "ghost save-randomizer" });

  const historyList = h("ul", { class: "history-list" });
  function renderHistory(): void {
    setChildren(historyList, 
      ...state.history.slice(0, 8).map((entry) =>
        h("li", {},
          h("span", { class: "when", text: formatTime(entry.at) }),
          h("span", { class: "what" },
            h("span", { class: "name", text: entry.randomizerName }),
            " ",
            h("span", { class: "detail", text: entry.resultText }),
          ),
        ),
      ),
    );
  }

  const header = h("div", { class: "row" }, h("div", {}, title, subtitle), h("div", { class: "spacer" }), editLink, node ? null : saveAdHoc);

  // Orangey's place: the corner of the result panel, where he can react to
  // the number without ever sitting on the Roll button.
  result.el.append(h("div", { class: "mascot-slot" }));
  const el = h("div", { class: "play" },
    fixed ? homeBar : quickbar,
    h("div", { class: "card play-card" },
      header,
      stage,
      result.el,
      rollButton,
    ),
    h("div", { class: "card" },
      h("div", { class: "row" },
        h("h2", { text: "Recent rolls", style: { margin: "0" } }),
        h("div", { class: "spacer" }),
        button("All history", () => navigate("#/history"), { class: "ghost" }),
      ),
      historyList,
    ),
  );

  reserveResult();
  buildStage();
  renderHistory();
  // Settings can change the seed while this view is alive, and the seed line
  // is part of what the panel reserves room for.
  const unsubscribe = state.subscribe(() => {
    renderHistory();
    reserveResult();
  });

  /* ---- presenting, and links for slides -------------------------------- */

  function presenting(): boolean {
    return document.body.classList.contains("presenting");
  }

  function setPresenting(on: boolean): void {
    document.body.classList.toggle("presenting", on);
    exitButton.hidden = !on;
    presentButton.textContent = on ? "Leave full screen" : "Full screen";
    if (on && document.documentElement.requestFullscreen) {
      void document.documentElement.requestFullscreen().catch(() => {
        /* the browser may refuse without a gesture; the layout still applies */
      });
    } else if (!on && document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    }
  }

  const exitButton = button("Leave full screen", () => setPresenting(false), { class: "leave-presenting" });
  exitButton.hidden = true;
  const presentButton = button("Full screen", () => setPresenting(!presenting()), { class: "ghost present-button" });

  /**
   * Two kinds of link, side by side.
   *
   * "With the wheel inside" carries the randomizer in the address, so it
   * rolls on anyone's machine and keeps rolling whatever happens to the
   * library — frozen at today's version, and longer. "To my library" is short
   * and follows every edit, but only works where the library is. The first is
   * offered first, because it is what most people pasting into a deck mean.
   */
  async function openLinkDialog(): Promise<void> {
    if (!fixed) return;
    const base = appBase();
    const rollOnOpen = h("input", { type: "checkbox", checked: true });
    const fullScreen = h("input", { type: "checkbox", checked: true });
    const field = h("input", { type: "text", readonly: true, "aria-label": "Link to paste onto a slide", spellcheck: "false" });
    const note = h("p", { class: "faint link-note" });
    const sizeNote = h("p", { class: "warning link-size" });

    let payload: string | null = null;
    try {
      payload = await encodeRandomizer(randomizer);
    } catch {
      payload = null;
    }
    const embeddedLength = payload === null ? Infinity : wheelLink(base, payload, { roll: true, present: true }).length;
    const canEmbed = payload !== null && embeddedLength <= LINK_HARD_LIMIT;
    const canLibrary = node?.randomizer != null;
    if (!canEmbed && !canLibrary) {
      state.toast("This randomizer is too big to put in a link, and it is not in your library.");
      return;
    }

    let kind: "embedded" | "library" = canEmbed ? "embedded" : "library";
    const kinds = h("div", { class: "segmented link-kinds", role: "group", "aria-label": "What the link carries" });

    const refresh = () => {
      const opts = { roll: rollOnOpen.checked, present: fullScreen.checked };
      field.value = kind === "embedded" && payload
        ? wheelLink(base, payload, opts)
        : slideLink(base, node!.randomizer!.id, opts);
      note.textContent = kind === "embedded"
        ? "The wheel travels inside the link, so it works for anyone who opens the deck, on any machine, with nothing installed. It is a snapshot: editing the wheel afterwards does not change decks you have already made."
        : "Short, and it follows every edit you make. It points at the randomizer's identity rather than its file name, so renaming it or moving it to another folder will not break the deck — but it only works on a device where this library is stored.";
      const tooLong = kind === "embedded" && field.value.length > LINK_SOFT_LIMIT;
      sizeNote.hidden = !tooLong;
      if (tooLong) {
        sizeNote.textContent = `This link is ${field.value.length} characters. Slides and PowerPoint will take it, but it is unwieldy to handle;${canLibrary ? " a link to your library would be a few dozen." : " trimming the table would shorten it."}`;
      }
      for (const b of kinds.querySelectorAll("button")) {
        b.setAttribute("aria-pressed", b.dataset.kind === kind ? "true" : "false");
      }
    };

    const kindButton = (value: "embedded" | "library", label: string) => {
      const b = button(label, () => { kind = value; refresh(); }, { class: `link-kind-${value}` });
      b.dataset.kind = value;
      return b;
    };
    setChildren(kinds,
      canEmbed ? kindButton("embedded", "With the wheel inside") : null,
      canLibrary ? kindButton("library", "To my library") : null,
    );

    rollOnOpen.addEventListener("change", refresh);
    fullScreen.addEventListener("change", refresh);
    refresh();

    const copied = h("span", { class: "faint" });
    const dialog = h("dialog", { class: "link-dialog", "aria-label": "Link for a slide" },
      h("h2", { text: "Link for a slide" }),
      h("p", { class: "faint", text:
        `Put this on a shape or an image in Google Slides or PowerPoint. Clicking it during the presentation opens ${randomizer.name} and rolls it; closing the tab returns you to the deck.` }),
      kinds.children.length > 1 ? kinds : null,
      field,
      h("div", { class: "row tight", style: { marginTop: "10px" } },
        h("label", { class: "row tight" }, rollOnOpen, "Roll as soon as it opens"),
        h("label", { class: "row tight" }, fullScreen, "Fill the screen"),
      ),
      isLinkableBase(base)
        ? null
        : h("p", { class: "warning", text:
            "This copy of Orangey is open from a file rather than a web address, so this link will not work from a slide — browsers refuse to follow a link from a web page to a local file. Open the published copy and make the link there." }),
      sizeNote,
      note,
      h("div", { class: "row", style: { marginTop: "14px" } },
        button("Copy", async () => {
          try {
            await navigator.clipboard.writeText(field.value);
            copied.textContent = "Copied";
          } catch {
            field.select();
            copied.textContent = "Press Ctrl+C to copy";
          }
        }, { class: "primary copy-link" }),
        copied,
        h("div", { class: "spacer" }),
        button("Close", () => dialog.close()),
      ),
    );
    dialog.addEventListener("close", () => dialog.remove());
    document.body.appendChild(dialog);
    dialog.showModal();
    field.select();
  }

  const linkButton = button("Link…", () => void openLinkDialog(), { class: "ghost link-button" });
  linkButton.hidden = !fixed;

  // Switch animation off for now without touching the settings — after the
  // fortieth roll of the evening nobody wants to watch the wheel.
  const animateBox = h("input", { type: "checkbox", checked: !state.prefs.animationsOff, "aria-label": "Animate rolls" });
  animateBox.addEventListener("change", () => void state.savePrefs({ animationsOff: !animateBox.checked }));
  const animateToggle = h("label", { class: "row tight animate-toggle faint" }, animateBox, "Animate");

  header.append(animateToggle, presentButton, linkButton, exitButton);

  if (params.present) setPresenting(true);
  if (params.roll) {
    // Wait a frame so the stage is laid out before the animation starts.
    requestAnimationFrame(() => void doRoll());
  }

  const onKey = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    const typing = target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
    if (e.key === "Escape") {
      // Mid-roll, Escape means "get to the answer"; otherwise it leaves the
      // full-screen view, which is the only way out on a projector.
      if (rolling) skip();
      else if (document.body.classList.contains("presenting")) setPresenting(false);
      return;
    }
    if (typing) return;
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      void doRoll();
    }
  };
  document.addEventListener("keydown", onKey);

  return {
    el,
    destroy() {
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("presenting");
      unsubscribe();
    },
  };
}

function describeType(r: Randomizer): string {
  switch (r.type) {
    case "list":
      return `${r.items.filter((i) => !i.disabled && i.weight > 0).length} possible outcomes`;
    case "dice":
      return "Dice";
    case "coin":
      return `${r.faces[0]} or ${r.faces[1]}`;
    case "number":
      return `${r.min} to ${r.max}`;
  }
}
