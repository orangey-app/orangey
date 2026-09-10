/**
 * The randomizer types (plan C2).
 *
 * "Choice", "weighted choice" and "wheel" are one type with two views
 * (decision D5): a list of weighted outcomes. Uniform choice is equal weights.
 */

import { isRollable, type Weighted } from "../core/weighted.ts";
import { Check } from "./validate.ts";
import { isHex } from "../core/color.ts";
import type { FeelOverride } from "./feel.ts";

export const RANDOMIZER_TYPES = ["list", "dice", "coin", "number"] as const;
export type RandomizerType = (typeof RANDOMIZER_TYPES)[number];

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
}

export interface ListRandomizer extends RandomizerBase {
  type: "list";
  items: ListItem[];
  view: "wheel" | "list";
  /** 0.2 bag mode; carried in the format from 0.1 so old files stay valid. */
  withoutReplacement?: boolean;
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

export type Randomizer = ListRandomizer | DiceRandomizer | CoinRandomizer | NumberRandomizer;

export function newId(): string {
  const c = globalThis.crypto;
  if (c && "randomUUID" in c) return c.randomUUID();
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
  }
}

/** Does this randomizer have anything that can come up right now? */
export function canRoll(r: Randomizer): boolean {
  if (r.type !== "list") return true;
  return r.items.some(isRollable);
}

export function validateRandomizer(v: unknown, check = new Check(), path = "randomizer"): check is Check {
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
  if (o.metadata !== undefined && check.object(`${path}.metadata`, o.metadata)) {
    for (const [k, mv] of Object.entries(o.metadata as Record<string, unknown>)) {
      if (!["string", "number", "boolean"].includes(typeof mv)) {
        check.fail(`${path}.metadata.${k}`, "expected text, a number or true/false");
      }
    }
  }
}
