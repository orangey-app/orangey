/**
 * The play screen, which a GM keeps open during a game: one tap to roll, the
 * result in the largest type on screen.
 *
 * With a randomizer open from the library, the quick presets are replaced by a
 * way home, so a stray press cannot swap out what the table is rolling.
 */

import { emptyRandomizer, newId, nowIso, OFFER_MAX, OFFER_MIN, type ListItem, type ListRandomizer, type Randomizer, type Rollable } from "../../model/randomizer.ts";
import { parseQuickOptions, quickText } from "../../import/quick.ts";
import { encodeRandomizer, LINK_HARD_LIMIT } from "../../model/link.ts";
import type { LibraryNode } from "../../storage/library.ts";
import { tryParse } from "../../core/dice/grammar.ts";
import { appendChildren, button, h, iconButton, isTyping, setChildren } from "../dom.ts";
import { rollOwnerId, state } from "../state.ts";
import { createWheel } from "../components/wheel.ts";
import { createOutcomeList, type OutcomeListView } from "../components/outcomelist.ts";
import { canQuickEdit, openWeightEditor, saveOutcomeWeight } from "../components/quickweight.ts";
import { createDiceTray } from "../components/dice.ts";
import { createCoin } from "../components/coin.ts";
import { createInkblotView } from "../components/inkblot.ts";
import { createResultPanel } from "../components/result.ts";
import { createRecentRolls } from "../components/recent.ts";
import { createChainRow, type ChainView } from "../components/chain.ts";
import { longestOutcome } from "../../model/roll.ts";
import { createRoller } from "../rolling.ts";
import { bagDrawn, bagLoad, bagRefill } from "../bag.ts";
import { openLinkDialog } from "../components/linkdialog.ts";
import { isPresenting, setPresenting } from "../presenting.ts";
import { popOutButton } from "../popout.ts";
import { effectiveFeel, QUICK_DEBOUNCE_MS } from "../feel.ts";
import { appBase, currentRoute, navigate, wheelLink, type LinkParams } from "../router.ts";
import type { View } from "../view.ts";
import { isRollable, withoutDrawn } from "../../core/weighted.ts";

const PRESETS = [4, 6, 8, 10, 12, 20, 100];

/**
 * @param node     a randomizer from the library, or null
 * @param linked   a randomizer that arrived inside a link, when there is one
 * @param quick    the link is a quick wheel being typed at this table, not a
 *                 wheel someone sent: open the home screen with its text back
 */
export function createPlayView(
  node: LibraryNode | null,
  params: LinkParams = { roll: false, present: false },
  linked: Randomizer | null = null,
  quick = false,
): View {
  let randomizer: Randomizer = node?.randomizer ?? linked ?? adHocDice("d20");
  /** Opened from the library or from a link: either way, one fixed randomizer. */
  const fixed = node !== null || (linked !== null && !quick);

  const result = createResultPanel(fixed ? "Ready" : "Pick something to roll");
  const stage = h("div", { class: "stage" });
  const rollButton = button("Roll", () => void doRoll(), { class: "primary roll-button", style: { width: "100%", minHeight: "52px", fontSize: "17px" } });
  /** An inkblot is generated, not rolled, and a big button would sit badly under it. */
  const rollLabel = (): string => (randomizer.type === "inkblot" ? "Generate" : "Roll");

  /**
   * Roll behind the screen. Deliberately not a saved preference: a hidden roll
   * that outlived its scene would be a nasty surprise.
   */
  const hiddenBox = h("input", { type: "checkbox", class: "hidden-box", "aria-label": "Roll without showing the result" });
  hiddenBox.addEventListener("change", () => {
    if (!hiddenBox.checked && roller.holding) {
      roller.discard();
      result.clear("Ready");
      rollButton.textContent = rollLabel();
    }
  });
  const hiddenToggle = h("label", { class: "row tight hidden-toggle faint" }, hiddenBox, "Hidden");

  // How many outcomes one press draws; lists only.
  const countInput = h("input", {
    type: "number", min: "1", max: "20", value: "1", class: "roll-count", "aria-label": "How many to roll at once",
  });
  countInput.addEventListener("change", () => {
    countInput.value = String(rollCount());
    reserveResult();
  });
  const countField = h("label", { class: "row tight roll-count-field faint" }, "×", countInput);

  function rollCount(): number {
    const n = Math.trunc(Number.parseInt(countInput.value, 10));
    return Number.isFinite(n) ? Math.max(1, Math.min(20, n)) : 1;
  }

  function updateHeaderControls(): void {
    // Offering a choice and rolling several at once do not combine.
    const many = randomizer.type === "list" && !offerSize(randomizer);
    countField.hidden = !many;
    if (!many) countInput.value = "1";
    // An inkblot shows its answer as the blot itself: no big type, no hidden
    // roll (there is nothing to hold behind a screen), and Generate as a link.
    const ink = randomizer.type === "inkblot";
    result.el.classList.toggle("is-inkblot", ink);
    rollButton.classList.toggle("generate", ink);
    rollButton.classList.toggle("primary", !ink);
    if (!roller.rolling && !roller.holding && !roller.choosing) rollButton.textContent = rollLabel();
    hiddenToggle.hidden = ink;
    downloadInkblot.hidden = !ink;
    if (ink && hiddenBox.checked) hiddenBox.checked = false;
  }

  let wheel: ReturnType<typeof createWheel> | null = null;
  /** A list shown as a list, and which of its outcomes is the answer on screen. */
  let outcomeList: OutcomeListView | null = null;
  let answerIndex: number | null = null;
  const tray = createDiceTray();
  const coin = createCoin();
  const inkblot = createInkblotView("Press Generate", (ready) => {
    downloadInkblot.disabled = !ready;
  });
  // Beside Edit and the rest, for an inkblot only; ready once a blot has landed.
  const downloadInkblot = iconButton("Download this inkblot", "⤓", () => {
    downloadInkblot.setAttribute("aria-busy", "true");
    void inkblot.download().finally(() => downloadInkblot.removeAttribute("aria-busy"));
  }, { class: "icon-button inkblot-download", disabled: true });

  function adHocDice(expression: string): Randomizer {
    const r = emptyRandomizer("dice", expression) as Randomizer & { expression: string };
    r.expression = expression;
    return r;
  }

  function buildStage(): void {
    wheel = null;
    outcomeList = null;
    setChildren(stage);
    if (randomizer.type === "list") {
      if (randomizer.view === "wheel") {
        wheel = createWheel({
          items: () => inPlay(),
          id: () => randomizer.id,
          slices: () => (randomizer.type === "list" ? randomizer.slices : undefined),
          colours: () => state.wheelColours(randomizer.type === "list" ? randomizer.palette : undefined),
          onActivate: () => void doRoll(),
          // Only a wheel with a file behind it: a linked or quick wheel has
          // nowhere to save a weight to.
          onSliceEdit: node && canQuickEdit(randomizer.id) ? (index, x, y) => quickEdit(index, x, y) : undefined,
        });
        stage.append(wheel.el);
      } else {
        outcomeList = createOutcomeList({
          items: () => inPlay(),
          onPick: (i) => void roller.choose(i),
          name: randomizer.name,
        });
        outcomeList.mark(answerIndex);
        stage.append(outcomeList.el);
      }
    } else if (randomizer.type === "dice") {
      stage.append(tray.el);
    } else if (randomizer.type === "coin") {
      stage.append(coin.el);
    } else if (randomizer.type === "inkblot") {
      stage.append(inkblot.el);
    }
  }

  /** A double-tap on a slice: its weight, edited in place and saved to the file. */
  function quickEdit(index: number, clientX: number, clientY: number): void {
    if (randomizer.type !== "list" || !wheel || roller.rolling) return;
    const item = randomizer.items[index];
    if (!item) return;
    const editing = randomizer.id;
    openWeightEditor({
      host: wheel.el, clientX, clientY, label: item.label, weight: item.weight,
      onSave: (weight) => void saveOutcomeWeight(editing, item.id, weight).then((saved) => {
        if (!saved || randomizer.id !== editing) return;
        randomizer = saved;
        subtitle.textContent = saved.description ?? describeType(saved);
        showAgain();
      }),
    });
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


  /** The settings this roll uses: global, this randomizer's own, and the play-time switch. */
  const feelNow = () => effectiveFeel(state.prefs.feel, randomizer.feel, state.prefs.animationsOff);

  const roller = createRoller({
    randomizer: () => randomizer as Rollable,
    result,
    wheel: () => wheel,
    tray,
    coin,
    inkblot,
    feel: feelNow,
    live: true,
    // While a roll runs the button offers to cut it short; pressing it again
    // is what `roller.roll()` reads as "skip".
    onStart: (willAnimate: boolean) => {
      rollButton.textContent = willAnimate ? "Skip" : rollLabel();
      rollButton.disabled = false;
    },
    onEnd: () => {
      rollButton.textContent = rollLabel();
      rollButton.disabled = false;
      // The quick wheel changed while this roll was spinning; redraw it now
      // rather than under the pointer.
      if (wheelStale) {
        wheelStale = false;
        wheel?.refresh();
      }
    },
    // The count changes at the landing; the wheel does not. Taking the
    // winning slice off the wheel the instant it wins would make it vanish
    // from under the pointer, so the wheel catches up on the next roll.
    onBagChange: () => {
      updateBagLine();
      if (randomizer.type === "list" && randomizer.view === "list") buildStage();
    },
    hidden: () => hiddenBox.checked,
    count: () => rollCount(),
    onHeld: () => {
      rollButton.textContent = "Reveal";
    },
    // Cards are out: the next press is on a card, so the button says so and
    // stays out of the way until one is taken.
    onChoosing: () => {
      rollButton.textContent = "Choose one";
      rollButton.disabled = true;
    },
    focusOffer: () => true,
    // The answer stays marked in a list shown as a list, rolled or picked.
    onLanded: (outcome) => {
      answerIndex = outcome.itemIndex ?? null;
      outcomeList?.mark(answerIndex);
    },
  });

  const doRoll = (): Promise<void> => {
    // The wheel drops what was drawn last time here, not when it was drawn.
    wheel?.refresh();
    return roller.roll();
  };

  const skip = (): void => roller.skip();

  /** The chain beside the card, once it exists; the Recent panel asks it what is open. */
  let chainView: ChainView | null = null;

  /**
   * A wheel typed at the table: one option per line, rolled at once, kept only if
   * saved.
   *
   * It lives in the address like any linked wheel, so a phone that locks between
   * rolls comes back to it. The address is rewritten in place, which does not
   * fire `hashchange`, so the screen is not rebuilt under the typing.
   */
  let quickModel: ListRandomizer | null = quick && linked?.type === "list" ? linked : null;
  let destroyed = false;
  let addressTimer: ReturnType<typeof setTimeout> | undefined;
  /** Encoding is asynchronous; only the newest one may write the address. */
  let addressTurn = 0;
  let wheelFrame = 0;
  /** The quick wheel changed during a spin and is redrawn when it lands. */
  let wheelStale = false;

  const quickArea = h("textarea", {
    class: "quick-options",
    rows: "4",
    placeholder: "Goblins\nBandits | 2\nNothing x3",
    "aria-label": "Quick wheel: one option per line",
    spellcheck: "false",
  });
  const quickOffer = h("input", {
    type: "number", min: String(OFFER_MIN), max: String(OFFER_MAX), class: "quick-offer",
    "aria-label": "Offer this many to choose from", placeholder: "–",
  });
  const quickTooLong = h("p", {
    class: "warning quick-too-long",
    text: "This wheel is too long for a link. It still rolls, but the address keeps the last version that fitted, so save it to keep it.",
  });
  quickTooLong.hidden = true;
  const quickCard = h("div", { class: "card quick-wheel" },
    quickArea,
    h("div", { class: "row tight quick-wheel-foot" },
      h("label", { class: "row tight quick-offer-field faint" }, "Offer", quickOffer, "to choose from"),
      h("span", { class: "spacer" }),
      h("span", { class: "faint quick-hint", text: "“| 3” or “x3” weighs a line" }),
    ),
    quickTooLong,
  );
  quickCard.hidden = true;
  const quickToggle = button("Quick wheel", () => setQuickOpen(quickCard.hidden === true), {
    class: "quick-wheel-toggle", "aria-expanded": "false",
  });

  function setQuickOpen(open: boolean): void {
    quickCard.hidden = !open;
    quickToggle.setAttribute("aria-expanded", String(open));
    if (open) quickArea.focus({ preventScroll: true });
  }

  /** The offer typed beside the options, when it is one a file may hold. */
  function quickOfferValue(): number | undefined {
    const raw = quickOffer.value.trim();
    const n = Number(raw);
    const ok = raw !== "" && Number.isInteger(n) && n >= OFFER_MIN && n <= OFFER_MAX;
    if (raw !== "" && !ok) quickOffer.setAttribute("aria-invalid", "true");
    else quickOffer.removeAttribute("aria-invalid");
    return ok ? n : undefined;
  }

  function onQuickInput(): void {
    const items = parseQuickOptions(quickArea.value);
    if (items.length === 0) {
      // Nothing typed is nothing to roll: back to the die the screen starts with.
      if (quickModel) {
        quickModel = null;
        setRandomizer(adHocDice("d20"));
      }
      scheduleAddress();
      return;
    }
    const now = nowIso();
    const next: ListRandomizer = {
      id: quickModel?.id ?? newId(),
      type: "list",
      name: "Quick wheel",
      view: "wheel",
      created: quickModel?.created ?? now,
      modified: now,
      items,
    };
    const offer = quickOfferValue();
    if (offer !== undefined) next.offer = offer;
    const onStage = quickModel !== null;
    quickModel = next;
    if (onStage) updateQuickInPlace(next);
    else setRandomizer(next);
    scheduleAddress();
  }

  /**
   * The wheel follows the typing without the screen being rebuilt: the same
   * stage, the same result, a redraw at most once a frame.
   */
  function updateQuickInPlace(next: ListRandomizer): void {
    randomizer = next;
    // A roll held back or an offer on the table was drawn from the old
    // options; what it would land on is no longer on the wheel.
    if (roller.holding || roller.choosing) {
      roller.discard();
      result.clear("Ready");
      rollButton.textContent = rollLabel();
      rollButton.disabled = false;
    }
    subtitle.textContent = describeType(next);
    reserveResult();
    updateHeaderControls();
    if (roller.rolling) {
      wheelStale = true;
      return;
    }
    cancelAnimationFrame(wheelFrame);
    wheelFrame = requestAnimationFrame(() => wheel?.refresh());
  }

  /** Throw the quick wheel away, as pressing a preset does. */
  function leaveQuick(): void {
    if (!quickModel && !quickArea.value && !quickOffer.value) return;
    quickModel = null;
    quickArea.value = "";
    quickOffer.value = "";
    quickOffer.removeAttribute("aria-invalid");
    quickTooLong.hidden = true;
    setQuickOpen(false);
    void writeAddress();
  }

  function scheduleAddress(): void {
    clearTimeout(addressTimer);
    addressTimer = setTimeout(() => void writeAddress(), QUICK_DEBOUNCE_MS);
  }

  /** Save what is typed into the address now, if the wait has not already. */
  const keepAddress = (): void => {
    if (addressTimer !== undefined) void writeAddress();
  };

  async function writeAddress(): Promise<void> {
    clearTimeout(addressTimer);
    addressTimer = undefined;
    const turn = ++addressTurn;
    // Only the play screen's own address is this view's to rewrite; a press
    // that has already taken the reader elsewhere wins.
    const here = currentRoute();
    if (destroyed || !(here.name === "play" || (here.name === "linked" && here.quick === true))) return;
    const model = quickModel;
    if (!model) {
      quickTooLong.hidden = true;
      if (here.name !== "play") history.replaceState(null, "", "#/");
      return;
    }
    let payload: string;
    try {
      payload = await encodeRandomizer(model);
    } catch {
      return;
    }
    if (turn !== addressTurn || destroyed) return;
    // Past the limit a link stops being something to paste about; the wheel
    // keeps rolling from memory, and the address keeps what last fitted.
    const tooLong = wheelLink(appBase(), payload).length > LINK_HARD_LIMIT;
    quickTooLong.hidden = !tooLong;
    if (!tooLong) history.replaceState(null, "", `#/roll?w=${payload}&quick=1`);
  }

  quickArea.addEventListener("input", onQuickInput);
  quickOffer.addEventListener("input", onQuickInput);
  quickArea.addEventListener("blur", keepAddress);
  quickOffer.addEventListener("blur", keepAddress);
  // A phone locks between rolls: whatever was typed last goes into the
  // address before the page is put away.
  window.addEventListener("pagehide", keepAddress);
  document.addEventListener("visibilitychange", keepAddress);

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
    leaveQuick();
    setRandomizer(adHocDice(parsed.expression.normalized));
    void doRoll();
  });

  const quickbar = h("div", { class: "quickbar" },
    ...PRESETS.map((sides) =>
      button(`d${sides}`, () => {
        leaveQuick();
        setRandomizer(adHocDice(`d${sides}`));
        void doRoll();
      }, { class: "preset" }),
    ),
    button("Coin", () => {
      leaveQuick();
      setRandomizer(emptyRandomizer("coin", "Coin"));
      void doRoll();
    }),
    button("1–100", () => {
      leaveQuick();
      setRandomizer(emptyRandomizer("number", "Number"));
      void doRoll();
    }),
    quickToggle,
    expression,
    expressionError,
  );

  const homeBar = h("div", { class: "quickbar home-bar" },
    button("← Home", () => navigate("#/"), { class: "ghost home-button", title: "Dice, coins and numbers" }),
  );

  function setRandomizer(next: Randomizer): void {
    randomizer = next;
    title.textContent = next.type === "dice" ? (next as { expression: string }).expression : next.name;
    subtitle.textContent = next.description ?? describeType(next);
    editLink.style.display = node && next.id === node.randomizer?.id ? "" : "none";
    linkButton.hidden = !fixed && next !== quickModel;
    roller.discard();
    rollButton.textContent = rollLabel();
    rollButton.disabled = false;
    reserveResult();
    result.clear("Ready");
    answerIndex = null;
    buildStage();
    updateBagLine();
    updateHeaderControls();
    // The bag arrives from the app database a moment later; until then the wheel
    // shows everything.
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
    const one = longestOutcome(randomizer);
    const n = randomizer.type === "list" ? rollCount() : 1;
    const longest = n > 1 ? Array.from({ length: n }, () => one).join(", ") : one;
    result.reserve(longest, { seed: state.prefs.seed !== null, offer: offerSize(randomizer) });
  }

  const title = h("h1", { text: randomizer.type === "dice" ? (randomizer as { expression: string }).expression : randomizer.name });
  const subtitle = h("p", { class: "muted", text: randomizer.description ?? describeType(randomizer) });
  const editLink = button("Edit", () => node && navigate(`#/edit/${encodeURIComponent(node.path)}`), { class: "ghost edit-link" });
  editLink.style.display = node ? "" : "none";

  // A wheel that arrived in a link is nobody's until it is saved. Not offered in
  // full screen, where this row is hidden.
  const saveAdHoc = button(linked && !quick ? "Save to my library" : "Save to library", async () => {
    // Keep the identity it came with when nothing here already has it, so a
    // slide link by id finds this copy afterwards.
    const taken = state.library.findById(randomizer.id) !== null;
    const path = await state.library.create("", { ...randomizer, id: taken ? newId() : randomizer.id });
    state.toast("Saved to your library");
    navigate(`#/r/${encodeURIComponent(path)}`);
  }, { class: "ghost save-randomizer" });

  // The Recent panel's Clear takes only the rolls of what is open: this randomizer
  // and whatever its chain opened. The quick screen has no one randomizer (each
  // preset press is a new ad-hoc one), so there it takes everything.
  const onScreen = (): { id: string; name: string }[] => {
    const all = [{ id: randomizer.id, name: randomizer.name }, ...(chainView?.present() ?? [])];
    return all.filter((r, i) => all.findIndex((o) => o.id === r.id) === i);
  };
  const recent = createRecentRolls({
    ids: () => (fixed ? onScreen().map((r) => r.id) : []),
    scopeName: () => listNames(onScreen().map((r) => r.name)),
  });

  const header = h("div", { class: "row" }, h("div", {}, title, subtitle), h("div", { class: "spacer" }), editLink, node ? null : saveAdHoc);

  // The mascot sits in a corner of the result panel, never over the Roll button.
  result.el.append(h("div", { class: "mascot-slot" }));
  /** How much is left in the bag, and Refill. Shown only for a list in bag mode. */
  const bagCount = h("span", { class: "faint bag-count" });
  const refillButton = button("Refill", () => {
    bagRefill(randomizer.id);
    result.clear();
    answerIndex = null;
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

  /**
   * Shortcuts to what you actually roll, on the home screen: otherwise the wheel
   * used all evening is three taps away behind the library.
   */
  const shortcuts = h("div", { class: "card home-shortcuts" });

  function renderShortcuts(): void {
    if (fixed) return;
    const seen = new Set<string>();
    const pick = (id: string) => {
      if (seen.has(id)) return null;
      const node = state.library.findById(id);
      if (!node?.randomizer) return null;
      seen.add(id);
      return node;
    };

    const favourites = state.prefs.favourites.map(pick).filter((n) => n !== null);
    const recents = [...new Set(state.history.map(rollOwnerId).filter((id): id is string => id !== null))]
      .map(pick)
      .filter((n) => n !== null)
      .slice(0, 6);

    shortcuts.hidden = favourites.length === 0 && recents.length === 0;
    if (shortcuts.hidden) {
      setChildren(shortcuts);
      return;
    }
    const group = (heading: string, nodes: typeof favourites) =>
      nodes.length
        ? h("div", { class: "shortcut-group" },
            h("h2", { text: heading }),
            h("div", { class: "row wrap" },
              ...nodes.map((n) =>
                button(n.randomizer!.name, () => navigate(`#/r/${encodeURIComponent(n.path)}`), { class: "ghost shortcut" })),
            ),
          )
        : null;
    setChildren(shortcuts, group("Favourites", favourites), group("Recently rolled", recents));
  }

  const playCard = h("div", { class: "card play-card" }, header, stage, bagLine, result.el, rollButton);
  const el = h("div", { class: "play" },
    fixed ? homeBar : quickbar,
    fixed ? null : quickCard,
    playCard,
    ...(fixed ? [] : [shortcuts]),
    recent.el,
  );
  renderShortcuts();

  /**
   * An outcome that points at another randomizer opens it beside this one.
   *
   * The chain's elements are siblings of the play card, not a wrapper around it:
   * the full-screen rules target `.play > .card`. The two-column grid on `.play`
   * exists only while something is open.
   */
  const chain: ChainView = createChainRow({
    id: () => randomizer.id,
    name: () => randomizer.name,
    card: playCard,
    layout: (open, wide) => {
      el.classList.toggle("has-chain", open);
      el.classList.toggle("chain-wide", wide);
    },
  });
  chainView = chain;
  el.insertBefore(chain.strip, playCard);
  el.insertBefore(chain.open, recent.el);
  el.insertBefore(chain.note, recent.el);

  reserveResult();
  buildStage();
  updateBagLine();
  updateHeaderControls();
  // Reopened from its address: the text comes back, normalised, and the card
  // is open so the table can go on typing.
  if (quickModel) {
    quickArea.value = quickText(quickModel.items);
    quickOffer.value = quickModel.offer !== undefined ? String(quickModel.offer) : "";
    quickCard.hidden = false;
    quickToggle.setAttribute("aria-expanded", "true");
  }
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
    followEdit();
    recent.refresh();
    reserveResult();
    renderShortcuts();
  }, ["history", "prefs", "library"]);

  /**
   * The same randomizer saved from somewhere else — a weight quick-edited in
   * the pop-out, or on a board in another tab: show the new version here
   * too, keeping the answer. Not mid-roll, and not when it became something
   * the stage would have to be rebuilt for.
   */
  function followEdit(): void {
    if (!node || roller.rolling) return;
    const fresh = state.library.findById(randomizer.id)?.randomizer;
    if (!fresh || fresh === randomizer || fresh.type !== randomizer.type) return;
    if (fresh.type === "list" && randomizer.type === "list" && fresh.view !== randomizer.view) return;
    randomizer = fresh;
    subtitle.textContent = fresh.description ?? describeType(fresh);
    showAgain();
  }

  /** Redraw after an edit, with the pointer put back on the answer on screen. */
  function showAgain(): void {
    wheel?.refresh();
    if (wheel && answerIndex !== null) void wheel.spinTo(answerIndex, { ...feelNow(), motion: "instant" });
    outcomeList?.refresh();
  }

  const exitButton = button("Leave full screen", () => present(false), { class: "leave-presenting" });
  exitButton.hidden = true;
  const presentButton = button("Full screen", () => present(!isPresenting()), { class: "ghost present-button" });
  const present = (on: boolean): void => setPresenting(on, { exitButton, presentButton });

  const linkButton = button("Link…", () => void openLinkDialog(randomizer, node), { class: "ghost link-button" });
  // A quick wheel is shareable the moment it exists. The link carries the
  // wheel, not the textarea: whoever opens it gets a wheel to roll.
  linkButton.hidden = !fixed && randomizer !== quickModel;

  // Switch animation off for now without touching the settings — after the
  // fortieth roll of the evening nobody wants to watch the wheel.
  const animateBox = h("input", { type: "checkbox", checked: !state.prefs.animationsOff, "aria-label": "Animate rolls" });
  animateBox.addEventListener("change", () => void state.savePrefs({ animationsOff: !animateBox.checked }));
  const animateToggle = h("label", { class: "row tight animate-toggle faint" }, animateBox, "Animate");

  // Only for a randomizer in the library: a quick wheel changes as it is
  // typed, and the pop-out would hold the version from the moment of the press.
  const popButton = node ? popOutButton(() => state.library.findById(randomizer.id)?.randomizer ?? randomizer) : null;

  appendChildren(header, hiddenToggle, countField, downloadInkblot, animateToggle, presentButton, popButton, linkButton, exitButton);

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
    // Cards on the table: a digit takes that card, and a card's own Enter or
    // Space belongs to the card rather than to the Roll behind it.
    if (roller.choosing) {
      if (/^[1-9]$/.test(e.key)) {
        e.preventDefault();
        void roller.pick(Number(e.key) - 1);
        return;
      }
      if ((e.target as HTMLElement | null)?.closest?.(".offer-card")) return;
    }
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
      // An offer nobody picked, like a hidden roll nobody revealed, goes with
      // the screen; the quick wheel's address is only this screen's to write.
      roller.discard();
      destroyed = true;
      clearTimeout(addressTimer);
      cancelAnimationFrame(wheelFrame);
      window.removeEventListener("pagehide", keepAddress);
      document.removeEventListener("visibilitychange", keepAddress);
      // No full-screen cleanup here: the app clears that class before each render,
      // and doing it now could undo what the next view has set up.
      chain.destroy();
      unsubscribe();
    },
  };
}

/** "Encounters", "Encounters and Hoard", "Encounters, Hoard and Gems". */
function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** How many outcomes a roll of this offers to choose from; 0 when it lands on one. */
function offerSize(r: Randomizer): number {
  return r.type === "list" && r.offer !== undefined && r.offer >= OFFER_MIN ? r.offer : 0;
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
    case "inkblot":
      return "A new inkblot every time";
    case "board":
      return `${r.entries.length} randomizer${r.entries.length === 1 ? "" : "s"}`;
  }
}
