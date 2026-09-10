/**
 * A whole randomizer inside a link.
 *
 * A library link (`#/id/…`) is short and follows your edits, but it only works
 * on a device where that library is stored. This is the other kind: the wheel
 * itself — name, outcomes, weights, colours, Orangey's tags and the
 * randomizer's own animation settings — compressed into the address, so a deck
 * rolls it on anyone's machine with nothing installed and nothing shared in
 * advance.
 *
 * Two properties are worth knowing. The payload sits after the `#`, and
 * browsers never send a fragment to the server, so even the hosted copy never
 * sees anyone's encounter tables. And it is frozen: a deck made today rolls
 * the same wheel in a year, whatever has happened to the library since.
 *
 * What is deliberately left out: `created` and `modified`, which mean nothing
 * to a stranger, and the outcomes' ids, which are library bookkeeping and
 * would be the largest thing in the payload. They are made afresh on the way
 * in.
 */

import { deflate, inflate } from "../storage/zip.ts";
import { newId, nowIso, validateRandomizer, type ListItem, type Randomizer } from "./randomizer.ts";
import { Check, ValidationError } from "./validate.ts";

/** `1` deflated, `0` stored: the first character says which. */
const DEFLATED = "1";
const STORED = "0";

/**
 * Past this many characters a link is long enough to be worth warning about:
 * every browser and both deck programs take it, but it is unwieldy to handle.
 */
export const LINK_SOFT_LIMIT = 2000;

/**
 * And past this one Orangey will not offer it at all. Browsers go further,
 * but a link this long has stopped being something you can paste about.
 */
export const LINK_HARD_LIMIT = 8000;

const linkEncoder = new TextEncoder();
const linkDecoder = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  // In chunks: spreading a large array into fromCharCode overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** The randomizer as it travels: no timestamps, no outcome ids. */
export function packRandomizer(r: Randomizer): Record<string, unknown> {
  const packed: Record<string, unknown> = { ...r };
  delete packed.created;
  delete packed.modified;
  if (r.type === "list") {
    packed.items = r.items.map((item) => {
      const { id: _id, ...rest } = item;
      return rest;
    });
  }
  for (const key of Object.keys(packed)) if (packed[key] === undefined) delete packed[key];
  return packed;
}

/** And back: timestamps and outcome ids made afresh, then validated. */
export function unpackRandomizer(raw: unknown): Randomizer {
  const check = new Check();
  if (!check.object("link", raw)) throw new ValidationError(check.issues);
  const o = { ...(raw as Record<string, unknown>) };
  const now = nowIso();
  o.created ??= now;
  o.modified ??= now;
  if (Array.isArray(o.items)) {
    o.items = (o.items as Partial<ListItem>[]).map((item) =>
      typeof item === "object" && item !== null ? { id: newId(), ...item } : item,
    );
  }
  if (!validateRandomizer(o, check, "link")) throw new ValidationError(check.issues);
  return o as unknown as Randomizer;
}

/** The value that goes after `w=`. */
export async function encodeRandomizer(r: Randomizer): Promise<string> {
  const json = JSON.stringify(packRandomizer(r));
  const raw = linkEncoder.encode(json);
  const { data, method } = await deflate(raw);
  return (method === 8 ? DEFLATED : STORED) + toBase64Url(data);
}

/**
 * Read one back. Throws a ValidationError naming what is wrong, so a damaged
 * link can be explained rather than merely failing.
 */
export async function decodeRandomizer(payload: string): Promise<Randomizer> {
  const fail = (message: string): never => {
    throw new ValidationError([{ path: "link", message }]);
  };
  if (!payload) fail("there is nothing after w=");
  const marker = payload[0];
  if (marker !== DEFLATED && marker !== STORED) fail("this link was made by a newer Orangey");
  let json: string;
  try {
    const bytes = fromBase64Url(payload.slice(1));
    json = linkDecoder.decode(await inflate(bytes, marker === DEFLATED ? 8 : 0));
  } catch {
    return fail("the link is damaged: it did not survive being copied");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return fail("the link is damaged: what it holds is not a randomizer");
  }
  return unpackRandomizer(parsed);
}
