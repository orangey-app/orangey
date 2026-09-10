/**
 * The library: a folder tree of .orangey.json files (plan C5, decision D11).
 *
 * There is deliberately no index file. The folder tree IS the library, so a
 * library kept in Dropbox or Git cannot develop a conflict between the files
 * and an index that claims to describe them. Ordering is alphabetical with
 * natural number handling; per-user extras (favourites, recents) live in the
 * app database, not in the user's files.
 */

import { FILE_SUFFIX, fileNameFor, parseFile, serialize, wrap } from "../model/file.ts";
import { newId, type Randomizer } from "../model/randomizer.ts";
import { ValidationError } from "../model/validate.ts";
import { basename, join, naturalCompare, parent, sanitizeName, segments } from "./paths.ts";

export interface Entry {
  name: string;
  kind: "folder" | "file";
}

export interface LibraryBackend {
  readonly kind: "memory" | "opfs" | "idb" | "fsa" | "tauri";
  /** Human-readable location, shown in the UI ("Browser storage", a folder name). */
  readonly label: string;
  readonly writable: boolean;
  list(path: string): Promise<Entry[]>;
  read(path: string): Promise<string>;
  write(path: string, contents: string): Promise<void>;
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
  #pending = new Map<string, string>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #writeDelayMs: number;
  #listeners = new Set<() => void>();
  /** Resolves when every debounced write has hit the backend. */
  #flushing: Promise<void> = Promise.resolve();

  constructor(backend: LibraryBackend, writeDelayMs = 400) {
    this.backend = backend;
    this.#writeDelayMs = writeDelayMs;
  }

  onChange(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #emit(): void {
    for (const fn of this.#listeners) fn();
  }

  get tree(): LibraryNode {
    return this.#tree ?? { kind: "folder", path: "", name: "Library", children: [] };
  }

  async refresh(): Promise<LibraryNode> {
    this.#tree = await this.#readFolder("", "Library");
    this.#emit();
    return this.#tree;
  }

  async #readFolder(path: string, name: string): Promise<LibraryNode> {
    const entries = await this.backend.list(path);
    const folders: LibraryNode[] = [];
    const files: LibraryNode[] = [];
    for (const e of entries) {
      const child = join(path, e.name);
      if (e.kind === "folder") folders.push(await this.#readFolder(child, e.name));
      else if (isRandomizerFile(e.name)) files.push(await this.#readFile(child, e.name));
    }
    folders.sort((a, b) => naturalCompare(a.name, b.name));
    files.sort((a, b) => naturalCompare(this.#title(a), this.#title(b)));
    return { kind: "folder", path, name, children: [...folders, ...files] };
  }

  #title(node: LibraryNode): string {
    return node.randomizer?.name ?? node.name;
  }

  async #readFile(path: string, name: string): Promise<LibraryNode> {
    try {
      const text = await this.backend.read(path);
      const out = parseFile(text);
      return { kind: "file", path, name, randomizer: out.file.randomizer, readOnly: out.readOnly };
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
    const walk = (n: LibraryNode): LibraryNode | null => {
      if (n.path === path) return n;
      for (const c of n.children ?? []) {
        const hit = walk(c);
        if (hit) return hit;
      }
      return null;
    };
    return walk(this.tree);
  }

  findById(id: string): LibraryNode | null {
    return this.files().find((f) => f.randomizer?.id === id) ?? null;
  }

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

  // ---- mutations -----------------------------------------------------------

  async createFolder(parentPath: string, name: string): Promise<string> {
    const clean = sanitizeName(name) || "New folder";
    const existing = (await this.backend.list(parentPath)).map((e) => e.name.toLowerCase());
    let final = clean;
    let n = 2;
    while (existing.includes(final.toLowerCase())) final = `${clean} ${n++}`;
    const path = join(parentPath, final);
    await this.backend.mkdir(path);
    await this.refresh();
    return path;
  }

  async create(parentPath: string, randomizer: Randomizer): Promise<string> {
    const taken = (await this.backend.list(parentPath)).map((e) => e.name);
    const path = join(parentPath, fileNameFor(randomizer.name, taken));
    await this.backend.write(path, serialize(wrap(randomizer)));
    await this.refresh();
    return path;
  }

  /** Queue a save. Repeated calls for the same file coalesce (plan C5). */
  save(path: string, randomizer: Randomizer): void {
    this.#pending.set(path, serialize(wrap(randomizer)));
    const node = this.find(path);
    if (node) node.randomizer = randomizer;
    this.#emit();
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.flush(), this.#writeDelayMs);
  }

  get hasUnsavedChanges(): boolean {
    return this.#pending.size > 0;
  }

  async flush(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const batch = [...this.#pending.entries()];
    this.#pending.clear();
    this.#flushing = this.#flushing.then(async () => {
      for (const [path, text] of batch) await this.backend.write(path, text);
    });
    await this.#flushing;
    this.#emit();
  }

  async rename(path: string, newName: string): Promise<string> {
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
    const taken = (await this.backend.list(parent(path))).map((e) => e.name).filter((n) => n !== basename(path));
    const target = join(parent(path), fileNameFor(newName, taken));
    await this.backend.write(path, serialize(wrap(randomizer)));
    if (target !== path) await this.backend.move(path, target);
    await this.refresh();
    return target;
  }

  async move(path: string, toFolder: string): Promise<string> {
    await this.flush();
    const name = basename(path);
    const taken = (await this.backend.list(toFolder)).map((e) => e.name);
    const finalName = taken.includes(name) && this.find(path)?.kind === "file"
      ? fileNameFor(this.find(path)!.randomizer?.name ?? name.replace(FILE_SUFFIX, ""), taken)
      : name;
    const target = join(toFolder, finalName);
    if (target === path) return path;
    await this.backend.move(path, target);
    await this.refresh();
    return target;
  }

  async duplicate(path: string): Promise<string> {
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
    await this.flush();
    await this.backend.remove(path);
    await this.refresh();
  }

  /**
   * Import a whole library from ZIP entries. Files that already exist are
   * handled by `onCollision`, which answers "replace", "keep-both" or "skip"
   * per file — the UI asks the user; tests answer programmatically.
   */
  async importArchive(
    entries: { path: string; text: string }[],
    onCollision: (path: string) => Promise<"replace" | "keep-both" | "skip">,
  ): Promise<{ added: number; replaced: number; skipped: number; failed: number }> {
    await this.flush();
    const result = { added: 0, replaced: 0, skipped: 0, failed: 0 };
    for (const entry of entries) {
      if (!isRandomizerFile(entry.path)) continue;
      let parsed;
      try {
        parsed = parseFile(entry.text);
      } catch {
        result.failed++;
        continue;
      }
      const folder = parent(entry.path);
      if (folder) await this.backend.mkdir(folder);
      const exists = this.find(entry.path) !== null;
      if (!exists) {
        await this.backend.write(entry.path, entry.text);
        result.added++;
        continue;
      }
      const answer = await onCollision(entry.path);
      if (answer === "skip") {
        result.skipped++;
      } else if (answer === "replace") {
        await this.backend.write(entry.path, entry.text);
        result.replaced++;
      } else {
        const taken = (await this.backend.list(folder)).map((e) => e.name);
        const copy = { ...parsed.file.randomizer, id: newId() };
        await this.backend.write(join(folder, fileNameFor(copy.name, taken)), serialize(wrap(copy)));
        result.added++;
      }
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
