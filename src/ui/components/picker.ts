/**
 * Choosing a randomizer from the library.
 *
 * Used by a board (what goes on it) and by an outcome's "Goes to" (where it
 * sends you). Both used to offer a flat list of every randomizer, which is
 * fine with six and unusable with sixty: a real game has folders.
 *
 * The dialog shows the library as a tree, flattens to matches while you type,
 * takes a link someone sent you, and can make a new randomizer on the spot —
 * because the thing you want to put on a board often does not exist yet.
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
  /** Offer to make a new randomizer. */
  allowNew?: boolean;
  /** Take a link that someone pasted. */
  allowLink?: boolean;
  /** Take dice notation typed into the search box, such as "2d6 + 3". */
  allowNotation?: boolean;
}

/**
 * Where dice made from typed notation live. A board entry is a reference to a
 * library randomizer (see ARCHITECTURE.md), so "2d6 + 3" typed on a board has
 * to become a file somewhere; one folder keeps them out of the way, and is the
 * only place they are reused from — a named "Attack roll" that happens to be
 * d20 + 5 is its own thing, and editing it should never change a board that
 * only asked for d20 + 5.
 */
const QUICK_DICE_FOLDER = "Dice";

const NEW_TYPES: [RollableType, string][] = [
  ["list", "New wheel"],
  ["dice", "New dice"],
  ["coin", "New coin"],
  ["number", "New number"],
];

export function pickRandomizer(opts: PickerOptions): Promise<PickedRandomizer | null> {
  return new Promise((resolve) => {
    const taken = opts.taken?.() ?? new Set<string>();
    let answered = false;
    const finish = (picked: PickedRandomizer | null) => {
      if (answered) return;
      answered = true;
      dialog.close();
      resolve(picked);
    };

    const list = h("div", { class: "picker-tree" });
    const search = h("input", { type: "search", placeholder: "Search your library", "aria-label": "Search your library" });
    const note = h("p", { class: "faint picker-note" });
    const open = new Set<string>();

    function choose(node: LibraryNode): void {
      if (!node.randomizer) return;
      finish({ randomizer: node.randomizer, path: node.path, fresh: false });
    }

    /** One row: a folder you can open, or a randomizer you can choose. */
    function row(node: LibraryNode, depth: number, where = ""): HTMLElement {
      if (node.kind === "folder") {
        const isOpen = open.has(node.path);
        const control = button(`${isOpen ? "▾" : "▸"} 📁 ${node.name}`, () => {
          if (isOpen) open.delete(node.path);
          else open.add(node.path);
          render();
        }, { class: "ghost picker-row picker-folder", style: { paddingLeft: `${8 + depth * 14}px` } });
        return control;
      }
      const already = node.randomizer ? taken.has(node.randomizer.id) : false;
      // The randomizer's name, not the file's: "Attack roll", not
      // "attack-roll.orangey.json".
      const shown = node.randomizer?.name ?? node.name;
      const label = where ? `${shown} — ${where}` : shown;
      const choice = button(label, () => choose(node), {
        class: `ghost picker-row picker-choice${already ? " picker-taken" : ""}`,
        style: { paddingLeft: `${8 + depth * 14}px` },
        ...(already ? { disabled: "", title: "Already there" } : {}),
      });
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
    }

    search.addEventListener("input", render);
    search.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key !== "Enter") return;
      const notation = typedNotation();
      if (!notation) return;
      e.preventDefault();
      void useNotation(notation);
    });

    /**
     * Dice from typed notation: reuse one already made for the same
     * expression, or make it. One that is already taken here is not reused,
     * because a board holds each randomizer once and two "2d6" cells — one per
     * player — is a thing people want.
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
            finish({ randomizer: r, path: child.path, fresh: false });
            return;
          }
        }
        const randomizer = { ...emptyRandomizer("dice", expression), expression } as DiceRandomizer;
        const path = await state.library.create(folder, randomizer);
        finish({ randomizer, path, fresh: false });
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
      finish({ randomizer, path, fresh: true });
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
        finish({ randomizer, path, fresh: false });
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
      h("div", { class: "row" },
        opts.allowLink ? linkField : null,
        opts.allowLink ? button("Use link", () => void useLink((linkField as HTMLInputElement).value), { class: "ghost use-link" }) : null,
        h("span", { class: "spacer" }),
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
