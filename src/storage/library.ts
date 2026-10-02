/**
 * The library: a folder tree of .orangey.json files.
 *
 * There is no index file: the folder tree is the library, so a library kept in
 * Dropbox or Git cannot conflict with an index. Per-device extras (favourites,
 * recents) live in the app database, not in the user's files.
 */

import { FILE_SUFFIX, fileNameFor, parseFile, serialize, wrap, type OrangeyFile } from "../model/file.ts";
import { newId, type Randomizer } from "../model/randomizer.ts";
import { ValidationError } from "../model/validate.ts";
import { basename, join, naturalCompare, parent, sanitizeName, segments } from "./paths.ts";
import { relink, safeFilePath, type ReadLibraryFile } from "./libraryfile.ts";
import { fillRefIds, renameRefs, refIdsOf, resolverFor, type RefResolver } from "../model/refs.ts";
import { PACK_FILE, parseManifestFile, publicManifest, serializeManifest, type InstalledPack, type PackManifest } from "../model/pack.ts";

export interface Entry {
  name: string;
  kind: "folder" | "file";
}

/**
 * Where the image store keeps its files, at the top of the library. Defined
 * here because the tree builder must skip it, and importing `images.ts` would
 * make an import cycle, which the bundler forbids.
 */
export const IMAGE_DIR = "images";

export interface LibraryBackend {
  readonly kind: "memory" | "opfs" | "idb" | "fsa" | "tauri";
  /** Human-readable location, shown in the UI ("Browser storage", a folder name). */
  readonly label: string;
  readonly writable: boolean;
  list(path: string): Promise<Entry[]>;
  read(path: string): Promise<string>;
  write(path: string, contents: string): Promise<void>;
  /**
   * The same two for bytes. Pictures go through these, so a folder library holds
   * real image files a person can open and replace.
   */
  readBytes(path: string): Promise<Uint8Array>;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  mkdir(path: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface LibraryNode {
  kind: "folder" | "file";
  path: string;
  name: string;
  children?: LibraryNode[];
  /** For files: the parsed randomizer, or null when the file could not be read. */
  randomizer?: Randomizer | null;
  readOnly?: boolean;
  error?: string;
  /**
   * Top-level keys this version does not know (another tool's, or a newer
   * format's). They are written back on the next save, so a file never comes
   * back smaller than it went in.
   */
  extras?: Record<string, unknown>;
  /** For folders: the pack this folder is (its `orangey-pack.json`), installed or the author's own. */
  pack?: InstalledPack;
  /** For folders: why its `orangey-pack.json` could not be read. */
  packError?: string;
}

/** Refused because the place is inside an installed pack. */
export class LockedError extends Error {
  readonly pack: PackManifest;
  constructor(pack: PackManifest) {
    super(`This is part of the pack “${pack.title}”, which an update would replace: make an editable copy to change it.`);
    this.name = "LockedError";
    this.pack = pack;
  }
}

export interface SearchHit {
  node: LibraryNode;
  /** Why it matched: the randomizer's name, a tag, or one of its outcomes. */
  reason: "name" | "tag" | "outcome" | "description";
  detail: string;
}

const isRandomizerFile = (name: string) => name.toLowerCase().endsWith(FILE_SUFFIX);

export class LibraryService {
  backend: LibraryBackend;
  #tree: LibraryNode | null = null;
  /**
   * Every node by path and by randomizer id. `find` and `findById` run in render
   * loops, so these are rebuilt when the tree changes rather than walking it.
   */
  #byPath = new Map<string, LibraryNode>();
  #byId = new Map<string, LibraryNode>();
  #byName = new Map<string, Randomizer[]>();
  /** Randomizers renamed in the editor since the last flush: references to them get the new name then. */
  #renamed = new Map<string, string>();
  #pending = new Map<string, string>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #writeDelayMs: number;
  #listeners = new Set<() => void>();
  #errorListeners = new Set<(error: unknown) => void>();
  /** Resolves when every debounced write has hit the backend. */
  #flushing: Promise<void> = Promise.resolve();

  constructor(backend: LibraryBackend, writeDelayMs = 400) {
    this.backend = backend;
    this.#writeDelayMs = writeDelayMs;
  }

  /**
   * Told when the shape of the library changes (create, rename, move, delete, or
   * a full re-read), not when a randomizer's contents change: `save()` runs on
   * every keystroke, and a redrawn tree would lose the row being typed in.
   */
  onChange(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /**
   * Told when a flush could not write. This is the failure signal the UI acts
   * on: the change stays queued, so the app must say so rather than let a
   * person keep typing into a file that is no longer being saved.
   */
  onError(fn: (error: unknown) => void): () => void {
    this.#errorListeners.add(fn);
    return () => this.#errorListeners.delete(fn);
  }

  #emit(): void {
    for (const fn of this.#listeners) fn();
  }

  get tree(): LibraryNode {
    return this.#tree ?? { kind: "folder", path: "", name: "Library", children: [] };
  }

  async refresh(): Promise<LibraryNode> {
    this.#tree = await this.#readFolder("", "Library");
    this.#reindex();
    this.#emit();
    return this.#tree;
  }

  /** Rebuild the lookups from the tree. Depth first, so the first id wins. */
  #reindex(): void {
    this.#byPath = new Map();
    this.#byId = new Map();
    this.#byName = new Map();
    const walk = (node: LibraryNode): void => {
      this.#byPath.set(node.path, node);
      const id = node.randomizer?.id;
      if (id && !this.#byId.has(id)) this.#byId.set(id, node);
      if (node.randomizer) {
        const key = node.randomizer.name.trim().toLowerCase();
        this.#byName.set(key, [...(this.#byName.get(key) ?? []), node.randomizer]);
      }
      for (const child of node.children ?? []) walk(child);
    };
    if (this.#tree) walk(this.#tree);
  }

  /** The order `#readFolder` produces: folders by name, then files by title. */
  #sortChildren(folder: LibraryNode): void {
    const children = folder.children ?? [];
    const folders = children.filter((c) => c.kind === "folder").sort((a, b) => naturalCompare(a.name, b.name));
    const files = children.filter((c) => c.kind === "file").sort((a, b) => naturalCompare(this.#title(a), this.#title(b)));
    folder.children = [...folders, ...files];
  }

  /**
   * Put a node in its folder. False when the tree is not loaded or the folder is
   * not in it; the caller then does a full `refresh()`.
   */
  #attach(parentPath: string, node: LibraryNode): boolean {
    const parent_ = this.#byPath.get(parentPath);
    if (!parent_ || parent_.kind !== "folder") return false;
    parent_.children = [...(parent_.children ?? []), node];
    this.#sortChildren(parent_);
    this.#reindex();
    this.#emit();
    return true;
  }

  /** Take a node out of the tree. False when it was not there to take. */
  #detach(path: string): boolean {
    const node = this.#byPath.get(path);
    if (!node || node === this.#tree) return false;
    const parent_ = this.#byPath.get(parent(path));
    if (!parent_?.children) return false;
    parent_.children = parent_.children.filter((c) => c !== node);
    return true;
  }

  async #readFolder(path: string, name: string): Promise<LibraryNode> {
    const entries = await this.backend.list(path);
    // The image store's folder at the top is the app's, never one you can open,
    // move or save into. A folder of pictures anywhere else is the user's.
    const wanted = entries.filter(
      (e) => !(path === "" && e.kind === "folder" && e.name === IMAGE_DIR) && (e.kind === "folder" || isRandomizerFile(e.name)),
    );
    // In parallel: one backend round trip per file, in turn, is slow for a large
    // library.
    const children = await Promise.all(
      wanted.map((e) =>
        e.kind === "folder" ? this.#readFolder(join(path, e.name), e.name) : this.#readFile(join(path, e.name), e.name),
      ),
    );
    const folders = children.filter((c) => c.kind === "folder");
    const files = children.filter((c) => c.kind === "file");
    folders.sort((a, b) => naturalCompare(a.name, b.name));
    files.sort((a, b) => naturalCompare(this.#title(a), this.#title(b)));
    const node: LibraryNode = { kind: "folder", path, name, children: [...folders, ...files] };
    // A pack's details sit beside its randomizers; not at the top, which is
    // the whole library rather than a pack in it.
    if (path !== "" && entries.some((e) => e.kind === "file" && e.name === PACK_FILE)) {
      try {
        node.pack = parseManifestFile(await this.backend.read(join(path, PACK_FILE)));
      } catch (e) {
        node.packError = e instanceof ValidationError ? e.issues.map((i) => `${i.path}: ${i.message}`).join("; ") : String(e);
      }
    }
    return node;
  }

  #title(node: LibraryNode): string {
    return node.randomizer?.name ?? node.name;
  }

  async #readFile(path: string, name: string): Promise<LibraryNode> {
    try {
      const text = await this.backend.read(path);
      const out = parseFile(text);
      return {
        kind: "file",
        path,
        name,
        randomizer: out.file.randomizer,
        readOnly: out.readOnly,
        ...(out.file.unknown ? { extras: out.file.unknown } : {}),
      };
    } catch (e) {
      const message = e instanceof ValidationError ? e.issues.map((i) => `${i.path}: ${i.message}`).join("; ") : String(e);
      return { kind: "file", path, name, randomizer: null, error: message };
    }
  }

  /** Every file in the tree, depth first. */
  files(node: LibraryNode = this.tree): LibraryNode[] {
    if (node.kind === "file") return [node];
    return (node.children ?? []).flatMap((c) => this.files(c));
  }

  folders(node: LibraryNode = this.tree): LibraryNode[] {
    if (node.kind === "file") return [];
    return [node, ...(node.children ?? []).flatMap((c) => this.folders(c))];
  }

  find(path: string): LibraryNode | null {
    if (!this.#tree) return path === "" ? this.tree : null;
    return this.#byPath.get(path) ?? null;
  }

  findById(id: string): LibraryNode | null {
    return this.#byId.get(id) ?? null;
  }

  /** For `{@references}` (model/refs.ts): the library's randomizers by id and by name. */
  readonly refs: RefResolver = {
    byId: (id) => this.#byId.get(id)?.randomizer ?? null,
    byName: (name) => this.#byName.get(name.trim().toLowerCase()) ?? [],
  };

  /** Search names, tags, descriptions and outcome labels. */
  search(query: string): SearchHit[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const hits: SearchHit[] = [];
    for (const node of this.files()) {
      const r = node.randomizer;
      if (!r) continue;
      if (r.name.toLowerCase().includes(q)) {
        hits.push({ node, reason: "name", detail: r.name });
        continue;
      }
      if (r.tags?.some((t) => t.toLowerCase().includes(q))) {
        hits.push({ node, reason: "tag", detail: r.tags.find((t) => t.toLowerCase().includes(q))! });
        continue;
      }
      if (r.type === "list") {
        const item = r.items.find((i) => i.label.toLowerCase().includes(q));
        if (item) {
          hits.push({ node, reason: "outcome", detail: item.label });
          continue;
        }
      }
      if (r.description?.toLowerCase().includes(q)) {
        hits.push({ node, reason: "description", detail: r.description });
      }
    }
    return hits;
  }

  // ---- packs ---------------------------------------------------------------

  /** The pack a path is in (or is), nearest first: its folder and details. */
  packOf(path: string): { folder: LibraryNode; pack: InstalledPack } | null {
    for (let p = path; ; p = parent(p)) {
      const node = this.find(p);
      if (node?.kind === "folder" && node.pack) return { folder: node, pack: node.pack };
      if (p === "") return null;
    }
  }

  /** The folder an installed pack with this id was installed into. */
  findPack(id: string): LibraryNode | null {
    return this.folders().find((f) => f.pack?.installed && f.pack.id === id) ?? null;
  }

  /** Every installed pack, with its folder. */
  installedPacks(): { folder: LibraryNode; pack: InstalledPack }[] {
    return this.folders().flatMap((f) => (f.pack?.installed ? [{ folder: f, pack: f.pack }] : []));
  }

  /** Inside an installed pack, so not to be changed by hand. The pack's own folder counts. */
  isLocked(path: string): boolean {
    return !!this.packOf(path)?.pack.installed;
  }

  /**
   * Throws a LockedError for a change inside an installed pack. The pack's
   * own folder may still be renamed, moved or deleted (`root`), which is how
   * a pack is put somewhere else or uninstalled.
   */
  #guard(path: string, root = false): void {
    const found = this.packOf(path);
    if (!found?.pack.installed) return;
    if (root && found.folder.path === path) return;
    throw new LockedError(found.pack);
  }

  /**
   * Remembers a folder's publishing details (the author's own folder: no
   * `installed`, so it stays editable). The folder keeps them for the next version.
   */
  async setPackDetails(folder: string, pack: PackManifest): Promise<void> {
    if (folder === "") throw new Error("the whole library cannot be a pack; choose a folder");
    this.#guard(folder);
    await this.backend.write(join(folder, PACK_FILE), serializeManifest(publicManifest(pack)));
    await this.refresh();
  }

  /**
   * Installs a pack into a new folder at the top, named after it ("Title",
   * "Title 2"…). Its randomizers keep their ids unless one is taken here; those
   * that cannot are remembered, so an update lands on the same ids.
   */
  async installPack(read: ReadLibraryFile, opts: { source?: string; now?: Date } = {}): Promise<{ folder: string; added: number }> {
    if (!read.pack) throw new Error("that file is not a pack");
    await this.flush();
    const base = sanitizeName(read.pack.title) || "Pack";
    const taken = new Set((await this.backend.list("")).map((e) => e.name.toLowerCase()));
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()) || name.toLowerCase() === IMAGE_DIR; n++) name = `${base} ${n}`;
    await this.backend.mkdir(name);
    const added = await this.#writePack(name, read, {}, opts);
    return { folder: name, added };
  }

  /**
   * Replaces an installed pack's randomizers with another version's. Ids the
   * pack had here are kept, so boards, "goes to" and Storyboard journals that
   * point at them still work; what the new version dropped goes.
   */
  async updatePack(folder: string, read: ReadLibraryFile, opts: { source?: string; now?: Date } = {}): Promise<{ added: number; removed: number; kept: number }> {
    const node = this.find(folder);
    if (!node?.pack?.installed || !read.pack) throw new Error("that folder is not an installed pack");
    if (node.pack.id !== read.pack.id) throw new Error("that file is a different pack");
    await this.flush();
    const before = new Map(this.files(node).flatMap((f) => (f.randomizer ? [[f.randomizer.id, f.path] as const] : [])));
    const oldIds = node.pack.ids ?? {};
    for (const child of node.children ?? []) await this.backend.remove(child.path);
    await this.#writePack(folder, read, oldIds, { source: opts.source ?? node.pack.source, now: opts.now });
    const local = (id: string) => oldIds[id] ?? id;
    const after = new Set(read.entries.map((e) => local(e.file.randomizer.id)));
    let kept = 0;
    for (const id of before.keys()) if (after.has(id)) kept++;
    return { added: after.size - kept, removed: before.size - kept, kept };
  }

  async #writePack(folder: string, read: ReadLibraryFile, oldIds: Record<string, string>, opts: { source?: string; now?: Date }): Promise<number> {
    // Ids that belong to this pack's folder already are its own, not taken.
    const ownIds = new Set(Object.values(oldIds));
    const inPack = (id: string) => {
      const at = this.findById(id);
      return at ? at.path === folder || at.path.startsWith(`${folder}/`) : false;
    };
    const ids = new Map<string, string>();
    const claimed = new Set<string>();
    for (const e of read.entries) {
      const id = e.file.randomizer.id;
      let local = oldIds[id] ?? id;
      const clash = (this.findById(local) && !inPack(local) && !ownIds.has(local)) || claimed.has(local);
      if (clash) local = newId();
      ids.set(id, local);
      claimed.add(local);
    }
    for (const f of read.folders) await this.backend.mkdir(join(folder, f));
    // A pack's bare `{@Name}` means a table in the pack, so only those answer.
    const packNames = resolverFor(read.entries.map((e) => ({ ...e.file.randomizer, id: ids.get(e.file.randomizer.id)! })));
    for (const e of read.entries) {
      const path = join(folder, e.path);
      if (parent(path)) await this.backend.mkdir(parent(path));
      const r = withRefIds(relink({ ...e.file.randomizer, id: ids.get(e.file.randomizer.id)! }, ids), packNames);
      await this.backend.write(path, serialize({ ...e.file, randomizer: r }));
    }
    const moved: Record<string, string> = {};
    for (const [from, to] of ids) if (from !== to) moved[from] = to;
    const installed: InstalledPack = { ...publicManifest(read.pack!), installed: (opts.now ?? new Date()).toISOString() };
    if (opts.source) installed.source = opts.source;
    if (Object.keys(moved).length) installed.ids = moved;
    await this.backend.write(join(folder, PACK_FILE), serializeManifest(installed));
    await this.refresh();
    return read.entries.length;
  }

  /**
   * A copy of an installed pack that is the user's own: new ids (the links
   * between its randomizers follow), no pack details, so nothing locks it and
   * no update touches it.
   */
  async copyPack(folder: string): Promise<string> {
    const node = this.find(folder);
    if (!node?.pack) throw new Error("that folder is not a pack");
    await this.flush();
    const files = this.files(node).filter((f) => f.randomizer);
    const ids = new Map(files.map((f) => [f.randomizer!.id, newId()] as const));
    const base = sanitizeName(`${node.name} (copy)`);
    const taken = new Set((await this.backend.list(parent(folder))).map((e) => e.name.toLowerCase()));
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} ${n}`;
    const target = join(parent(folder), name);
    await this.backend.mkdir(target);
    for (const f of this.folders(node)) if (f !== node) await this.backend.mkdir(join(target, f.path.slice(folder.length + 1)));
    for (const f of files) {
      const r = f.randomizer!;
      const copy = relink({ ...r, id: ids.get(r.id)!, ...(r.type === "list" ? { items: r.items.map((i) => ({ ...i, id: newId() })) } : {}) } as Randomizer, ids);
      await this.backend.write(join(target, f.path.slice(folder.length + 1)), serialize({ ...wrap(copy), unknown: f.extras }));
    }
    await this.refresh();
    return target;
  }

  // ---- mutations -----------------------------------------------------------

  async createFolder(parentPath: string, name: string): Promise<string> {
    this.#guard(parentPath);
    const clean = sanitizeName(name) || "New folder";
    const existing = (await this.backend.list(parentPath)).map((e) => e.name.toLowerCase());
    let final = clean;
    let n = 2;
    while (existing.includes(final.toLowerCase())) final = `${clean} ${n++}`;
    const path = join(parentPath, final);
    await this.backend.mkdir(path);
    // One node into the tree rather than re-reading the whole library.
    if (!this.#attach(parentPath, { kind: "folder", path, name: final, children: [] })) await this.refresh();
    return path;
  }

  async create(parentPath: string, randomizer: Randomizer): Promise<string> {
    this.#guard(parentPath);
    const taken = (await this.backend.list(parentPath)).map((e) => e.name);
    const path = join(parentPath, fileNameFor(randomizer.name, taken));
    await this.backend.write(path, serialize(wrap(randomizer)));
    if (!this.#attach(parentPath, { kind: "file", path, name: basename(path), randomizer })) await this.refresh();
    return path;
  }

  /** Queue a save. Repeated calls for the same file coalesce. */
  save(path: string, randomizer: Randomizer): void {
    this.#guard(path);
    const node = this.find(path);
    if (node?.randomizer && node.randomizer.id === randomizer.id && node.randomizer.name !== randomizer.name) this.#renamed.set(randomizer.id, randomizer.name);
    this.#pending.set(path, serialize({ ...wrap(randomizer), unknown: node?.extras }));
    if (node) node.randomizer = randomizer;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.flush().catch(() => {}), this.#writeDelayMs);
  }

  get hasUnsavedChanges(): boolean {
    return this.#pending.size > 0;
  }

  async flush(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    // `#flushing` must never hold a rejected promise: a `then` on one is skipped,
    // and saving would stop for the rest of the session.
    //
    // The batch is taken inside the run, not at call time, so each flush's snapshot,
    // writes and restores are serialised. Otherwise a later flush can empty
    // `#pending` before an earlier one fails, and the earlier one puts its older
    // text back over the newer. See "A save is debounced" in ARCHITECTURE.md.
    const run = this.#flushing.then(async () => {
      const batch = [...this.#pending.entries()];
      this.#pending.clear();
      const failures: unknown[] = [];
      for (const [path, text] of batch) {
        try {
          await this.backend.write(path, text);
        } catch (e) {
          failures.push(e);
          // Back into the queue, so the change is not lost and a later flush
          // can write it — but never over a newer edit of the same file.
          if (!this.#pending.has(path)) this.#pending.set(path, text);
        }
      }
      if (failures.length) {
        for (const fn of this.#errorListeners) fn(failures[0]);
        throw failures[0];
      }
      const renamed = [...this.#renamed];
      this.#renamed.clear();
      for (const [id, name] of renamed) await this.#renameRefsTo(id, name);
    });
    this.#flushing = run.catch(() => {});
    await run;
  }

  async rename(path: string, newName: string): Promise<string> {
    this.#guard(path, true);
    await this.flush();
    const node = this.find(path);
    if (!node) throw new Error(`nothing at ${path}`);
    if (node.kind === "folder") {
      const clean = sanitizeName(newName) || basename(path);
      const target = join(parent(path), clean);
      if (target !== path) await this.backend.move(path, target);
      await this.refresh();
      return target;
    }
    const randomizer = { ...node.randomizer!, name: newName, modified: new Date().toISOString() };
    // References to it say its new name, so the editor shows the name people now know.
    if (node.randomizer && node.randomizer.name !== newName) await this.#renameRefsTo(node.randomizer.id, newName);
    const taken = (await this.backend.list(parent(path))).map((e) => e.name).filter((n) => n !== basename(path));
    const target = join(parent(path), fileNameFor(newName, taken));
    await this.backend.write(path, serialize({ ...wrap(randomizer), unknown: node.extras }));
    if (target !== path) await this.backend.move(path, target);
    // A renamed file stays in its folder but may sort somewhere else in it.
    if (this.#detach(path)) {
      node.path = target;
      node.name = basename(target);
      node.randomizer = randomizer;
      if (!this.#attach(parent(target), node)) await this.refresh();
    } else {
      await this.refresh();
    }
    return target;
  }

  /** Rewrites `{@Old|id}` to `{@New|id}` in every other randomizer that refers to it. Locked packs are left as their author made them. */
  async #renameRefsTo(id: string, name: string): Promise<void> {
    for (const f of this.files()) {
      const r = f.randomizer;
      if (r?.type !== "list" || r.id === id || !refIdsOf(r).includes(id) || this.isLocked(f.path)) continue;
      const items = r.items.map((i) => ({
        ...i,
        label: renameRefs(i.label, id, name),
        ...(i.description === undefined ? {} : { description: renameRefs(i.description, id, name) }),
      }));
      const next = { ...r, items };
      await this.backend.write(f.path, serialize({ ...wrap(next), unknown: f.extras }));
      f.randomizer = next;
    }
  }

  async move(path: string, toFolder: string): Promise<string> {
    this.#guard(path, true);
    this.#guard(toFolder);
    await this.flush();
    const name = basename(path);
    const taken = (await this.backend.list(toFolder)).map((e) => e.name);
    const finalName = taken.includes(name) && this.find(path)?.kind === "file"
      ? fileNameFor(this.find(path)!.randomizer?.name ?? name.replace(FILE_SUFFIX, ""), taken)
      : name;
    const target = join(toFolder, finalName);
    if (target === path) return path;
    const node = this.find(path);
    await this.backend.move(path, target);
    // Only a file can be patched across: a folder carries a subtree whose
    // every path changes, which is what a full re-read is for.
    if (node?.kind === "file" && this.#detach(path)) {
      node.path = target;
      node.name = finalName;
      if (!this.#attach(toFolder, node)) await this.refresh();
    } else {
      await this.refresh();
    }
    return target;
  }

  async duplicate(path: string): Promise<string> {
    this.#guard(path);
    await this.flush();
    const node = this.find(path);
    if (!node?.randomizer) throw new Error(`nothing to duplicate at ${path}`);
    const copy: Randomizer = {
      ...node.randomizer,
      id: newId(),
      name: `${node.randomizer.name} (copy)`,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
    };
    if (copy.type === "list") copy.items = copy.items.map((i) => ({ ...i, id: newId() }));
    return this.create(parent(path), copy);
  }

  async remove(path: string): Promise<void> {
    this.#guard(path, true);
    await this.flush();
    await this.backend.remove(path);
    // Dropping the node drops everything under it, which is what the backend
    // just did on disk.
    if (this.#detach(path)) {
      this.#reindex();
      this.#emit();
    } else {
      await this.refresh();
    }
  }

  /**
   * A ZIP's randomizer files, by the same rules as `importLibrary`, so the links
   * between them survive. `onCollision` answers "replace", "keep-both" or "skip"
   * for a path already taken. A file that needs no change is written with the
   * exact text it arrived with.
   */
  async importArchive(
    entries: { path: string; text: string }[],
    onCollision: (path: string) => Promise<"replace" | "keep-both" | "skip">,
  ): Promise<{ added: number; replaced: number; skipped: number; failed: number; inPacks: number }> {
    const parsed: { path: string; file: OrangeyFile; text: string }[] = [];
    let failed = 0;
    for (const entry of entries) {
      if (!isRandomizerFile(entry.path)) continue;
      try {
        // Cleaned as a library file's paths are: an archive can come from anyone.
        const file = parseFile(entry.text).file;
        parsed.push({ path: safeFilePath(entry.path, file.randomizer.name), file, text: entry.text });
      } catch {
        failed++;
      }
    }
    return { ...(await this.#importFiles(parsed, [], "", onCollision)), failed };
  }

  /**
   * A library file's randomizers, into `into`, keeping the links between them.
   *
   * The first pass settles each arrival's path and id, asking about taken paths:
   * Skip keeps what is here (the file's links now mean it), Replace overwrites
   * but keeps its id, Keep both writes a copy under a new id; an id used
   * elsewhere also gets a new one. The second pass rewrites every "Goes to" and
   * board entry through those changes and writes the files.
   */
  importLibrary(
    entries: readonly { path: string; file: OrangeyFile }[],
    folders: readonly string[],
    into: string,
    onCollision: (path: string) => Promise<"replace" | "keep-both" | "skip">,
  ): Promise<{ added: number; replaced: number; skipped: number; inPacks: number }> {
    return this.#importFiles(entries, folders, into, onCollision);
  }

  /** Both imports. `text`, when given, is written as it came if nothing had to change. */
  async #importFiles(
    entries: readonly { path: string; file: OrangeyFile; text?: string }[],
    folders: readonly string[],
    into: string,
    onCollision: (path: string) => Promise<"replace" | "keep-both" | "skip">,
  ): Promise<{ added: number; replaced: number; skipped: number; inPacks: number }> {
    await this.flush();
    // `inPacks`: left alone because they would land in an installed pack (an
    // old backup that still carried its tables); the pack itself is there.
    const result = { added: 0, replaced: 0, skipped: 0, inPacks: 0 };
    // The image store owns a folder at the top; a library's own folder of
    // that name is moved aside rather than mixed into it.
    const place = (path: string) => {
      const full = join(into, path);
      const [first, ...rest] = segments(full);
      return first?.toLowerCase() === IMAGE_DIR ? join(`${first} folder`, ...rest) : full;
    };
    const ids = new Map<string, string>();
    const claimed = new Set<string>();
    const planned = new Set<string>();
    const writes: { path: string; file: OrangeyFile; text?: string }[] = [];
    const idFor = (fileId: string, id: string) => {
      if (!ids.has(fileId)) ids.set(fileId, id);
      claimed.add(id);
    };

    for (const entry of entries) {
      const path = place(entry.path);
      const r = entry.file.randomizer;
      // Nothing is written into an installed pack by an import: an update would
      // undo it. Those are passed over, and the rest still comes in.
      if (this.isLocked(parent(path)) || this.isLocked(path)) {
        if (this.findById(r.id)) idFor(r.id, r.id);
        result.inPacks++;
        continue;
      }
      const here = this.find(path);
      if (here?.kind === "file" || planned.has(path.toLowerCase())) {
        const answer = await onCollision(path);
        if (answer === "skip") {
          if (here?.randomizer) idFor(r.id, here.randomizer.id);
          result.skipped++;
          continue;
        }
        if (answer === "replace" && here?.kind === "file") {
          const keep = here.randomizer?.id ?? r.id;
          idFor(r.id, keep);
          writes.push({ path, file: { ...entry.file, randomizer: { ...r, id: keep } }, text: keep === r.id ? entry.text : undefined });
          planned.add(path.toLowerCase());
          result.replaced++;
          continue;
        }
        const folder = parent(path);
        const taken = [
          ...(this.find(folder)?.children ?? []).map((c) => c.name),
          ...[...planned].filter((p) => parent(p) === folder.toLowerCase()).map(basename),
        ];
        const copy = join(folder, fileNameFor(r.name, taken));
        const id = newId();
        idFor(r.id, id);
        writes.push({ path: copy, file: { ...entry.file, randomizer: { ...r, id } } });
        planned.add(copy.toLowerCase());
        result.added++;
        continue;
      }
      const id = this.findById(r.id) || claimed.has(r.id) ? newId() : r.id;
      idFor(r.id, id);
      writes.push({ path, file: { ...entry.file, randomizer: { ...r, id } }, text: id === r.id ? entry.text : undefined });
      planned.add(path.toLowerCase());
      result.added++;
    }

    for (const folder of folders) await this.backend.mkdir(place(folder));
    // A `{@Name}` written by hand gets the id of the one table with that name,
    // here or arriving with it.
    const arriving = writes.map((w) => relink(w.file.randomizer, ids));
    const names = resolverFor([...arriving, ...this.files().flatMap((f) => (f.randomizer ? [f.randomizer] : []))]);
    for (const w of writes) {
      const folder = parent(w.path);
      if (folder) await this.backend.mkdir(folder);
      const linked = withRefIds(relink(w.file.randomizer, ids), names);
      // Untouched (its own id, and `relink` returned the same object): write the
      // exact text it arrived with.
      const unchanged = w.text !== undefined && linked === w.file.randomizer;
      await this.backend.write(w.path, unchanged ? w.text! : serialize({ ...w.file, randomizer: linked }));
    }
    await this.refresh();
    return result;
  }

  /** Every folder in the tree with its depth, for a folder picker. */
  folderList(): { path: string; name: string; depth: number }[] {
    return this.folders().map((f) => ({ path: f.path, name: f.path === "" ? "Library" : f.name, depth: segments(f.path).length }));
  }

  /** Depth of a node, for indenting the tree. */
  depth(path: string): number {
    return segments(path).length;
  }
}

/**
 * The same randomizer with each bare `{@Name}` given the id of the one table
 * by that name; the very same object when there was nothing to fill in, so an
 * untouched file is still written as it arrived.
 */
function withRefIds(r: Randomizer, names: RefResolver): Randomizer {
  if (r.type !== "list" || !r.items.some((i) => i.label.includes("{@") || i.description?.includes("{@"))) return r;
  let changed = false;
  const items = r.items.map((i) => {
    const label = fillRefIds(i.label, names);
    const description = i.description === undefined ? undefined : fillRefIds(i.description, names);
    if (label === i.label && description === i.description) return i;
    changed = true;
    return { ...i, label, ...(description === undefined ? {} : { description }) };
  });
  return changed ? { ...r, items } : r;
}
