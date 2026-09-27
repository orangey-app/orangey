/**
 * A whole randomizer inside a link (`#/roll?w=…`), so it rolls on any device
 * with nothing shared in advance. The payload is in the fragment, which is
 * never sent to a server, and the link is frozen: it rolls the same wheel in a
 * year. See docs/FORMAT.md, "A randomizer inside a link".
 */

import { base64FromBytes, bytesFromBase64, deflate, inflate } from "../storage/zip.ts";
import { newId, nowIso, validateRandomizer, type ListItem, type Randomizer } from "./randomizer.ts";
import { Check, ValidationError } from "./validate.ts";

/** `1` deflated, `0` stored: the first character says which. */
const DEFLATED = "1";
const STORED = "0";

/** Past this many characters the app warns that the link is unwieldy. */
export const LINK_SOFT_LIMIT = 2000;

/** Past this many characters the app does not offer a link at all. */
export const LINK_HARD_LIMIT = 8000;

const linkEncoder = new TextEncoder();
const linkDecoder = new TextDecoder();

/** Plain base64 with the three characters a URL would mangle swapped out. */
function toBase64Url(bytes: Uint8Array): string {
  return base64FromBytes(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  return bytesFromBase64(padded + "=".repeat((4 - (padded.length % 4)) % 4));
}

/** The randomizer as it travels: no timestamps, no outcome ids. */
export function packRandomizer(r: Randomizer): Record<string, unknown> {
  const packed: Record<string, unknown> = { ...r };
  delete packed.created;
  delete packed.modified;
  if (r.type === "list") {
    packed.items = r.items.map((item) => {
      // No pictures: inlining the bytes would make the link far too long, and an
      // id from someone else's image store means nothing here.
      const { id: _id, image: _image, imageData: _imageData, ...rest } = item;
      return rest;
    });
  }
  for (const key of Object.keys(packed)) if (packed[key] === undefined) delete packed[key];
  return packed;
}

/**
 * A board only names its randomizers, so it is shared as an archive, never a
 * link. Refused both ways, so a hand-made link cannot open an empty board.
 */
const BOARD_NOT_IN_LINK = "a board only names its randomizers, so it travels as an archive, not in a link";

/** And back: timestamps and outcome ids made afresh, then validated. */
export function unpackRandomizer(raw: unknown): Randomizer {
  const check = new Check();
  if (!check.object("link", raw)) throw new ValidationError(check.issues);
  const o = { ...(raw as Record<string, unknown>) };
  // Said before anything else is checked: whatever else is wrong with it,
  // this is the reason a board link cannot work.
  if (o.type === "board") throw new ValidationError([{ path: "link", message: BOARD_NOT_IN_LINK }]);
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
  if (r.type === "board") throw new ValidationError([{ path: "link", message: BOARD_NOT_IN_LINK }]);
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
