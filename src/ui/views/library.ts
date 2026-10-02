/**
 * The library: the folder tree, search, and everything you can do to a
 * randomizer other than edit its contents.
 *
 * The tree is the library (there is no index file to fall out of step with it),
 * so every operation here is a plain file operation. A selection (Ctrl/⌘- or
 * Shift-click, or a folder's menu) only adds to boards: moving and deleting stay
 * one at a time, where a slip costs one file, not twelve.
 */

import { serialize, slugify, wrap } from "../../model/file.ts";
import { emptyRandomizer, isBoard, type BoardRandomizer, type ListRandomizer, type Randomizer, type RandomizerType } from "../../model/randomizer.ts";
import { listCsv } from "../../import/listcsv.ts";
import type { LibraryNode } from "../../storage/library.ts";
import { basename, parent } from "../../storage/paths.ts";
import { regrantFolder, rememberedFolderName } from "../../storage/fsdir.ts";
import { LibraryService } from "../../storage/library.ts";
import { aboutPack, editableCopy, publishPack } from "../packs.ts";
import { canUseFolder, describeStorage, exportBoardZip, exportLibraryFile, exportLibraryZip, portableRandomizer, stopUsingFolder, useFolder } from "../storage-actions.ts";
import { askConfirm, askFolder, askText, button, download, h, iconButton, openMenu, setChildren, type MenuItem } from "../dom.ts";
import { state } from "../state.ts";
import { LIBRARY_PATHS_TYPE } from "../dragpaths.ts";
import { appBase, navigate, slideLink } from "../router.ts";
import type { View } from "../view.ts";

export function createLibraryView(): View {
  const tree = h("div", { class: "tree-holder" });
  const searchInput = h("input", { type: "search", placeholder: "Search", "aria-label": "Search the library" });
  const results = h("div");
  const banner = h("div");
  let selectedFolder = "";
  let dragging: string | null = null;
  /** Whether the drag under way is a selection of several. */
  let draggingMany = false;

  /**
   * Rows chosen with Ctrl or Shift, by path. A Shift-click reaches back to
   * `selectAnchor`, the last row chosen on its own. The set outlives a redraw, so
   * a save elsewhere does not drop it; paths that are gone are let go.
   */
  const selected = new Set<string>();
  let selectAnchor: string | null = null;
  // Polite, not a status role: the page's one status region is the answer's.
  const selectionBar = h("div", { class: "row tight library-selection", "aria-live": "polite" });

  /** The file rows a person can see, top to bottom: what a Shift-click runs along. */
  function visibleFiles(node: LibraryNode = state.library.tree, depth = 0, out: string[] = []): string[] {
    if (depth > 0 && !state.prefs.expandedFolders.includes(node.path)) return out;
    for (const child of node.children ?? []) {
      if (child.kind === "folder") visibleFiles(child, depth + 1, out);
      else out.push(child.path);
    }
    return out;
  }

  /** The selection in library order, which is the order a board is given it. */
  function selection(): string[] {
    return state.library.files().map((n) => n.path).filter((p) => selected.has(p));
  }

  function selectRow(node: LibraryNode, e: MouseEvent): void {
    if (e.shiftKey && selectAnchor !== null) {
      const order = visibleFiles();
      const from = order.indexOf(selectAnchor);
      const to = order.indexOf(node.path);
      if (from >= 0 && to >= 0) {
        for (const p of order.slice(Math.min(from, to), Math.max(from, to) + 1)) selected.add(p);
        showSelection();
        return;
      }
    }
    if (selected.has(node.path)) selected.delete(node.path);
    else selected.add(node.path);
    selectAnchor = node.path;
    showSelection();
  }

  /** Everything directly in a folder that can go on a board, opened so it shows. */
  function selectFolder(node: LibraryNode): void {
    const inside = (node.children ?? []).filter((c) => c.kind === "file" && c.randomizer && !isBoard(c.randomizer));
    if (inside.length === 0) {
      state.toast(`Nothing in “${node.name}” can go on a board.`);
      return;
    }
    for (const c of inside) selected.add(c.path);
    selectAnchor = inside[inside.length - 1].path;
    if (!state.prefs.expandedFolders.includes(node.path)) {
      void state.savePrefs({ expandedFolders: [...state.prefs.expandedFolders, node.path] });
    }
    render();
  }

  function clearSelection(): void {
    selected.clear();
    selectAnchor = null;
    showSelection();
  }

  /** Mark the rows and say what a selection is for, without redrawing the tree. */
  function showSelection(): void {
    for (const row of tree.querySelectorAll<HTMLElement>(".tree-row[data-path]")) {
      const on = selected.has(row.dataset.path!);
      row.classList.toggle("selected", on);
      if (on) row.setAttribute("aria-description", "selected");
      else row.removeAttribute("aria-description");
    }
    const count = selected.size;
    selectionBar.hidden = count === 0;
    if (count === 0) {
      setChildren(selectionBar);
      return;
    }
    const exporter: HTMLButtonElement = button("Export…", () => void exportLibraryFile({
      paths: selection(),
      defaultName: "My library",
      opener: exporter,
    }), { class: "ghost export-selection", title: "Export the selection as a text file" });
    setChildren(selectionBar,
      h("span", { class: "grow", text: `${count} selected — drag ${count === 1 ? "it" : "them"} onto a board in edit mode.` }),
      exporter,
      button("Clear", () => clearSelection(), { class: "ghost clear-selection" }),
    );
  }

  const storageBadge = h("button", { class: "storage-badge", type: "button", "aria-label": "Where the library is stored" });
  function renderStorage(): void {
    const kind = state.library.backend.kind;
    storageBadge.textContent = state.library.backend.label;
    storageBadge.className = `storage-badge ${kind}`;
    storageBadge.title = describeStorage(kind);
  }
  storageBadge.addEventListener("click", (e) => openStorageMenu(e.currentTarget as HTMLElement));

  async function renderBanner(): Promise<void> {
    setChildren(banner);
    if (state.library.backend.kind === "memory") {
      banner.appendChild(h("div", { class: "notice danger", role: "alert" },
        h("strong", { text: "Nothing is being saved. " }),
        "This browser gave Orangey no storage, so the library will be gone when the page closes. Try the published copy, or another browser.",
      ));
    }
    if (state.folderNeedsPermission) {
      const name = (await rememberedFolderName()) ?? "your folder";
      banner.appendChild(h("div", { class: "notice", role: "status" },
        `Your library folder “${name}” needs permission again. `,
        button("Reconnect", async () => {
          const backend = await regrantFolder();
          if (!backend) {
            state.toast("The browser did not allow it.");
            return;
          }
          state.setLibrary(new LibraryService(backend));
          await state.library.refresh();
          state.folderNeedsPermission = false;
          state.emit();
          render();
        }, { class: "primary" }),
      ));
    }
  }

  function openStorageMenu(anchor: HTMLElement): void {
    const items: MenuItem[] = [
      { label: "Export library as ZIP", onSelect: () => void exportLibraryZip() },
      // Readable text, for pasting into a post: no pictures, links kept.
      {
        label: "Export library as a text file…",
        onSelect: () => void exportLibraryFile({
          paths: state.library.files().map((n) => n.path),
          folders: state.library.folders().map((f) => f.path),
          defaultName: "My library",
          opener: anchor,
        }),
      },
    ];
    if (canUseFolder()) {
      items.push({ label: "Use a folder on this computer…", onSelect: () => void openFolder() });
      if (state.library.backend.kind === "fsa") {
        items.push({ label: "Stop using that folder", onSelect: () => void stopUsingFolder() });
      }
    }
    items.push({ label: "About storage", onSelect: () => navigate("#/settings") });
    openMenu(anchor, items, "Library storage");
  }

  async function openFolder(): Promise<void> {
    if (await useFolder()) render();
  }

  function render(): void {
    renderStorage();
    void renderBanner();
    const query = searchInput.value.trim();
    if (query) {
      const hits = state.library.search(query);
      setChildren(results,
        h("p", { class: "faint", text: `${hits.length} match${hits.length === 1 ? "" : "es"}` }),
        h("ul", { class: "tree" },
          ...hits.map((hit) =>
            h("li", {},
              h("button", { class: "tree-row search-hit", onclick: () => navigate(`#/r/${encodeURIComponent(hit.node.path)}`) },
                h("span", { class: "glyph", text: glyphFor(hit.node) }),
                h("span", { class: "name", text: hit.node.randomizer?.name ?? hit.node.name }),
                h("span", { class: "why", text: hit.reason === "name" ? "" : `${hit.reason}: ${hit.detail}` }),
              ),
            ),
          ),
        ),
      );
      tree.style.display = "none";
      return;
    }
    tree.style.display = "";
    setChildren(results);
    for (const path of [...selected]) {
      if (state.library.find(path)?.kind !== "file") selected.delete(path);
    }
    setChildren(tree, renderFolder(state.library.tree, 0));
    showSelection();
  }

  function dropTargets(el: HTMLElement, folderPath: string): void {
    el.addEventListener("dragover", (e) => {
      if (!dragging || dragging === folderPath || folderPath.startsWith(`${dragging}/`)) return;
      e.preventDefault();
      (e as DragEvent).dataTransfer!.dropEffect = "move";
      el.classList.add("drop-target");
    });
    el.addEventListener("dragleave", () => el.classList.remove("drop-target"));
    el.addEventListener("drop", async (e) => {
      e.preventDefault();
      el.classList.remove("drop-target");
      const source = dragging;
      dragging = null;
      if (source && draggingMany) {
        state.toast("A selection goes onto a board. Move files into a folder one at a time.");
        return;
      }
      if (!source || parent(source) === folderPath) return;
      const name = state.library.find(source)?.randomizer?.name ?? basename(source);
      await state.library.move(source, folderPath);
      state.toast(`Moved “${name}” to ${folderPath || "the top level"}`);
      render();
    });
  }

  function draggable(el: HTMLElement, path: string): void {
    el.draggable = true;
    el.addEventListener("dragstart", (e) => {
      dragging = path;
      const data = (e as DragEvent).dataTransfer;
      data?.setData("text/plain", path);
      // A selected row carries the whole selection with it; any other row is
      // dragged on its own and leaves the selection as it was.
      draggingMany = selected.has(path) && selected.size > 1;
      if (draggingMany) data?.setData(LIBRARY_PATHS_TYPE, JSON.stringify(selection()));
      el.classList.add("dragging");
    });
    el.addEventListener("dragend", () => {
      dragging = null;
      draggingMany = false;
      el.classList.remove("dragging");
    });
  }

  function renderFolder(node: LibraryNode, depth: number): HTMLElement {
    const expanded = depth === 0 || state.prefs.expandedFolders.includes(node.path);
    const children = node.children ?? [];

    const row = h("button", {
      class: "tree-row folder-row",
      type: "button",
      "aria-expanded": String(expanded),
      "aria-current": selectedFolder === node.path ? "true" : "false",
      onclick: () => {
        selectedFolder = node.path;
        const list = state.prefs.expandedFolders;
        void state.savePrefs({ expandedFolders: expanded ? list.filter((p) => p !== node.path) : [...list, node.path] });
        render();
      },
      oncontextmenu: (e: Event) => { e.preventDefault(); openFolderMenu(node, e.currentTarget as HTMLElement); },
    },
      h("span", { class: "glyph", text: expanded ? "▾" : "▸" }),
      h("span", { class: "glyph", text: "📁" }),
      h("span", { class: "name", text: node.name }),
      node.pack?.installed
        ? h("span", { class: "pack-badge", title: `${node.pack.title} by ${node.pack.author}`, text: `pack ${node.pack.version}` })
        : null,
      h("span", { class: "count", text: String(children.length) }),
    );
    // Nothing is dropped into an installed pack, and nothing inside one is dragged out.
    if (!state.library.isLocked(node.path)) dropTargets(row, node.path);
    if (depth > 0 && (!state.library.isLocked(node.path) || node.pack?.installed)) draggable(row, node.path);

    const list = h("ul", { class: "tree" },
      ...children.map((child) => h("li", {}, child.kind === "folder" ? renderFolder(child, depth + 1) : renderFile(child))),
    );
    if (!expanded) list.style.display = "none";

    if (depth === 0) {
      // The root accepts drops too, so a file can be moved back out of a folder.
      dropTargets(tree, "");
      return h("div", {}, list);
    }
    const more = iconButton(`More for ${node.name}`, "⋯", () => openFolderMenu(node, more));
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openFolderMenu(node, row);
    });
    return h("div", {}, h("div", { class: "tree-file" }, row, more), list);
  }

  function renderFile(node: LibraryNode): HTMLElement {
    const name = node.randomizer?.name ?? basename(node.path);
    const favourite = node.randomizer ? state.prefs.favourites.includes(node.randomizer.id) : false;
    const row = h("button", {
      class: `tree-row${selected.has(node.path) ? " selected" : ""}`,
      type: "button",
      "data-path": node.path,
      onclick: (e: Event) => {
        const m = e as MouseEvent;
        if (m.ctrlKey || m.metaKey || m.shiftKey) {
          selectRow(node, m);
          return;
        }
        // A plain click opens, and ends any selection.
        if (selected.size) clearSelection();
        navigate(`#/r/${encodeURIComponent(node.path)}`);
      },
      // Shift-click would otherwise select the panel's text.
      onmousedown: (e: Event) => { if ((e as MouseEvent).shiftKey) e.preventDefault(); },
      oncontextmenu: (e: Event) => { e.preventDefault(); openFileMenu(node, e.currentTarget as HTMLElement); },
      onkeydown: (e: Event) => {
        const key = (e as KeyboardEvent).key;
        if (key === "Delete") { e.preventDefault(); void confirmDelete(node, e.currentTarget as HTMLElement); }
        else if (key === "F2") { e.preventDefault(); void renameNode(node, e.currentTarget as HTMLElement); }
      },
    },
      h("span", { class: "glyph", text: glyphFor(node) }),
      h("span", { class: "name", text: name }),
      node.error ? h("span", { class: "why", text: "unreadable" }) : null,
      favourite ? h("span", { class: "count", text: "★" }) : null,
    );
    if (!state.library.isLocked(node.path)) draggable(row, node.path);
    const more = iconButton(`More for ${name}`, "⋯", () => openFileMenu(node, more));
    // Right-click opens the same menu as the ⋯: it is where people reach for
    // "copy the link to this".
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openFileMenu(node, row);
    });
    return h("div", { class: "tree-file" }, row, more);
  }

  /**
   * The link that opens this randomizer in this library, by id — so renaming
   * or moving it later does not break what you pasted.
   */
  async function copyLinkTo(randomizer: Randomizer): Promise<void> {
    const link = slideLink(appBase(), randomizer.id, { roll: false, present: false });
    try {
      await navigator.clipboard.writeText(link);
      state.toast(`Link to "${randomizer.name}" copied`);
    } catch {
      // Clipboard permission can be refused; show it so it can be copied by hand.
      state.toast(link);
    }
  }

  function openFileMenu(node: LibraryNode, anchor: HTMLElement): void {
    const isFavourite = node.randomizer ? state.prefs.favourites.includes(node.randomizer.id) : false;
    const inPack = state.library.packOf(node.path);
    if (inPack?.pack.installed) {
      // Part of an installed pack: look, roll, share; changing it means a copy.
      openMenu(anchor, [
        { label: "Play", onSelect: () => navigate(`#/r/${encodeURIComponent(node.path)}`) },
        { label: isFavourite ? "Remove from favourites" : "Add to favourites", onSelect: () => node.randomizer && state.toggleFavourite(node.randomizer.id) },
        ...(node.randomizer ? [{ label: "Copy link", onSelect: () => void copyLinkTo(node.randomizer!) }] : []),
        // No Export file: a pack is its author's to hand out, as the pack.
        { label: "About this pack", onSelect: () => aboutPack(inPack.folder, anchor), separator: true },
        { label: "Make an editable copy of the pack", onSelect: async () => { await editableCopy(inPack.folder.path); render(); } },
      ], node.randomizer?.name ?? node.name);
      return;
    }
    openMenu(anchor, [
      { label: "Play", onSelect: () => navigate(`#/r/${encodeURIComponent(node.path)}`) },
      { label: "Edit", onSelect: () => navigate(`#/edit/${encodeURIComponent(node.path)}`) },
      { label: isFavourite ? "Remove from favourites" : "Add to favourites", onSelect: () => node.randomizer && state.toggleFavourite(node.randomizer.id) },
      ...(node.randomizer
        ? [{ label: "Copy link", onSelect: () => void copyLinkTo(node.randomizer!) }]
        : []),
      { label: "Rename…", onSelect: () => void renameNode(node, anchor), separator: true },
      { label: "Move to folder…", onSelect: () => void moveNode(node, anchor) },
      { label: "Duplicate", onSelect: async () => { await state.library.duplicate(node.path); render(); } },
      { label: "Export file", onSelect: () => void exportFile(node) },
      ...(node.randomizer?.type === "list"
        ? [{
            label: "Export as CSV",
            onSelect: () => {
              const r = node.randomizer as ListRandomizer;
              download(`${slugify(r.name)}.csv`, `${listCsv(r.items)}\n`, "text/csv");
            },
          }]
        : []),
      ...(node.randomizer && isBoard(node.randomizer)
        ? [{ label: "Export board with its randomizers", onSelect: () => void exportBoardZip(node.randomizer as BoardRandomizer) }]
        : []),
      { label: "Delete…", onSelect: () => void confirmDelete(node, anchor), danger: true, separator: true },
    ], node.randomizer?.name ?? node.name);
  }

  function openFolderMenu(node: LibraryNode, anchor: HTMLElement): void {
    const inPack = state.library.packOf(node.path);
    if (inPack?.pack.installed) {
      const root = inPack.folder.path === node.path;
      openMenu(anchor, [
        { label: "Select all in this folder", onSelect: () => selectFolder(node) },
        { label: "About this pack", onSelect: () => aboutPack(inPack.folder, anchor), separator: true },
        { label: "Make an editable copy", onSelect: async () => { await editableCopy(inPack.folder.path); render(); } },
        ...(root
          ? [
              { label: "Rename…", onSelect: () => void renameNode(node, anchor), separator: true },
              { label: "Move to folder…", onSelect: () => void moveNode(node, anchor) },
              { label: "Uninstall pack…", onSelect: () => void confirmDelete(node, anchor), danger: true, separator: true },
            ]
          : []),
      ], node.name);
      return;
    }
    openMenu(anchor, [
      { label: "Select all in this folder", onSelect: () => selectFolder(node) },
      { label: "New wheel here", onSelect: () => void newRandomizer("list", node.path), separator: true },
      { label: "New folder here", onSelect: () => void newFolder(node.path) },
      { label: "Rename…", onSelect: () => void renameNode(node, anchor), separator: true },
      { label: "Move to folder…", onSelect: () => void moveNode(node, anchor) },
      {
        label: "Export folder as a text file…",
        onSelect: () => void exportLibraryFile({
          paths: state.library.files(node).map((n) => n.path),
          // The folder arrives as itself, not inside the folders above it.
          base: parent(node.path),
          folders: state.library.folders().filter((f) => f.path === node.path || f.path.startsWith(`${node.path}/`))
            .map((f) => (parent(node.path) ? f.path.slice(parent(node.path).length + 1) : f.path)),
          defaultName: node.name,
          opener: anchor,
        }),
      },
      {
        label: node.pack ? `Publish the next version (after ${node.pack.version})…` : "Publish as a pack…",
        onSelect: () => publishPack(node, anchor),
      },
      { label: "Delete folder…", onSelect: () => void confirmDelete(node, anchor), danger: true, separator: true },
    ], node.name);
  }

  async function renameNode(node: LibraryNode, opener: HTMLElement): Promise<void> {
    const current = node.randomizer?.name ?? node.name;
    const next = await askText(`Rename “${current}”`, { value: current, confirm: "Rename", opener });
    if (!next || next === current) return;
    await state.library.rename(node.path, next);
    render();
  }

  async function moveNode(node: LibraryNode, opener: HTMLElement): Promise<void> {
    const folders = state.library.folderList().filter((f) => f.path !== node.path && !f.path.startsWith(`${node.path}/`) && !state.library.isLocked(f.path));
    const target = await askFolder(`Move “${node.randomizer?.name ?? node.name}” to`, folders, parent(node.path), opener);
    if (target === null) return;
    await state.library.move(node.path, target);
    render();
  }

  async function confirmDelete(node: LibraryNode, opener: HTMLElement): Promise<void> {
    const name = node.randomizer?.name ?? node.name;
    const inside = node.kind === "folder" ? state.library.files(node).length : 0;
    const ok = await askConfirm(`Delete “${name}”?`,
      node.kind === "folder"
        ? `The folder${inside ? ` and the ${inside} randomizer${inside === 1 ? "" : "s"} in it` : ""} will be deleted. This cannot be undone.`
        : "You can undo this straight afterwards.",
      { confirm: "Delete", danger: true, opener });
    if (!ok) return;

    // Read before it goes, so Undo restores it exactly (same path, same id) and every
    // board entry and "goes to" pointing at it works again. Its pictures are safe:
    // they are pruned only when an editor closes.
    const backup = node.kind === "file" ? await state.library.backend.read(node.path).catch(() => null) : null;
    await state.library.remove(node.path);
    render();
    if (backup === null) {
      state.toast(`Deleted “${name}”`);
      return;
    }
    state.toast(`Deleted “${name}”`, "Undo", () => {
      void (async () => {
        await state.library.backend.write(node.path, backup);
        await state.library.refresh();
        render();
      })();
    });
  }

  async function exportFile(node: LibraryNode): Promise<void> {
    if (!node.randomizer) return;
    // Pictures are inlined on the way out: a file handed to someone has to
    // carry them, since the store they live in is this library.
    download(basename(node.path), serialize(wrap(await portableRandomizer(node.randomizer))), "application/json");
  }

  /**
   * Say why a create failed: otherwise the name dialog closes and nothing appears,
   * which (on an iPad whose storage refuses writes, say) looks like a dead button.
   */
  function couldNotSave(error: unknown): null {
    state.toast(`Could not save to this browser's storage: ${(error as Error).message}`);
    return null;
  }

  async function newRandomizer(type: RandomizerType, folder = selectedFolder): Promise<void> {
    const titles: Record<RandomizerType, string> = { list: "New wheel", dice: "New dice", coin: "New coin", number: "New number", inkblot: "Inkblot", board: "New board" };
    const name = await askText(titles[type], { label: "Name", value: titles[type], confirm: "Create", opener: newButton });
    if (!name) return;
    const path = await state.library.create(folder, emptyRandomizer(type, name)).catch(couldNotSave);
    if (!path) return;
    render();
    // A board is built on the board itself, and an inkblot has nothing to
    // edit: both open where they are played.
    navigate(type === "board" || type === "inkblot" ? `#/r/${encodeURIComponent(path)}` : `#/edit/${encodeURIComponent(path)}`);
  }

  async function newFolder(folder = selectedFolder): Promise<void> {
    const name = await askText("New folder", { label: "Name", value: "New folder", confirm: "Create", opener: newButton });
    if (!name) return;
    const path = await state.library.createFolder(folder, name).catch(couldNotSave);
    if (!path) return;
    if (!state.prefs.expandedFolders.includes(folder)) void state.savePrefs({ expandedFolders: [...state.prefs.expandedFolders, folder] });
    selectedFolder = path;
    render();
  }

  const newButton = button("+ New", () =>
    openMenu(newButton, [
      { label: "Wheel", onSelect: () => void newRandomizer("list") },
      { label: "Dice", onSelect: () => void newRandomizer("dice") },
      { label: "Coin", onSelect: () => void newRandomizer("coin") },
      { label: "Number", onSelect: () => void newRandomizer("number") },
      { label: "Inkblot", onSelect: () => void newRandomizer("inkblot") },
      { label: "Board", onSelect: () => void newRandomizer("board"), separator: true },
      { label: "Folder", onSelect: () => void newFolder() },
    ], "New"), { class: "primary new-button", "aria-haspopup": "menu", "aria-expanded": "false" });

  const el = h("div", { class: "library" },
    h("div", { class: "row tight library-head" },
      h("h2", { class: "library-title", text: "Library" }),
      h("div", { class: "spacer" }),
      storageBadge,
    ),
    banner,
    searchInput,
    selectionBar,
    tree,
    results,
    h("div", { class: "row tight library-foot" },
      newButton,
      button("Import…", () => navigate("#/import"), { class: "import-button" }),
    ),
  );

  searchInput.addEventListener("input", render);
  // Escape lets a selection go, when the keyboard is in the library.
  el.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key !== "Escape" || selected.size === 0) return;
    e.stopPropagation();
    clearSelection();
  });
  const unsubscribe = state.subscribe(render, ["library", "prefs"]);
  render();

  return { el, destroy: () => unsubscribe() };
}

function glyphFor(node: LibraryNode): string {
  switch (node.randomizer?.type) {
    case "list": return node.randomizer.view === "wheel" ? "🎡" : "☰";
    case "dice": return "🎲";
    case "coin": return "🪙";
    case "number": return "#";
    case "inkblot": return "🦋";
    case "board": return "▦";
    default: return "•";
  }
}

