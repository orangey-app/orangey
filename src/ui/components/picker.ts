/**
 * Choosing a randomizer from the library, for a board (what goes on it) or an
 * outcome's "Goes to". Shows the library as a tree, flattens to matches as you
 * type, takes a pasted link or dice notation, and can make a new randomizer.
 *
 * A board takes several (`pickRandomizers`): Ctrl/⌘-click adds one, Shift-click
 * a run, a right-click on a folder everything in it. Once something is chosen a
 * plain click chooses too (an iPad has no Ctrl) and "Add N" adds the lot; with
 * nothing chosen a click adds that one at once.
 */

import { emptyRandomizer, type DiceRandomizer, type Randomizer, type RollableType } from "../../model/randomizer.ts";
import { diceNotation } from "../../core/dice/grammar.ts";
import { decodeRandomizer } from "../../model/link.ts";
import type { LibraryNode } from "../../storage/library.ts";
import { askText, button, h, openDialog, setChildren } from "../dom.ts";
import { state } from "./../state.ts";

export interface PickedRandomizer {
  randomizer: Randomizer;
  path: string;
  /** True when this one was made just now, so the caller can open its editor. */
  fresh: boolean;
}

export interface PickerOptions {
  title: string;
  /** Randomizers already spoken for, by id: shown greyed rather than hidden. */
  taken?: () => Set<string>;
  allowNew?: boolean;
  allowLink?: boolean;
  /** Take dice notation typed into the search box, such as "2d6 + 3". */
  allowNotation?: boolean;
  /** How many more fit (a board's limit), so choosing past it can say so. */
  room?: () => number;
}

/**
 * Where dice made from typed notation are kept. A board entry points at a
 * library randomizer, so "2d6 + 3" typed on a board must become a file. They are
 * reused only from this folder, so editing a named "Attack roll" that happens to
 * have the same dice never changes a board that only typed the notation.
 */
const QUICK_DICE_FOLDER = "Dice";

const NEW_TYPES: [RollableType, string][] = [
  ["list", "New wheel"],
  ["dice", "New dice"],
  ["coin", "New coin"],
  ["number", "New number"],
];

/** One randomizer: where an outcome goes. */
export function pickRandomizer(opts: PickerOptions): Promise<PickedRandomizer | null> {
  return openPicker(opts, false).then((picked) => picked?.[0] ?? null);
}

/** One or several, in library order: what goes on a board. */
export function pickRandomizers(opts: PickerOptions): Promise<PickedRandomizer[] | null> {
  return openPicker(opts, true);
}

function openPicker(opts: PickerOptions, multiple: boolean): Promise<PickedRandomizer[] | null> {
  return new Promise((resolve) => {
    const taken = opts.taken?.() ?? new Set<string>();
    let answered = false;
    const finish = (picked: PickedRandomizer[] | null) => {
      if (answered) return;
      answered = true;
      dialog.close();
      resolve(picked);
    };
    const finishOne = (picked: PickedRandomizer) => finish([picked]);

    /**
     * What is chosen so far, by path. A Shift-click reaches back to `anchor`,
     * the last row clicked on its own terms; `drawn` is the order the choice
     * rows are drawn in, which is what a run runs along.
     */
    const chosen = new Set<string>();
    let anchor: string | null = null;
    let drawn: LibraryNode[] = [];

    const list = h("div", { class: "picker-tree" });
    const search = h("input", { type: "search", placeholder: "Search your library", "aria-label": "Search your library" });
    const note = h("p", { class: "faint picker-note" });
    const open = new Set<string>();

    function choose(node: LibraryNode): void {
      if (!node.randomizer) return;
      finishOne({ randomizer: node.randomizer, path: node.path, fresh: false });
    }

    /** Whether this row can be chosen: a randomizer that is not already there. */
    function choosable(node: LibraryNode): boolean {
      const r = node.randomizer;
      return node.kind === "file" && !!r && r.type !== "board" && !taken.has(r.id);
    }

    function clicked(node: LibraryNode, e: MouseEvent): void {
      const toggle = e.ctrlKey || e.metaKey;
      if (!multiple || (!toggle && !e.shiftKey && chosen.size === 0)) {
        choose(node);
        return;
      }
      if (e.shiftKey && anchor !== null) {
        const from = drawn.findIndex((n) => n.path === anchor);
        const to = drawn.findIndex((n) => n.path === node.path);
        if (from >= 0 && to >= 0) {
          for (const n of drawn.slice(Math.min(from, to), Math.max(from, to) + 1)) {
            if (choosable(n)) chosen.add(n.path);
          }
          render();
          return;
        }
      }
      if (chosen.has(node.path)) chosen.delete(node.path);
      else chosen.add(node.path);
      anchor = node.path;
      render();
    }

    /** Everything choosable directly in a folder: chosen, or unchosen if it all was. */
    function chooseFolder(folder: LibraryNode): void {
      const inside = (folder.children ?? []).filter(choosable);
      if (inside.length === 0) return;
      const all = inside.every((n) => chosen.has(n.path));
      for (const n of inside) {
        if (all) chosen.delete(n.path);
        else chosen.add(n.path);
      }
      open.add(folder.path);
      render();
    }

    /** The chosen ones, in the order the library lists them. */
    function add(): void {
      const picked = state.library.files()
        .filter((n) => chosen.has(n.path) && n.randomizer)
        .map((n) => ({ randomizer: n.randomizer!, path: n.path, fresh: false }));
      if (picked.length) finish(picked);
    }

    /** One row: a folder you can open, or a randomizer you can choose. */
    function row(node: LibraryNode, depth: number, where = ""): HTMLElement {
      if (node.kind === "folder") {
        const isOpen = open.has(node.path);
        const control = button(`${isOpen ? "▾" : "▸"} 📁 ${node.name}`, () => {
          if (isOpen) open.delete(node.path);
          else open.add(node.path);
          render();
        }, {
          class: "ghost picker-row picker-folder", style: { paddingLeft: `${8 + depth * 14}px` },
          ...(multiple ? { title: "Right-click to choose everything in it" } : {}),
        });
        // In a modal dialog a menu would open behind it, so the right-click
        // does the one thing the menu would offer.
        if (multiple) {
          control.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            chooseFolder(node);
          });
        }
        return control;
      }
      const already = node.randomizer ? taken.has(node.randomizer.id) : false;
      // The randomizer's name, not the file's: "Attack roll", not
      // "attack-roll.orangey.json".
      const shown = node.randomizer?.name ?? node.name;
      const label = where ? `${shown} — ${where}` : shown;
      const isChosen = chosen.has(node.path);
      const choice = h("button", {
        type: "button",
        class: `ghost picker-row picker-choice${already ? " picker-taken" : ""}${isChosen ? " picker-chosen" : ""}`,
        style: { paddingLeft: `${8 + depth * 14}px` },
        onclick: (e: Event) => clicked(node, e as MouseEvent),
        ...(already ? { disabled: "", title: "Already there" } : {}),
        ...(multiple && chosen.size > 0 ? { "aria-pressed": String(isChosen) } : {}),
      }, label);
      // Shift-click would select the page's text; the row is what is meant.
      if (multiple) choice.addEventListener("mousedown", (e) => { if ((e as MouseEvent).shiftKey) e.preventDefault(); });
      drawn.push(node);
      return choice;
    }

    function walk(node: LibraryNode, depth: number, out: HTMLElement[]): void {
      for (const child of node.children ?? []) {
        // A board cannot go on a board, and nothing can point at one: a board
        // is not something that rolls.
        if (child.kind === "file" && (!child.randomizer || child.randomizer.type === "board")) continue;
        out.push(row(child, depth));
        if (child.kind === "folder" && open.has(child.path)) walk(child, depth + 1, out);
      }
    }

    /** The typed text as dice notation, when this picker takes notation. */
    function typedNotation(): string | null {
      const query = (search as HTMLInputElement).value.trim();
      return opts.allowNotation && query ? diceNotation(query) : null;
    }

    function render(): void {
      const query = (search as HTMLInputElement).value.trim();
      const rows: HTMLElement[] = [];
      drawn = [];
      const notation = typedNotation();
      if (notation) {
        rows.push(button(`🎲 Add ${notation}`, () => void useNotation(notation), { class: "ghost picker-row picker-notation" }));
      }
      if (query) {
        // Typing flattens the tree: matches from every folder, each saying
        // which folder it came from.
        const seen = new Set<string>();
        for (const hit of state.library.search(query)) {
          const r = hit.node.randomizer;
          if (!r || r.type === "board" || seen.has(hit.node.path)) continue;
          seen.add(hit.node.path);
          const folder = hit.node.path.includes("/") ? hit.node.path.slice(0, hit.node.path.lastIndexOf("/")) : "";
          rows.push(row(hit.node, 0, folder));
        }
        note.textContent = rows.length ? "" : `Nothing in your library matches "${query}".`;
      } else {
        walk(state.library.tree, 0, rows);
        note.textContent = rows.length ? "" : "Your library is empty.";
      }
      setChildren(list, ...rows);
      renderChosen();
    }

    const addChosen = button("Add", () => add(), { class: "primary picker-add" });
    const chosenNote = h("p", { class: "faint picker-chosen-note", "aria-live": "polite" });
    function renderChosen(): void {
      if (!multiple) return;
      const count = chosen.size;
      addChosen.hidden = count === 0;
      addChosen.textContent = `Add ${count}`;
      const room = opts.room?.() ?? Infinity;
      chosenNote.textContent = count === 0
        ? "Ctrl-click or Shift-click to choose several; right-click a folder for all of it."
        : count > room
          ? `${count} chosen. There is room for ${room} more, so only the first ${room} will go on.`
          : `${count} chosen. Click more to add them, or press Add ${count}.`;
    }

    search.addEventListener("input", render);
    search.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key !== "Enter") return;
      const notation = typedNotation();
      if (!notation) {
        // Enter in the search box adds what is chosen, when something is.
        if (multiple && chosen.size > 0) {
          e.preventDefault();
          add();
        }
        return;
      }
      e.preventDefault();
      void useNotation(notation);
    });

    /**
     * Dice from typed notation: reuse one already made for the same expression, or
     * make it. One already on this board is not reused: a board holds each
     * randomizer once, and two "2d6" cells (one per player) is a thing people want.
     */
    let making = false;
    async function useNotation(expression: string): Promise<void> {
      if (making) return;
      making = true;
      try {
        const folder = await quickDiceFolder();
        for (const child of state.library.find(folder)?.children ?? []) {
          const r = child.randomizer;
          if (r?.type === "dice" && !taken.has(r.id) && diceNotation(r.expression) === expression) {
            finishOne({ randomizer: r, path: child.path, fresh: false });
            return;
          }
        }
        const randomizer = { ...emptyRandomizer("dice", expression), expression } as DiceRandomizer;
        const path = await state.library.create(folder, randomizer);
        finishOne({ randomizer, path, fresh: false });
      } finally {
        making = false;
      }
    }

    /** The quick-dice folder, made the first time; any capitalisation counts. */
    async function quickDiceFolder(): Promise<string> {
      const existing = state.library.tree.children?.find(
        (c) => c.kind === "folder" && c.name.toLowerCase() === QUICK_DICE_FOLDER.toLowerCase(),
      );
      return existing ? existing.path : state.library.createFolder("", QUICK_DICE_FOLDER);
    }

    async function makeNew(type: RollableType, title: string): Promise<void> {
      const name = await askText(title, { label: "Name", value: title, confirm: "Create" });
      if (!name) return;
      const randomizer = emptyRandomizer(type, name);
      const path = await state.library.create("", randomizer);
      finishOne({ randomizer, path, fresh: true });
    }

    async function useLink(raw: string): Promise<void> {
      const text = raw.trim();
      if (!text) return;
      const byId = /#\/id\/([^?&/]+)/.exec(text);
      const id = byId ? decodeURIComponent(byId[1]) : text.includes("/") || text.includes("?") ? null : text;
      if (id) {
        const node = state.library.findById(id);
        if (!node?.randomizer) {
          note.textContent = "That link points at something this library does not have.";
          return;
        }
        choose(node);
        return;
      }
      const embedded = /[?&]w=([^&]+)/.exec(text);
      if (!embedded) {
        note.textContent = "That does not look like a link to a randomizer.";
        return;
      }
      // A link with the wheel inside it is not a library item: it has to be
      // kept before anything can point at it.
      try {
        const randomizer = await decodeRandomizer(embedded[1]);
        const path = await state.library.create("", randomizer);
        note.textContent = "";
        finishOne({ randomizer, path, fresh: false });
        state.toast(`"${randomizer.name}" was saved to your library first, so this can point at it.`);
      } catch {
        note.textContent = "That link is damaged, so there is nothing to point at.";
      }
    }

    const linkField = h("input", { type: "text", placeholder: "…or paste a link", "aria-label": "Paste a link to a randomizer" });
    linkField.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") void useLink((linkField as HTMLInputElement).value);
    });

    const dialog = h("dialog", { class: "picker-dialog" },
      h("h2", { text: opts.title }),
      opts.allowNew
        ? h("div", { class: "row tight picker-new" },
            ...NEW_TYPES.map(([type, title]) => button(title, () => void makeNew(type, title), { class: "ghost picker-new-button" })),
          )
        : null,
      search,
      list,
      note,
      multiple ? chosenNote : null,
      h("div", { class: "row" },
        opts.allowLink ? linkField : null,
        opts.allowLink ? button("Use link", () => void useLink((linkField as HTMLInputElement).value), { class: "ghost use-link" }) : null,
        h("span", { class: "spacer" }),
        multiple ? addChosen : null,
        button("Close", () => finish(null), { class: "picker-close" }),
      ),
    ) as HTMLDialogElement;

    // Where the keyboard came from, so it goes back there on close.
    const opener = document.activeElement as HTMLElement | null;
    dialog.addEventListener("close", () => finish(null));
    render();
    openDialog(dialog, opener);
    search.focus();
  });
}
