/**
 * The randomizer types (plan C2).
 *
 * "Choice", "weighted choice" and "wheel" are one type with two views
 * (decision D5): a list of weighted outcomes. Uniform choice is equal weights.
 */

import { isRollable, type Weighted } from "../core/weighted.ts";
import { Check } from "./validate.ts";
import { isHex } from "../core/color.ts";
import { SLICE_CONTENTS, type SliceContent } from "../core/wheel-geometry.ts";
import type { FeelOverride } from "./feel.ts";

/** The types that can be rolled. A board is not one of them; it holds them. */
export const ROLLABLE_TYPES = ["list", "dice", "coin", "number"] as const;
export const RANDOMIZER_TYPES = [...ROLLABLE_TYPES, "board"] as const;
export type RollableType = (typeof ROLLABLE_TYPES)[number];
export type RandomizerType = (typeof RANDOMIZER_TYPES)[number];

/**
 * How many randomizers one board may hold. Past a dozen the cells are too
 * small to read across the table, which is what a board is for.
 */
export const BOARD_LIMIT = 12;

/**
 * How many outcomes a wheel may offer to choose from. One is no choice at
 * all, and past a dozen the cards stop being something to choose between at
 * a glance and become a list to read.
 */
export const OFFER_MIN = 2;
export const OFFER_MAX = 12;

/**
 * What Orangey does when a particular outcome comes up. Wheels and coins have
 * no natural top or bottom the way dice do, so the game master tags outcomes
 * instead: the file says what he does ("cheer", "wince"), never which
 * animation plays, so new poses need no format change.
 */
export const OUTCOME_REACTIONS = ["cheer", "wince"] as const;
export type OutcomeReaction = (typeof OUTCOME_REACTIONS)[number];

export interface RandomizerBase {
  id: string;
  type: RandomizerType;
  name: string;
  description?: string;
  tags?: string[];
  created: string;
  modified: string;
  /** Animation settings for this randomizer alone, merged over the global ones. */
  feel?: FeelOverride;
}

export interface ListItem extends Weighted {
  id: string;
  label: string;
  weight: number;
  /** true = excluded from rolls, still listed, weight preserved (decision D6). */
  disabled?: boolean;
  description?: string;
  color?: string;
  metadata?: Record<string, string | number | boolean>;
  /** Orangey's reaction when this outcome comes up. */
  reaction?: OutcomeReaction;
  /**
   * A picture shown when this outcome comes up: an id in the image store,
   * which keeps the bytes beside the library rather than in this file.
   */
  image?: string;
  /**
   * The same picture inline, as a data: URL. Only ever present in a file on
   * its way in or out of the app — a single-file export is self-contained, and
   * an import puts the bytes in the store and swaps this for `image`. Links
   * never carry it.
   */
  imageData?: string;
  /**
   * This outcome sends you to another randomizer, by id: rolling it opens that
   * one beside this wheel. A table that points at another table is the whole
   * reason encounter tables are written the way they are.
   */
  goesTo?: string;
}

export interface ListRandomizer extends RandomizerBase {
  type: "list";
  items: ListItem[];
  view: "wheel" | "list";
  /** 0.2 bag mode; carried in the format from 0.1 so old files stay valid. */
  withoutReplacement?: boolean;
  /**
   * What a wheel's slice shows when its outcome has a picture. Left out
   * means the picture; files only carry it when someone chose otherwise.
   */
  slices?: SliceContent;
  /**
   * Make a choice: a roll draws this many different outcomes and the player
   * picks one, and the pick is the outcome. "Here are three hooks, take one"
   * is a mechanic a single landing cannot express. Left out, a roll lands on
   * one outcome as it always has.
   */
  offer?: number;
}

export interface DiceRandomizer extends RandomizerBase {
  type: "dice";
  expression: string;
}

export interface CoinRandomizer extends RandomizerBase {
  type: "coin";
  faces: [string, string];
  /** Orangey's reaction to each face, in the same order as `faces`. */
  faceReactions?: [OutcomeReaction | null, OutcomeReaction | null];
}

export interface NumberRandomizer extends RandomizerBase {
  type: "number";
  min: number;
  max: number;
  integer: boolean;
  inclusiveMax: boolean;
  count: number;
  unique: boolean;
}

/**
 * A board: several randomizers on one screen, rolled together or one at a
 * time. It refers to them by id, so renaming or moving one does not break the
 * board, and carries the name each had when it was added — enough to say what
 * is missing when a randomizer has been deleted.
 */
export interface BoardEntry {
  id: string;
  name: string;
}

export interface BoardRandomizer extends RandomizerBase {
  type: "board";
  entries: BoardEntry[];
}

/** Everything that can actually be rolled. */
export type Rollable = ListRandomizer | DiceRandomizer | CoinRandomizer | NumberRandomizer;
export type Randomizer = Rollable | BoardRandomizer;

export function isBoard(r: Randomizer): r is BoardRandomizer {
  return r.type === "board";
}

export function newId(): string {
  const c = globalThis.crypto as Crypto;
  if (typeof c.randomUUID === "function") return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function touch<T extends Randomizer>(r: T): T {
  return { ...r, modified: nowIso() };
}

export function makeItem(label: string, weight = 1, extra: Partial<ListItem> = {}): ListItem {
  return { id: newId(), label, weight, ...extra };
}

export function emptyRandomizer(type: RandomizerType, name: string): Randomizer {
  const base = { id: newId(), name, created: nowIso(), modified: nowIso() };
  switch (type) {
    case "list":
      return { ...base, type: "list", view: "wheel", items: [makeItem("First outcome"), makeItem("Second outcome")] };
    case "dice":
      return { ...base, type: "dice", expression: "d20" };
    case "coin":
      return { ...base, type: "coin", faces: ["Heads", "Tails"] };
    case "number":
      return { ...base, type: "number", min: 1, max: 100, integer: true, inclusiveMax: true, count: 1, unique: false };
    case "board":
      return { ...base, type: "board", entries: [] };
  }
}

/** Does this randomizer have anything that can come up right now? */
export function canRoll(r: Randomizer): boolean {
  // A board rolls what is on it; on its own it has nothing to come up.
  if (r.type === "board") return r.entries.length > 0;
  if (r.type !== "list") return true;
  return r.items.some(isRollable);
}

export function validateRandomizer(v: unknown, check = new Check(), path = "randomizer"): boolean {
  if (!check.object(path, v)) return false;
  const o = v as Record<string, unknown>;
  check.string(`${path}.id`, o.id, { min: 1 });
  check.string(`${path}.name`, o.name, { min: 1, max: 120 });
  if (o.description !== undefined) check.string(`${path}.description`, o.description, { max: 2000 });
  if (o.tags !== undefined && check.array(`${path}.tags`, o.tags)) {
    (o.tags as unknown[]).forEach((t, i) => check.string(`${path}.tags[${i}]`, t, { min: 1, max: 40 }));
  }
  if (o.feel !== undefined && !check.object(`${path}.feel`, o.feel)) return false;
  if (o.created !== undefined) check.string(`${path}.created`, o.created, { min: 1 });
  if (o.modified !== undefined) check.string(`${path}.modified`, o.modified, { min: 1 });
  if (!check.oneOf(`${path}.type`, o.type, RANDOMIZER_TYPES)) return false;

  switch (o.type) {
    case "list": {
      if (o.view !== undefined) check.oneOf(`${path}.view`, o.view, ["wheel", "list"] as const);
      if (o.withoutReplacement !== undefined) check.boolean(`${path}.withoutReplacement`, o.withoutReplacement);
      if (o.slices !== undefined) check.oneOf(`${path}.slices`, o.slices, SLICE_CONTENTS);
      if (o.offer !== undefined) check.number(`${path}.offer`, o.offer, { min: OFFER_MIN, max: OFFER_MAX, integer: true });
      if (check.array(`${path}.items`, o.items, 1)) {
        (o.items as unknown[]).forEach((it, i) => validateItem(it, check, `${path}.items[${i}]`));
      }
      break;
    }
    case "dice":
      check.string(`${path}.expression`, o.expression, { min: 1, max: 200 });
      break;
    case "coin":
      if (check.array(`${path}.faces`, o.faces, 2)) {
        const faces = o.faces as unknown[];
        if (faces.length !== 2) check.fail(`${path}.faces`, "a coin has exactly two faces");
        faces.slice(0, 2).forEach((f, i) => check.string(`${path}.faces[${i}]`, f, { min: 1, max: 60 }));
      }
      if (o.faceReactions !== undefined && check.array(`${path}.faceReactions`, o.faceReactions)) {
        const fr = o.faceReactions as unknown[];
        if (fr.length !== 2) check.fail(`${path}.faceReactions`, "one entry per face");
        fr.slice(0, 2).forEach((v, i) => {
          if (v !== null) check.oneOf(`${path}.faceReactions[${i}]`, v, OUTCOME_REACTIONS);
        });
      }
      break;
    case "board": {
      if (check.array(`${path}.entries`, o.entries)) {
        const entries = o.entries as unknown[];
        if (entries.length > BOARD_LIMIT) check.fail(`${path}.entries`, `a board holds at most ${BOARD_LIMIT} randomizers`);
        const seen = new Set<string>();
        entries.forEach((e, i) => {
          if (!check.object(`${path}.entries[${i}]`, e)) return;
          const entry = e as Record<string, unknown>;
          check.string(`${path}.entries[${i}].id`, entry.id, { min: 1 });
          check.string(`${path}.entries[${i}].name`, entry.name, { min: 1, max: 120 });
          if (typeof entry.id === "string") {
            // The same randomizer twice would roll itself against itself and
            // give two answers to one question.
            if (seen.has(entry.id)) check.fail(`${path}.entries[${i}].id`, "already on this board");
            seen.add(entry.id);
          }
        });
      }
      break;
    }
    case "number":
      check.number(`${path}.min`, o.min);
      check.number(`${path}.max`, o.max);
      check.boolean(`${path}.integer`, o.integer);
      check.boolean(`${path}.inclusiveMax`, o.inclusiveMax);
      check.number(`${path}.count`, o.count, { min: 1, max: 1000, integer: true });
      check.boolean(`${path}.unique`, o.unique);
      if (typeof o.min === "number" && typeof o.max === "number" && o.max < o.min) {
        check.fail(`${path}.max`, "must not be below the minimum");
      }
      break;
  }
  return check.ok;
}

/** A picture small enough to sit in a file: 1600px on its long edge, at most. */
export const IMAGE_MAX_EDGE = 1600;

export function validateItem(v: unknown, check: Check, path: string): void {
  if (!check.object(path, v)) return;
  const o = v as Record<string, unknown>;
  check.string(`${path}.id`, o.id, { min: 1 });
  check.string(`${path}.label`, o.label, { min: 1, max: 200 });
  check.number(`${path}.weight`, o.weight, { min: 0 });
  if (o.disabled !== undefined) check.boolean(`${path}.disabled`, o.disabled);
  if (o.description !== undefined) check.string(`${path}.description`, o.description, { max: 2000 });
  if (o.color !== undefined && !isHex(o.color)) check.fail(`${path}.color`, "expected a colour like #a33a30");
  if (o.reaction !== undefined) check.oneOf(`${path}.reaction`, o.reaction, OUTCOME_REACTIONS);
  if (o.image !== undefined) check.string(`${path}.image`, o.image, { min: 1, max: 200 });
  if (o.goesTo !== undefined) check.string(`${path}.goesTo`, o.goesTo, { min: 1, max: 200 });
  if (o.imageData !== undefined) {
    // Only a picture, and only inline: a file arriving with a link in this
    // field would be asking the app to fetch something when a wheel is drawn.
    if (check.string(`${path}.imageData`, o.imageData, { min: 1 }) && !/^data:image\/(png|jpeg|webp|gif);base64,/.test(o.imageData as string)) {
      check.fail(`${path}.imageData`, "expected an inline picture (a data:image/… URL)");
    }
  }
  if (o.metadata !== undefined && check.object(`${path}.metadata`, o.metadata)) {
    for (const [k, mv] of Object.entries(o.metadata as Record<string, unknown>)) {
      if (!["string", "number", "boolean"].includes(typeof mv)) {
        check.fail(`${path}.metadata.${k}`, "expected text, a number or true/false");
      }
    }
  }
}
