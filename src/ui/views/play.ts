/**
 * The play surface: the screen a GM keeps open during a game.
 *
 * One tap to roll, the result in the largest type on screen, and nothing that
 * can be pressed by accident. The quick presets belong to the plain play
 * screen; with a randomizer open from the library they are replaced by a way
 * home, so that a stray press cannot swap out what the table is rolling.
 */

import { emptyRandomizer, newId, type ListItem, type Randomizer, type Rollable } from "../../model/randomizer.ts";
import type { LibraryNode } from "../../storage/library.ts";
import { tryParse } from "../../core/dice/grammar.ts";
import { button, h, isTyping, setChildren } from "../dom.ts";
import { state } from "../state.ts";
import { createWheel } from "../components/wheel.ts";
import { createDiceTray } from "../components/dice.ts";
import { createCoin } from "../components/coin.ts";
import { createResultPanel } from "../components/result.ts";
import { createRecentRolls } from "../components/recent.ts";
import { createChainRow } from "../components/chain.ts";
import { longestOutcome } from "../roll.ts";
import { createRoller } from "../rolling.ts";
import { bagDrawn, bagLoad, bagRefill } from "../bag.ts";
import { openLinkDialog } from "../components/linkdialog.ts";
import { isPresenting, setPresenting } from "../presenting.ts";
import { effectiveFeel } from "../feel.ts";
import { navigate, type LinkParams } from "../router.ts";
import type { View } from "../view.ts";
import { displayPercents, isRollable, withoutDrawn } from "../../core/weighted.ts";

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
          items: () => inPlay(),
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

  /**
   * The outcomes as they stand for the next roll: in bag mode, the ones
   * already drawn are marked disabled rather than removed, so indices,
   * colours and chain targets all still line up.
   */
  function inPlay(): ListItem[] {
    if (randomizer.type !== "list") return [];
    if (!randomizer.withoutReplacement) return randomizer.items;
    return withoutDrawn(randomizer.items, bagDrawn(randomizer.id));
  }

  function renderOutcomeList(): HTMLElement {
    const items = inPlay();
    const percents = displayPercents(items);
    return h("ul", { class: "outcome-list" },
      ...items.map((item, i) =>
        h("li", { class: item.disabled ? "disabled muted" : "" },
          h("span", { text: item.label }),
          h("span", { class: "faint", text: ` ${percents[i].toFixed(1)}%` }),
        ),
      ),
    );
  }

  /** The settings this roll uses: global, this randomizer's own, and the play-time switch. */
  const feelNow = () => effectiveFeel(state.prefs.feel, randomizer.feel, state.prefs.animationsOff);

  const roller = createRoller({
    randomizer: () => randomizer as Rollable,
    result,
    wheel: () => wheel,
    tray,
    coin,
    feel: feelNow,
    live: true,
    // While a roll runs the button offers to cut it short; pressing it again
    // is what `roller.roll()` reads as "skip".
    onStart: (willAnimate: boolean) => {
      rollButton.textContent = willAnimate ? "Skip" : "Roll";
    },
    onEnd: () => {
      rollButton.textContent = "Roll";
    },
    // The count changes at the landing; the wheel does not. Taking the
    // winning slice off the wheel the instant it wins would make it vanish
    // from under the pointer, so the wheel catches up on the next roll.
    onBagChange: () => {
      updateBagLine();
      if (randomizer.type === "list" && randomizer.view === "list") buildStage();
    },
  });

  const doRoll = (): Promise<void> => {
    // The wheel drops what was drawn last time here, not when it was drawn.
    wheel?.refresh();
    return roller.roll();
  };

  const skip = (): void => roller.skip();

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
    updateBagLine();
    // The bag is read from the app database, so it arrives a moment later;
    // until then the wheel simply shows everything, which is also what it
    // shows for a randomizer that does not use a bag at all.
    if (next.type === "list" && next.withoutReplacement) {
      void bagLoad(next.id).then(() => {
        if (randomizer.id !== next.id) return;
        updateBagLine();
        wheel?.refresh();
        if (next.view === "list") buildStage();
      });
    }
    // Nothing the old randomizer opened has anything to do with this one.
    chain.reset();
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

  // The panel is about whatever is open, so its Clear takes only those rolls.
  // The quick screen has no one randomizer open — every preset press is a new
  // ad-hoc one — so there it is about everything, which is also all the table
  // can see from here.
  const recent = createRecentRolls({
    ids: () => (fixed ? [randomizer.id] : []),
    scopeName: () => randomizer.name,
  });

  const header = h("div", { class: "row" }, h("div", {}, title, subtitle), h("div", { class: "spacer" }), editLink, node ? null : saveAdHoc);

  // Orangey's place: the corner of the result panel, where he can react to
  // the number without ever sitting on the Roll button.
  result.el.append(h("div", { class: "mascot-slot" }));
  /**
   * How much is left in the bag, and the way to put it all back.
   *
   * Only shown for a list that draws without putting back; for anything else
   * the row is hidden, so the card's height does not change under it.
   */
  const bagCount = h("span", { class: "faint bag-count" });
  const refillButton = button("Refill", () => {
    bagRefill(randomizer.id);
    result.clear();
    wheel?.refresh();
    if (randomizer.type === "list" && randomizer.view === "list") buildStage();
    updateBagLine();
  }, { class: "ghost refill-bag" });
  const bagLine = h("div", { class: "row tight bag-line" }, bagCount, refillButton);

  function updateBagLine(): void {
    const on = randomizer.type === "list" && randomizer.withoutReplacement === true;
    bagLine.hidden = !on;
    if (!on || randomizer.type !== "list") return;
    const drawn = bagDrawn(randomizer.id);
    const total = randomizer.items.filter(isRollable).length;
    const left = withoutDrawn(randomizer.items, drawn).filter(isRollable).length;
    bagCount.textContent = `${left} of ${total} left`;
    refillButton.hidden = left === total;
  }

  const playCard = h("div", { class: "card play-card" }, header, stage, bagLine, result.el, rollButton);
  const el = h("div", { class: "play" },
    fixed ? homeBar : quickbar,
    playCard,
    recent.el,
  );

  /**
   * An outcome that points at another randomizer opens it beside this one.
   *
   * The chain's elements are put in as siblings of the play card rather than
   * as a box around it: the full-screen rules are written against
   * `.play > .card`, and a wrapper would quietly take the projector with it.
   * The two columns are a grid on `.play` that exists only while something is
   * open, which is what the classes here say.
   */
  const chain = createChainRow({
    id: () => randomizer.id,
    name: () => randomizer.name,
    card: playCard,
    layout: (open, wide) => {
      el.classList.toggle("has-chain", open);
      el.classList.toggle("chain-wide", wide);
    },
  });
  el.insertBefore(chain.strip, playCard);
  el.insertBefore(chain.open, recent.el);
  el.insertBefore(chain.note, recent.el);

  reserveResult();
  buildStage();
  updateBagLine();
  if (randomizer.type === "list" && randomizer.withoutReplacement) {
    const opened = randomizer.id;
    void bagLoad(opened).then(() => {
      if (randomizer.id !== opened) return;
      updateBagLine();
      wheel?.refresh();
      if (randomizer.type === "list" && randomizer.view === "list") buildStage();
    });
  }
  // Settings can change the seed while this view is alive, and the seed line
  // is part of what the panel reserves room for.
  const unsubscribe = state.subscribe(() => {
    recent.refresh();
    reserveResult();
  }, ["history", "prefs"]);

  /* ---- presenting, and links for slides -------------------------------- */

  const exitButton = button("Leave full screen", () => present(false), { class: "leave-presenting" });
  exitButton.hidden = true;
  const presentButton = button("Full screen", () => present(!isPresenting()), { class: "ghost present-button" });
  const present = (on: boolean): void => setPresenting(on, { exitButton, presentButton });

  const linkButton = button("Link…", () => void openLinkDialog(randomizer, node), { class: "ghost link-button" });
  linkButton.hidden = !fixed;

  // Switch animation off for now without touching the settings — after the
  // fortieth roll of the evening nobody wants to watch the wheel.
  const animateBox = h("input", { type: "checkbox", checked: !state.prefs.animationsOff, "aria-label": "Animate rolls" });
  animateBox.addEventListener("change", () => void state.savePrefs({ animationsOff: !animateBox.checked }));
  const animateToggle = h("label", { class: "row tight animate-toggle faint" }, animateBox, "Animate");

  header.append(animateToggle, presentButton, linkButton, exitButton);

  if (params.present) present(true);
  if (params.roll) {
    // Wait a frame so the stage is laid out before the animation starts.
    requestAnimationFrame(() => void doRoll());
  }

  const onKey = (e: KeyboardEvent) => {
    const typing = isTyping(e);
    if (e.key === "Escape") {
      // Mid-roll, Escape means "get to the answer"; otherwise it leaves the
      // full-screen view, which is the only way out on a projector.
      if (roller.rolling) skip();
      else if (isPresenting()) present(false);
      return;
    }
    if (typing) return;
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      // A chain is rolled from its newest end: that is the randomizer the
      // table is waiting on, and the one behind it has already answered.
      if (!chain.rollNewest()) void doRoll();
    }
  };
  document.addEventListener("keydown", onKey);

  return {
    el,
    destroy() {
      document.removeEventListener("keydown", onKey);
      // The full-screen class belongs to the app, which clears it before each
      // render: a view being torn down must not undo what the view replacing
      // it has already set up.
      chain.destroy();
      unsubscribe();
    },
  };
}

function describeType(r: Randomizer): string {
  switch (r.type) {
    case "list":
      return `${r.items.filter(isRollable).length} possible outcomes`;
    case "dice":
      return "Dice";
    case "coin":
      return `${r.faces[0]} or ${r.faces[1]}`;
    case "number":
      return `${r.min} to ${r.max}`;
    case "board":
      return `${r.entries.length} randomizer${r.entries.length === 1 ? "" : "s"}`;
  }
}
