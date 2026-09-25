/**
 * A board: several randomizers on one screen.
 *
 * The case is a game master who rolls the same handful of things all evening —
 * an encounter table, the weather, a treasure wheel — and wants them in front
 * of them at once rather than swapping between library entries.
 *
 * A board points at randomizers by id rather than holding copies, so editing a
 * table updates every board it is on. The price is that a deleted randomizer
 * leaves a gap, which the board says plainly instead of quietly shrinking.
 */

import { BOARD_LIMIT, emptyRandomizer, newId, nowIso, OFFER_MAX, OFFER_MIN, touch, type BoardRandomizer, type DiceRandomizer, type ListRandomizer, type Randomizer } from "../../model/randomizer.ts";
import { tryParse } from "../../core/dice/grammar.ts";
import { parseQuickOptions, quickText } from "../../import/quick.ts";
import { BOARD_TEMP_LIMIT, loadBoardTemps, saveBoardTemps, type TempRandomizer } from "../board-temps.ts";
import type { LibraryNode } from "../../storage/library.ts";
import { button, h, isTyping, openDialog, setChildren } from "../dom.ts";
import { state } from "../state.ts";
import { isPresenting, setPresenting } from "../presenting.ts";
import { cellRollButton, createCell, createMissingCell, type CellView } from "../components/cell.ts";
import { advanceChain, chainTarget, createChainSurface, type ChainLink } from "../components/chain.ts";
import type { Outcome } from "../roll.ts";
import { createRecentRolls } from "../components/recent.ts";
import { pickRandomizer } from "../components/picker.ts";
import { exportBoardZip } from "../storage-actions.ts";
import { appBase, editHash, navigate, slideLink } from "../router.ts";
import type { View } from "../view.ts";

export function createBoardView(node: LibraryNode, params: { roll?: boolean; present?: boolean } = {}): View {
  const board = node.randomizer as BoardRandomizer;
  const grid = h("div", { class: "board-grid" });
  let cells: CellView[] = [];

  /**
   * An outcome's `goesTo`, followed on a board.
   *
   * The same rules as the play screen (see chain.ts): the randomizer it points
   * at opens and waits, rolling a cell again replaces whatever its last answer
   * had opened, and a chain that would come back round stops and says so. On
   * a board the opened randomizer is a cell of its own, straight after the one
   * that sent you there, and is not saved: the board is still what it was.
   *
   * Per entry, `links` and `els` run in step; `els[0]` is the entry's own
   * holder and the rest are the cells its chain opened.
   */
  let chains = new Map<string, { links: ChainLink[]; els: HTMLElement[] }>();
  /** Roll all answers every question afresh, so it follows no links. */
  let rollingAll = false;
  /** Tonight's temporary cells (see "temporary cells" below); up here because Recent rolls reads it. */
  let temps: TempRandomizer[] = [];

  function landed(entryId: string, el: HTMLElement, randomizer: Randomizer, outcome: Outcome): void {
    const chain = chains.get(entryId);
    const at = chain ? chain.els.indexOf(el) : -1;
    // A cell whose chain was closed or rebuilt while it was in the air.
    if (!chain || at < 0) return;
    follow(entryId, at, rollingAll && at === 0 ? null : chainTarget(randomizer, outcome));
  }

  function follow(entryId: string, from: number, target: ReturnType<typeof chainTarget>): void {
    const chain = chains.get(entryId);
    if (!chain) return;
    const advance = advanceChain(chain.links, from, target, (id) => state.library.findById(id)?.randomizer ?? null);
    if (advance.note) state.toast(advance.note);
    for (const stale of chain.els.slice(from + 1)) stale.remove();
    chain.els.length = from + 1;
    chain.links = advance.links;
    for (let i = from + 1; i < chain.links.length; i++) {
      const surface = createChainSurface(chain.links[i], chain.links[i - 1].name, {
        onLanded: (outcome) => surface.cell && landed(entryId, surface.el, surface.cell.randomizer, outcome),
      });
      const close = button("✕", () => {
        const now = chains.get(entryId);
        const index = now ? now.els.indexOf(surface.el) : -1;
        if (index > 0) follow(entryId, index - 1, null);
      }, { class: "ghost cell-remove", "aria-label": `Close ${chain.links[i].name}` });
      surface.el.prepend(close);
      surface.el.classList.add("board-chain");
      chain.els[i - 1].after(surface.el);
      chain.els.push(surface.el);
    }
  }

  const heading = h("h1", { class: "board-name", text: board.name });
  const count = h("p", { class: "faint" });
  const addButton = button("Add…", () => void openPicker(), { class: "ghost add-to-board" });

  /**
   * Changing what is on the board happens in edit mode only.
   *
   * A board is played at a table, often on a projector, and one stray click
   * on a cell's ✕ used to take a randomizer off and save the board at once —
   * putting it back meant finding it in the library again. Play mode only
   * plays; Edit board brings out Add…, the ✕s and dragging. A chain's own ✕
   * is not a change to the board, so it stays. An empty board has nothing to
   * play, so it opens ready to edit.
   */
  let editing = board.entries.length === 0;
  const editButton = button("Edit board", () => setEditing(!editing), { class: "ghost edit-board" });
  function setEditing(on: boolean): void {
    editing = on;
    editButton.textContent = on ? "Done" : "Edit board";
    editButton.setAttribute("aria-pressed", String(on));
    addButton.hidden = !on;
    el.classList.toggle("board-editing", on);
    for (const holder of grid.querySelectorAll<HTMLElement>(".cell-holder")) holder.draggable = on;
  }
  const rollAll = button("Roll all", () => void rollEverything(), {
    class: "primary roll-all", style: { width: "100%", minHeight: "52px", fontSize: "17px" },
  });
  const shareButton = button("Share…", () => openShare(), { class: "ghost share-button" });
  const exitButton = button("Leave full screen", () => present(false), { class: "leave-presenting" });
  exitButton.hidden = true;
  const presentButton = button("Full screen", () => present(!isPresenting()), { class: "ghost present-button" });
  const present = (on: boolean): void => {
    // A projector shows the table, not the board being rearranged.
    if (on) setEditing(false);
    setPresenting(on, { exitButton, presentButton });
  };

  // The board's own randomizers and whatever their chains have opened: every
  // roll made on this screen shows here, and Clear takes the same set.
  const recent = createRecentRolls({
    ids: () => [...new Set([
      ...board.entries.map((e) => e.id),
      ...[...chains.values()].flatMap((c) => c.links.filter((l) => l.found).map((l) => l.id)),
      ...temps.map((t) => t.id),
    ])],
    scopeName: () => "this board",
  });

  /** The randomizers this board points at, in order, with the gaps named. */
  function resolve(): { entry: { id: string; name: string }; randomizer: Randomizer | null }[] {
    return board.entries.map((entry) => ({ entry, randomizer: state.library.findById(entry.id)?.randomizer ?? null }));
  }

  function render(): void {
    const resolved = resolve();
    // Cells are rebuilt whenever the board changes, so their handles are
    // rebound with them rather than tracked.
    cells = [];
    // Rebuilt cells are fresh answers-to-be, so whatever they had opened goes.
    chains = new Map();
    setChildren(grid, ...resolved.map(({ entry, randomizer }) => {
      if (!randomizer) return wrap(entry, createMissingCell(entry.name));
      let holder: HTMLElement | null = null;
      const cell = createCell(randomizer, { onLanded: (outcome) => holder && landed(entry.id, holder, randomizer, outcome) });
      cells.push(cell);
      // A cell of its own to roll: one roll on a board is often the point, and
      // only a cell's own roll follows an outcome's link.
      holder = wrap(entry, cell.el, cellRollButton(cell, "ghost cell-roll"));
      chains.set(entry.id, { links: [{ id: randomizer.id, name: randomizer.name, from: "", found: true }], els: [holder] });
      return holder;
    }), ...temps.map((t) => tempView(t).holder));
    grid.classList.toggle("board-empty", resolved.length === 0 && temps.length === 0);
    count.textContent = resolved.length === 0
      ? "Nothing on this board yet — press Add to put something on it."
      : `${resolved.length} randomizer${resolved.length === 1 ? "" : "s"}`;
    rollAll.disabled = cells.length === 0 && temps.length === 0;
    built = signature();
    recent.refresh();
  }

  function wrap(entry: { id: string; name: string }, inner: HTMLElement, roll: HTMLElement | null = null): HTMLElement {
    const remove = button("✕", () => void removeEntry(entry.id), { class: "ghost cell-remove", "aria-label": `Take ${entry.name} off the board` });
    const holder = h("div", { class: "cell-holder", "data-entry": entry.id }, remove, inner, roll);
    holder.draggable = editing;
    holder.addEventListener("dragstart", (e) => {
      if (!editing) {
        e.preventDefault();
        return;
      }
      (e as DragEvent).dataTransfer?.setData("text/orangey-entry", entry.id);
      holder.classList.add("dragging");
    });
    holder.addEventListener("dragend", () => holder.classList.remove("dragging"));
    holder.addEventListener("dragover", (e) => e.preventDefault());
    holder.addEventListener("drop", (e) => {
      e.preventDefault();
      const moved = (e as DragEvent).dataTransfer?.getData("text/orangey-entry");
      if (moved && moved !== entry.id) void moveEntry(moved, entry.id);
    });
    return holder;
  }

  async function save(next: BoardRandomizer): Promise<void> {
    Object.assign(board, touch(next));
    state.library.save(node.path, board);
    await state.library.flush();
    render();
  }

  async function addEntry(r: Randomizer): Promise<void> {
    if (board.entries.some((e) => e.id === r.id)) return;
    if (board.entries.length >= BOARD_LIMIT) {
      state.toast(`A board holds at most ${BOARD_LIMIT} randomizers.`);
      return;
    }
    await save({ ...board, entries: [...board.entries, { id: r.id, name: r.name }] });
  }

  /**
   * Take one off, and offer it back. The randomizer itself is untouched — only
   * the board's reference to it goes — so Undo is a matter of putting the
   * entry back where it was.
   */
  async function removeEntry(id: string): Promise<void> {
    const at = board.entries.findIndex((e) => e.id === id);
    if (at < 0) return;
    const removed = board.entries[at];
    await save({ ...board, entries: board.entries.filter((e) => e.id !== id) });
    state.toast(`Took “${removed.name}” off the board`, "Undo", () => {
      if (board.entries.some((e) => e.id === removed.id) || board.entries.length >= BOARD_LIMIT) return;
      const entries = [...board.entries];
      entries.splice(Math.min(at, entries.length), 0, removed);
      void save({ ...board, entries });
    });
  }

  /** Drop one entry onto another: the dragged one takes the target's place. */
  async function moveEntry(movedId: string, ontoId: string): Promise<void> {
    const entries = [...board.entries];
    const from = entries.findIndex((e) => e.id === movedId);
    const to = entries.findIndex((e) => e.id === ontoId);
    if (from < 0 || to < 0) return;
    const [moved] = entries.splice(from, 1);
    entries.splice(to, 0, moved);
    await save({ ...board, entries });
  }

  /**
   * What goes on the board: anything in the library, or something made here.
   * A board is usually assembled while thinking about tonight, and half of
   * what you want does not exist yet.
   */
  async function openPicker(): Promise<void> {
    const picked = await pickRandomizer({
      title: "Add to the board",
      taken: () => new Set(board.entries.map((e) => e.id)),
      allowNew: true,
      allowLink: true,
      allowNotation: true,
    });
    if (!picked) return;
    await addEntry(picked.randomizer);
    if (picked.fresh) {
      await state.library.flush();
      // Back from its editor returns to this board, not to the new
      // randomizer's own play screen, where there is no Back at all.
      navigate(editHash(picked.path, `#/r/${encodeURIComponent(node.path)}`));
    }
  }

  /**
   * Every cell at once, each at its own speed: a board is rolled to get all of
   * tonight's answers in one go, not to watch a sequence.
   */
  async function rollEverything(): Promise<void> {
    // Tonight's temporary cells are on the table too, so Roll all rolls them.
    const all = [...cells, ...tempCells()];
    if (all.some((c) => c.rolling)) {
      for (const cell of all) cell.skip();
      return;
    }
    if (all.length === 0) return;
    rollAll.textContent = "Skip";
    rollingAll = true;
    try {
      await Promise.all(all.map((cell) => cell.roll()));
    } finally {
      rollingAll = false;
    }
    rollAll.textContent = "Roll all";
  }

  /**
   * A board is shared as a file, not inside a link.
   *
   * One randomizer fits in an address; a board is several of them, and the
   * link would outgrow what decks and chat apps carry. The link here opens
   * this board in the library it is already in — which is what a slide needs —
   * and the archive is what goes to someone else.
   */
  function openShare(): void {
    // Where the keyboard came from, so it goes back there on close.
    const opener = document.activeElement as HTMLElement | null;
    const field = h("input", {
      type: "text", readonly: true, spellcheck: "false",
      "aria-label": "Link to this board in your library",
      value: slideLink(appBase(), board.id, { roll: false, present: false }),
    });
    const dialog = h("dialog", { class: "share-dialog" },
      h("h2", { text: "Share this board" }),
      h("p", { class: "faint", text: "A board points at the randomizers in your library rather than carrying copies, so it travels as a file. The link below opens it on a machine that already has them — your own, for a slide or a bookmark." }),
      field,
      h("div", { class: "row" },
        button("Copy", () => {
          (field as HTMLInputElement).select();
          void navigator.clipboard?.writeText((field as HTMLInputElement).value).catch(() => {});
          state.toast("Link copied");
        }, { class: "primary copy-link" }),
        button("Download the board and everything on it", () => {
          void exportBoardZip(board);
          (dialog as HTMLDialogElement).close();
        }, { class: "export-board" }),
        h("span", { class: "spacer" }),
        button("Close", () => (dialog as HTMLDialogElement).close()),
      ),
    );
    openDialog(dialog as HTMLDialogElement, opener);
    (field as HTMLInputElement).select();
  }


  const onKey = (e: KeyboardEvent) => {
    if (isTyping(e)) return;
    if (e.key === "Escape" && isPresenting()) {
      present(false);
      return;
    }
    // On a cell's own Roll the key belongs to that button: a keyboard user
    // who tabbed to one cell meant that cell, not the whole board.
    if ((e.target as HTMLElement | null)?.closest?.(".cell-roll, .chain-roll, .offer-card")) return;
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      void rollEverything();
    }
  };
  document.addEventListener("keydown", onKey);

  // The library tree drags a path as text/plain, so dropping a randomizer from
  // the sidebar onto the board is the same gesture as dropping it in a folder.
  grid.addEventListener("dragover", (e) => {
    if ((e as DragEvent).dataTransfer?.types.includes("text/plain")) e.preventDefault();
  });
  grid.addEventListener("drop", (e) => {
    const path = (e as DragEvent).dataTransfer?.getData("text/plain");
    if (!path) return;
    e.preventDefault();
    const dropped = state.library.find(path)?.randomizer;
    if (!dropped) return;
    if (!editing) {
      state.toast("Press Edit board to add to it.");
      return;
    }
    if (dropped.type === "board") {
      state.toast("A board cannot go on a board.");
      return;
    }
    void addEntry(dropped);
  });

  // ---- temporary cells ----------------------------------------------------

  /**
   * A dice expression or a quick wheel for tonight, beside the board's own
   * cells without being part of the board (see board-temps.ts). Each has a ✕
   * that is always there — closing one is not a change to the board — and
   * "Save to library", which saves it and puts it on the board for good.
   */
  /** Built once per temporary cell and kept, so a board redraw keeps its answer. */
  const tempViews = new Map<string, { holder: HTMLElement; cell: () => CellView | null }>();

  const tempCells = (): CellView[] =>
    temps.map((t) => tempViews.get(t.id)?.cell() ?? null).filter((c): c is CellView => c !== null);

  /**
   * Stored on every change, keystrokes included. It is one small record, and
   * a write held back for a pause in the typing was lost whenever the page
   * went away inside that pause: a write begun while a page unloads does not
   * reliably finish.
   */
  function storeTemps(): void {
    void saveBoardTemps(board.id, temps);
  }

  function addTemp(t: TempRandomizer): void {
    if (temps.length >= BOARD_TEMP_LIMIT) {
      state.toast(`A board holds at most ${BOARD_TEMP_LIMIT} temporary cells. Close one, or save it to your library.`);
      return;
    }
    temps = [...temps, t];
    storeTemps();
    render();
  }

  function closeTemp(id: string): void {
    temps = temps.filter((t) => t.id !== id);
    tempViews.delete(id);
    storeTemps();
    render();
  }

  /** Save it to the library, and put it on the board where it was standing in. */
  async function keepTemp(id: string): Promise<void> {
    const t = temps.find((x) => x.id === id);
    if (!t) return;
    if (t.type === "list" && t.items.length === 0) {
      state.toast("Type at least one option before saving the wheel.");
      return;
    }
    const taken = state.library.findById(t.id) !== null;
    const saved = { ...t, id: taken ? newId() : t.id, modified: nowIso() };
    await state.library.create("", saved);
    temps = temps.filter((x) => x.id !== id);
    tempViews.delete(id);
    storeTemps();
    if (board.entries.length >= BOARD_LIMIT) {
      state.toast(`Saved “${saved.name}” to your library. The board already holds ${BOARD_LIMIT}, so it is not on it.`);
      render();
      return;
    }
    state.toast(`Saved “${saved.name}” to your library and put it on this board`);
    await save({ ...board, entries: [...board.entries, { id: saved.id, name: saved.name }] });
  }

  function tempView(t: TempRandomizer): { holder: HTMLElement; cell: () => CellView | null } {
    const existing = tempViews.get(t.id);
    if (existing) return existing;

    const close = button("✕", () => closeTemp(t.id), { class: "ghost temp-close", "aria-label": `Close ${t.name}` });
    const keep = button("Save to library", () => void keepTemp(t.id), { class: "ghost temp-save" });
    const body = h("div", { class: "temp-body" });
    const roll = h("div", { class: "temp-roll" });
    let cell: CellView | null = null;

    /** The cell for the randomizer as it stands; a wheel with nothing typed has none yet. */
    const build = (r: TempRandomizer): void => {
      cell = r.type === "list" && r.items.length === 0 ? null : createCell(r);
      setChildren(body, cell ? cell.el : h("p", { class: "faint temp-empty", text: "Type the options above, one per line." }));
      setChildren(roll, cell ? cellRollButton(cell, "ghost cell-roll") : null);
    };

    let editor: HTMLElement | null = null;
    if (t.type === "list") {
      // The options live in the cell, so the wheel can be changed at any
      // time, as the one on the home screen can.
      const area = h("textarea", {
        class: "quick-options temp-options", rows: "3", spellcheck: "false",
        placeholder: "Goblins\nBandits | 2\nNothing x3", "aria-label": "Options, one per line",
      });
      area.value = quickText(t.items);
      const offer = h("input", {
        type: "number", min: String(OFFER_MIN), max: String(OFFER_MAX), class: "quick-offer",
        "aria-label": "Offer this many to choose from", placeholder: "–",
        value: t.offer !== undefined ? String(t.offer) : "",
      });
      let frame = 0;
      const update = (): void => {
        const raw = offer.value.trim();
        const n = Number(raw);
        const ok = raw !== "" && Number.isInteger(n) && n >= OFFER_MIN && n <= OFFER_MAX;
        if (raw !== "" && !ok) offer.setAttribute("aria-invalid", "true");
        else offer.removeAttribute("aria-invalid");
        const at = temps.findIndex((x) => x.id === t.id);
        if (at < 0) return;
        const next: ListRandomizer = { ...(temps[at] as ListRandomizer), items: parseQuickOptions(area.value), modified: nowIso() };
        if (ok) next.offer = n;
        else delete next.offer;
        temps = temps.map((x, i) => (i === at ? next : x));
        storeTemps();
        // Redrawn once a frame, and never under a spin: a roll in the air
        // finishes on the wheel it started on.
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          if (cell?.rolling) return;
          build(next);
          recent.refresh();
        });
      };
      area.addEventListener("input", update);
      offer.addEventListener("input", update);
      editor = h("details", { class: "temp-editor", open: t.items.length === 0 },
        h("summary", { class: "faint", text: "Options" }),
        area,
        h("label", { class: "row tight faint" }, "Offer", offer, "to choose from"),
      );
      if (t.items.length === 0) requestAnimationFrame(() => area.focus({ preventScroll: false }));
    }

    build(t);
    const holder = h("div", { class: "cell-holder cell-temp", "data-temp": t.id },
      h("div", { class: "row tight temp-head" },
        h("span", { class: "faint temp-tag", text: "Just for now" }),
        h("span", { class: "spacer" }),
        keep,
        close,
      ),
      editor,
      body,
      roll,
    );
    const view = { holder, cell: () => cell };
    tempViews.set(t.id, view);
    return view;
  }

  // The bar that makes them: a dice box and a quick wheel, nothing more.
  const diceBox = h("input", {
    type: "text", class: "board-dice", placeholder: "3d20", spellcheck: "false",
    "aria-label": "Dice to put on the board for now",
  });
  const diceError = h("span", { class: "faint board-dice-error" });
  diceBox.addEventListener("input", () => {
    const v = diceBox.value.trim();
    const parsed = v ? tryParse(v) : null;
    diceError.textContent = parsed && !parsed.ok ? parsed.error.message : "";
    if (parsed && !parsed.ok) diceBox.setAttribute("aria-invalid", "true");
    else diceBox.removeAttribute("aria-invalid");
  });
  diceBox.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key !== "Enter") return;
    e.preventDefault();
    const parsed = tryParse(diceBox.value.trim());
    if (!parsed.ok) return;
    const expression = parsed.expression.normalized;
    const dice = { ...emptyRandomizer("dice", expression), expression } as DiceRandomizer;
    addTemp(dice);
    diceBox.value = "";
  });
  const quickBar = h("div", { class: "row tight board-quickbar" },
    diceBox,
    button("Quick wheel", () => {
      const now = nowIso();
      addTemp({ id: newId(), type: "list", name: "Quick wheel", view: "wheel", items: [], created: now, modified: now });
    }, { class: "quick-wheel-toggle board-quick-wheel" }),
    diceError,
  );

  const el = h("div", { class: "board" },
    h("div", { class: "row home-bar" },
      button("← Home", () => navigate("#/"), { class: "ghost home-button" }),
      h("span", { class: "spacer" }),
      addButton, editButton, shareButton, presentButton, exitButton,
    ),
    h("div", { class: "card board-card" },
      heading,
      board.description ? h("p", { class: "faint", text: board.description }) : count,
      board.description ? count : null,
      quickBar,
      grid,
      rollAll,
    ),
    recent.el,
  );

  /**
   * What the cells are built from: the entries, and the state of each
   * randomizer they point at. Rebuilding on every change of state would throw
   * away the results the cells are showing — including, one frame later, the
   * result of the roll that caused the change.
   */
  function signature(): string {
    return resolve()
      .map(({ entry, randomizer }) => `${entry.id}:${randomizer ? randomizer.modified : "gone"}`)
      .join("|") + `|temps:${temps.map((t) => t.id).join(",")}`;
  }
  let built = "";
  let destroyed = false;
  function renderIfChanged(): void {
    if (signature() === built) {
      recent.refresh();
      return;
    }
    render();
  }

  // A randomizer edited elsewhere, or deleted, changes what a board shows.
  const unsubscribe = state.subscribe(() => renderIfChanged(), ["library", "history"]);
  render();
  // Tonight's temporary cells come back from the app database a moment later.
  void loadBoardTemps(board.id).then((stored) => {
    if (destroyed || stored.length === 0) return;
    temps = stored;
    render();
  });
  setEditing(editing);
  if (params.present) present(true);
  if (params.roll) requestAnimationFrame(() => void rollEverything());

  return {
    el,
    destroy() {
      destroyed = true;
      document.removeEventListener("keydown", onKey);
      unsubscribe();
      if (isPresenting()) present(false);
    },
  };
}
