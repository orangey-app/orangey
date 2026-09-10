/**
 * The library: the folder tree, search, and everything you can do to a
 * randomizer that is not editing its contents.
 *
 * The tree is the library (decision D11) — there is no index file to fall out
 * of step with it — so every operation here is a plain file operation.
 *
 * Emphasis, top to bottom: the search box, the tree, and one primary action
 * (+ New). Storage, export and folder connection are secondary and live in
 * the header menu; import has a single entry point, the wizard.
 */

import { serialize, wrap } from "../../model/file.ts";
import { emptyRandomizer, type RandomizerType } from "../../model/randomizer.ts";
import type { LibraryNode } from "../../storage/library.ts";
import { basename, parent } from "../../storage/paths.ts";
import { canPickFolder, forgetFolder, pickFolder, regrantFolder, rememberedFolderName } from "../../storage/fsdir.ts";
import { createZip } from "../../storage/zip.ts";
import { LibraryService } from "../../storage/library.ts";
import { askConfirm, askFolder, askText, button, h, iconButton, openMenu, setChildren } from "../dom.ts";
import { state } from "../state.ts";
import { navigate } from "../router.ts";
import type { View } from "./editor.ts";

export function createLibraryView(): View {
  const tree = h("div", { class: "tree-holder" });
  const searchInput = h("input", { type: "search", placeholder: "Search", "aria-label": "Search the library" });
  const results = h("div");
  const banner = h("div");
  let selectedFolder = "";
  let dragging: string | null = null;

  /* ---- storage ---------------------------------------------------------- */

  const storageBadge = h("button", { class: "storage-badge", type: "button", "aria-label": "Where the library is stored" });
  function renderStorage(): void {
    const kind = state.library.backend.kind;
    storageBadge.textContent = state.library.backend.label;
    storageBadge.className = `storage-badge ${kind}`;
    storageBadge.title =
      kind === "memory"
        ? "Nothing is being saved. This browser gave Orangey no storage."
        : kind === "fsa"
          ? "A folder on this computer. Files there are the library."
          : "Kept by this browser, on this device.";
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
          state.library = new LibraryService(backend);
          await state.library.refresh();
          state.folderNeedsPermission = false;
          state.emit();
          render();
        }, { class: "primary" }),
      ));
    }
  }

  function openStorageMenu(anchor: HTMLElement): void {
    const items = [
      { label: "Export library as ZIP", onSelect: () => void exportLibrary() },
    ];
    if (canPickFolder()) {
      items.push({ label: "Use a folder on this computer…", onSelect: () => void openFolder() });
      if (state.library.backend.kind === "fsa") {
        items.push({ label: "Stop using that folder", onSelect: () => void stopUsingFolder() });
      }
    }
    items.push({ label: "About storage", onSelect: () => navigate("#/settings") });
    openMenu(anchor, items, "Library storage");
  }

  async function openFolder(): Promise<void> {
    const backend = await pickFolder().catch(() => null);
    if (!backend) return;
    const previous = state.library;
    const next = new LibraryService(backend);
    await next.refresh();
    if (next.files().length === 0 && previous.files().length > 0) {
      const copy = await askConfirm("Copy your library into this folder?",
        `The folder is empty. Copy the ${previous.files().length} randomizers you have now into it?`, { confirm: "Copy" });
      if (copy) {
        for (const file of previous.files()) {
          if (!file.randomizer) continue;
          const folder = parent(file.path);
          if (folder) await backend.mkdir(folder);
          await backend.write(file.path, serialize(wrap(file.randomizer)));
        }
        await next.refresh();
      }
    }
    state.library = next;
    state.folderNeedsPermission = false;
    void state.savePrefs({ backend: "fsa" });
    state.toast(`Library is now the folder “${backend.label}”`);
    render();
  }

  async function stopUsingFolder(): Promise<void> {
    await forgetFolder();
    state.toast("Reload to go back to browser storage.");
  }

  async function exportLibrary(): Promise<void> {
    const entries = state.library.files()
      .filter((f) => f.randomizer)
      .map((f) => ({ path: f.path, text: serialize(wrap(f.randomizer!)) }));
    const zip = await createZip(entries);
    downloadBytes("orangey-library.zip", zip);
    state.toast(`Exported ${entries.length} randomizer${entries.length === 1 ? "" : "s"}`);
  }

  /* ---- tree ------------------------------------------------------------- */

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
    setChildren(tree, renderFolder(state.library.tree, 0));
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
      (e as DragEvent).dataTransfer?.setData("text/plain", path);
      el.classList.add("dragging");
    });
    el.addEventListener("dragend", () => {
      dragging = null;
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
      h("span", { class: "count", text: String(children.length) }),
    );
    dropTargets(row, node.path);
    if (depth > 0) draggable(row, node.path);

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
    return h("div", {}, h("div", { class: "tree-file" }, row, more), list);
  }

  function renderFile(node: LibraryNode): HTMLElement {
    const name = node.randomizer?.name ?? basename(node.path);
    const favourite = node.randomizer ? state.prefs.favourites.includes(node.randomizer.id) : false;
    const row = h("button", {
      class: "tree-row",
      type: "button",
      onclick: () => navigate(`#/r/${encodeURIComponent(node.path)}`),
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
    draggable(row, node.path);
    const more = iconButton(`More for ${name}`, "⋯", () => openFileMenu(node, more));
    return h("div", { class: "tree-file" }, row, more);
  }

  function openFileMenu(node: LibraryNode, anchor: HTMLElement): void {
    const isFavourite = node.randomizer ? state.prefs.favourites.includes(node.randomizer.id) : false;
    openMenu(anchor, [
      { label: "Play", onSelect: () => navigate(`#/r/${encodeURIComponent(node.path)}`) },
      { label: "Edit", onSelect: () => navigate(`#/edit/${encodeURIComponent(node.path)}`) },
      { label: isFavourite ? "Remove from favourites" : "Add to favourites", onSelect: () => node.randomizer && state.toggleFavourite(node.randomizer.id) },
      { label: "Rename…", onSelect: () => void renameNode(node, anchor), separator: true },
      { label: "Move to folder…", onSelect: () => void moveNode(node, anchor) },
      { label: "Duplicate", onSelect: async () => { await state.library.duplicate(node.path); render(); } },
      { label: "Export file", onSelect: () => exportFile(node) },
      { label: "Delete…", onSelect: () => void confirmDelete(node, anchor), danger: true, separator: true },
    ], node.randomizer?.name ?? node.name);
  }

  function openFolderMenu(node: LibraryNode, anchor: HTMLElement): void {
    openMenu(anchor, [
      { label: "New wheel here", onSelect: () => void newRandomizer("list", node.path) },
      { label: "New folder here", onSelect: () => void newFolder(node.path) },
      { label: "Rename…", onSelect: () => void renameNode(node, anchor), separator: true },
      { label: "Move to folder…", onSelect: () => void moveNode(node, anchor) },
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
    const folders = state.library.folderList().filter((f) => f.path !== node.path && !f.path.startsWith(`${node.path}/`));
    const target = await askFolder(`Move “${node.randomizer?.name ?? node.name}” to`, folders, parent(node.path), opener);
    if (target === null) return;
    await state.library.move(node.path, target);
    render();
  }

  async function confirmDelete(node: LibraryNode, opener: HTMLElement): Promise<void> {
    const name = node.randomizer?.name ?? node.name;
    const inside = node.kind === "folder" ? state.library.files(node).length : 0;
    const ok = await askConfirm(`Delete “${name}”?`,
      node.kind === "folder" && inside ? `The folder and the ${inside} randomizer${inside === 1 ? "" : "s"} in it will be deleted. This cannot be undone.` : "This cannot be undone.",
      { confirm: "Delete", danger: true, opener });
    if (!ok) return;
    await state.library.remove(node.path);
    state.toast(`Deleted “${name}”`);
    render();
  }

  function exportFile(node: LibraryNode): void {
    if (!node.randomizer) return;
    download(basename(node.path), serialize(wrap(node.randomizer)), "application/json");
  }

  async function newRandomizer(type: RandomizerType, folder = selectedFolder): Promise<void> {
    const titles: Record<RandomizerType, string> = { list: "New wheel", dice: "New dice", coin: "New coin", number: "New number" };
    const name = await askText(titles[type], { label: "Name", value: titles[type], confirm: "Create", opener: newButton });
    if (!name) return;
    const path = await state.library.create(folder, emptyRandomizer(type, name));
    render();
    navigate(`#/edit/${encodeURIComponent(path)}`);
  }

  async function newFolder(folder = selectedFolder): Promise<void> {
    const name = await askText("New folder", { label: "Name", value: "New folder", confirm: "Create", opener: newButton });
    if (!name) return;
    const path = await state.library.createFolder(folder, name);
    if (!state.prefs.expandedFolders.includes(folder)) void state.savePrefs({ expandedFolders: [...state.prefs.expandedFolders, folder] });
    selectedFolder = path;
    render();
  }

  /* ---- layout ----------------------------------------------------------- */

  const newButton = button("+ New", () =>
    openMenu(newButton, [
      { label: "Wheel", onSelect: () => void newRandomizer("list") },
      { label: "Dice", onSelect: () => void newRandomizer("dice") },
      { label: "Coin", onSelect: () => void newRandomizer("coin") },
      { label: "Number", onSelect: () => void newRandomizer("number") },
      { label: "Folder", onSelect: () => void newFolder(), separator: true },
    ], "New"), { class: "primary new-button", "aria-haspopup": "menu", "aria-expanded": "false" });

  const el = h("div", { class: "library" },
    h("div", { class: "row tight library-head" },
      h("h2", { class: "library-title", text: "Library" }),
      h("div", { class: "spacer" }),
      storageBadge,
    ),
    banner,
    searchInput,
    tree,
    results,
    h("div", { class: "row tight library-foot" },
      newButton,
      button("Import…", () => navigate("#/import"), { class: "import-button" }),
    ),
  );

  searchInput.addEventListener("input", render);
  const unsubscribe = state.subscribe(render);
  render();

  return { el, destroy: () => unsubscribe() };
}

function glyphFor(node: LibraryNode): string {
  switch (node.randomizer?.type) {
    case "list": return node.randomizer.view === "wheel" ? "🎡" : "☰";
    case "dice": return "🎲";
    case "coin": return "🪙";
    case "number": return "#";
    default: return "•";
  }
}

export function download(name: string, text: string, type: string): void {
  downloadBytes(name, new TextEncoder().encode(text), type);
}

export function downloadBytes(name: string, bytes: Uint8Array, type = "application/zip"): void {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
