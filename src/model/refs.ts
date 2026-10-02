/**
 * Tables inside tables: `{@Weather}` in an outcome rolls the randomizer called
 * Weather and puts its answer there ("A {@Weather} morning" → "A foggy morning").
 *
 * In the file a reference is `{@Name|id}`. The id is what counts, so renaming
 * or moving the table, or a second table with the same name, breaks nothing;
 * the name is there for people, and for anything that cannot roll it. A
 * reference written by hand as `{@Name}` works too: the editor and an import
 * fill in the id when exactly one table has that name. The editor shows
 * `{@Name}` and keeps the ids out of sight (`showRefs` / `keepRefs`).
 *
 * Rolling follows references up to MAX_REF_DEPTH deep and never round in a
 * circle; what cannot be rolled shows as its name.
 */

import type { Randomizer } from "./randomizer.ts";

/** `{@Name}` or `{@Name|id}`. The name cannot hold braces or a bar. */
export const REF_PATTERN = /\{@([^{}|]{1,80})(?:\|([^{}|\s]{1,80}))?\}/g;
export const MAX_REF_DEPTH = 8;

export interface Ref {
  name: string;
  id?: string;
}

/** Finds what a reference points at: by id first, then by name. */
export interface RefResolver {
  byId(id: string): Randomizer | null | undefined;
  /** Every randomizer with this name (ignoring case); a reference by name works only when there is one. */
  byName(name: string): readonly Randomizer[];
}

/** One reference as it was rolled, for history and Sekwe. */
export interface RefPart {
  id: string;
  name: string;
  text: string;
}

const fresh = () => new RegExp(REF_PATTERN.source, "g");

export function refsIn(text: string | undefined): Ref[] {
  if (!text || !text.includes("{@")) return [];
  return [...text.matchAll(fresh())].map((m) => (m[2] ? { name: m[1].trim(), id: m[2] } : { name: m[1].trim() }));
}

/** The ids a randomizer's outcomes refer to (labels and descriptions). */
export function refIdsOf(r: Randomizer): string[] {
  if (r.type !== "list") return [];
  return r.items.flatMap((i) => [...refsIn(i.label), ...refsIn(i.description)].flatMap((ref) => (ref.id ? [ref.id] : [])));
}

/** What a reference points at, or null: by id while that id exists, else by a name only one table has. */
export function resolveRef(ref: Ref, resolver: RefResolver): Randomizer | null {
  if (ref.id) {
    const found = resolver.byId(ref.id);
    if (found) return found;
  }
  const named = resolver.byName(ref.name);
  return named.length === 1 ? named[0] : null;
}

/** For the editor and anywhere text is shown to people: `{@Name|id}` → `{@Name}`. */
export function showRefs(text: string): string {
  return text.includes("{@") ? text.replace(fresh(), (_w, name: string) => `{@${name.trim()}}`) : text;
}

/**
 * The other way, as the editor saves: each `{@Name}` typed takes the id it
 * had in `previous` (so a reference the person did not touch keeps pointing
 * where it pointed, even at a table renamed since), else the id of the one
 * table with that name; else it stays a name, to be filled in later.
 */
export function keepRefs(typed: string, previous: string, findByName: (name: string) => readonly { id: string }[]): string {
  if (!typed.includes("{@")) return typed;
  const had = new Map<string, string>();
  for (const ref of refsIn(previous)) if (ref.id && !had.has(ref.name.toLowerCase())) had.set(ref.name.toLowerCase(), ref.id);
  return typed.replace(fresh(), (whole, rawName: string, id: string | undefined) => {
    const name = rawName.trim();
    if (id) return `{@${name}|${id}}`;
    const known = had.get(name.toLowerCase());
    if (known) return `{@${name}|${known}}`;
    const found = findByName(name);
    return found.length === 1 ? `{@${name}|${found[0].id}}` : whole;
  });
}

/** Sends references to other ids (an import that had to give a table a new id). */
export function remapRefs(text: string, ids: ReadonlyMap<string, string>): string {
  if (!text.includes("{@")) return text;
  return text.replace(fresh(), (whole, name: string, id: string | undefined) => {
    const to = id ? ids.get(id) : undefined;
    return to && to !== id ? `{@${name}|${to}}` : whole;
  });
}

/** After a table is renamed: the references to it say its new name. */
export function renameRefs(text: string, id: string, name: string): string {
  if (!text.includes("{@")) return text;
  const clean = name.replace(/[{}|]/g, "").trim() || "?";
  return text.replace(fresh(), (whole, _old: string, refId: string | undefined) => (refId === id ? `{@${clean}|${id}}` : whole));
}

/** Fills in the id of every `{@Name}` that one table answers to (an import, a hand-written file). */
export function fillRefIds(text: string, resolver: RefResolver): string {
  if (!text.includes("{@")) return text;
  return text.replace(fresh(), (whole, rawName: string, id: string | undefined) => {
    if (id) return whole;
    const named = resolver.byName(rawName.trim());
    return named.length === 1 ? `{@${rawName.trim()}|${named[0].id}}` : whole;
  });
}

/** A resolver over a plain list of randomizers. */
export function resolverFor(all: Iterable<Randomizer>): RefResolver {
  const byId = new Map<string, Randomizer>();
  const byName = new Map<string, Randomizer[]>();
  for (const r of all) {
    if (!byId.has(r.id)) byId.set(r.id, r);
    const key = r.name.trim().toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), r]);
  }
  return { byId: (id) => byId.get(id) ?? null, byName: (name) => byName.get(name.trim().toLowerCase()) ?? [] };
}
