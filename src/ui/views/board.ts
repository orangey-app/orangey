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

import { BOARD_LIMIT, touch, type BoardRandomizer, type Randomizer } from "../../model/randomizer.ts";
import type { LibraryNode } from "../../storage/library.ts";
import { button, h, setChildren } from "../dom.ts";
import { state } from "../state.ts";
import { createCell, createMissingCell, type CellView } from "../components/cell.ts";
import { createRecentRolls } from "../components/recent.ts";
import { pickRandomizer } from "../components/picker.ts";
import { exportBoardZip } from "../storage-actions.ts";
import { appBase, navigate, slideLink } from "../router.ts";
import type { View } from "./editor.ts";

export function createBoardView(node: LibraryNode, params: { roll?: boolean; present?: boolean } = {}): View {
  const board = node.randomizer as BoardRandomizer;
  const grid = h("div", { class: "board-grid" });
  let cells: CellView[] = [];

  const heading = h("h1", { class: "board-name", text: board.name });
  const count = h("p", { class: "faint" });
  const addButton = button("Add…", () => void openPicker(), { class: "ghost add-to-board" });
  const rollAll = button("Roll all", () => void rollEverything(), {
    class: "primary roll-all", style: { width: "100%", minHeight: "52px", fontSize: "17px" },
  });
  const shareButton = button("Share…", () => openShare(), { class: "ghost share-button" });
  const exitButton = button("Leave full screen", () => setPresenting(false), { class: "leave-presenting" });
  exitButton.hidden = true;
  const presentButton = button("Full screen", () => setPresenting(!presenting()), { class: "ghost present-button" });

  const recent = createRecentRolls({
    ids: () => board.entries.map((e) => e.id),
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
    setChildren(grid, ...resolved.map(({ entry, randomizer }) => {
      if (!randomizer) return wrap(entry, createMissingCell(entry.name));
      const cell = createCell(randomizer);
      cells.push(cell);
      return wrap(entry, cell.el);
    }));
    grid.classList.toggle("board-empty", resolved.length === 0);
    count.textContent = resolved.length === 0
      ? "Nothing on this board yet — press Add to put something on it."
      : `${resolved.length} randomizer${resolved.length === 1 ? "" : "s"}`;
    rollAll.disabled = cells.length === 0;
    built = signature();
    recent.refresh();
  }

  function wrap(entry: { id: string; name: string }, inner: HTMLElement): HTMLElement {
    const remove = button("✕", () => void removeEntry(entry.id), { class: "ghost cell-remove", "aria-label": `Take ${entry.name} off the board` });
    const holder = h("div", { class: "cell-holder", draggable: "true", "data-entry": entry.id }, remove, inner);
    holder.addEventListener("dragstart", (e) => {
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

  async function removeEntry(id: string): Promise<void> {
    await save({ ...board, entries: board.entries.filter((e) => e.id !== id) });
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
    });
    if (!picked) return;
    await addEntry(picked.randomizer);
    if (picked.fresh) {
      await state.library.flush();
      navigate(`#/edit/${encodeURIComponent(picked.path)}`);
    }
  }

  /**
   * Every cell at once, each at its own speed: a board is rolled to get all of
   * tonight's answers in one go, not to watch a sequence.
   */
  async function rollEverything(): Promise<void> {
    if (cells.some((c) => c.rolling)) {
      for (const cell of cells) cell.skip();
      return;
    }
    rollAll.textContent = "Skip";
    await Promise.all(cells.map((cell) => cell.roll()));
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
    document.body.append(dialog);
    dialog.addEventListener("close", () => dialog.remove());
    (dialog as HTMLDialogElement).showModal();
    (field as HTMLInputElement).select();
  }

  function presenting(): boolean {
    return document.body.classList.contains("presenting");
  }

  function setPresenting(on: boolean): void {
    document.body.classList.toggle("presenting", on);
    exitButton.hidden = !on;
    presentButton.textContent = on ? "Leave full screen" : "Full screen";
    if (on && document.documentElement.requestFullscreen) {
      void document.documentElement.requestFullscreen().catch(() => {});
    } else if (!on && document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    }
  }

  const onKey = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
    if (e.key === "Escape" && presenting()) {
      setPresenting(false);
      return;
    }
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
    if (dropped.type === "board") {
      state.toast("A board cannot go on a board.");
      return;
    }
    void addEntry(dropped);
  });

  const el = h("div", { class: "board" },
    h("div", { class: "row home-bar" },
      button("← Home", () => navigate("#/"), { class: "ghost home-button" }),
      h("span", { class: "spacer" }),
      addButton, shareButton, presentButton, exitButton,
    ),
    h("div", { class: "card board-card" },
      heading,
      board.description ? h("p", { class: "faint", text: board.description }) : count,
      board.description ? count : null,
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
      .join("|");
  }
  let built = "";
  function renderIfChanged(): void {
    if (signature() === built) {
      recent.refresh();
      return;
    }
    render();
  }

  // A randomizer edited elsewhere, or deleted, changes what a board shows.
  const unsubscribe = state.subscribe(() => renderIfChanged());
  render();
  if (params.present) setPresenting(true);
  if (params.roll) requestAnimationFrame(() => void rollEverything());

  return {
    el,
    destroy() {
      document.removeEventListener("keydown", onKey);
      unsubscribe();
      if (presenting()) setPresenting(false);
    },
  };
}
