/**
 * The image store: the pictures an outcome can carry.
 *
 * A wheel file names a picture by id and the bytes live beside the library, at
 * `images/<id>.png`, for two reasons. A randomizer file stays small and stays
 * readable — a base64 blob in the middle of it would end that — and the same
 * picture used by five outcomes is stored once.
 *
 * The cost of that is portability, which is the whole point of a .orangey.json
 * file, so both ways out carry the picture with them: a single file inlines it
 * as a data: URL (`imageDataUrl`), and an archive holds it as its own entry.
 * An import puts the bytes back in the store and the file goes back to naming
 * an id.
 *
 * Nothing here resizes or re-encodes anything. Downscaling is the UI's job,
 * where there is a canvas to do it with; the store takes the bytes it is given.
 */

import { IMAGE_DIR, type LibraryBackend } from "./library.ts";
import { newId } from "../model/randomizer.ts";

/**
 * The backend the library is on. The store follows the library rather than
 * holding its own: pictures belong to the library they are part of, so moving
 * the library to a folder has to take them along.
 */
let imageBackend: LibraryBackend | null = null;

/**
 * One object URL per picture, kept for as long as the page lives.
 *
 * A wheel redraws every frame of a spin and asks for the same picture each
 * time. Making a URL per ask leaks one per frame; making it once and keeping
 * it costs a handful of entries, and there is nothing to revoke until the
 * picture is deleted.
 */
const imageUrls = new Map<string, string>();
/** Asks for a picture that are still in the air, so two asks make one read. */
const imageLoads = new Map<string, Promise<string | null>>();

/** Called once when the library opens, and again if the library moves. */
export function useImageStore(backend: LibraryBackend): void {
  if (imageBackend === backend) return;
  for (const url of imageUrls.values()) URL.revokeObjectURL(url);
  imageUrls.clear();
  imageLoads.clear();
  imageBackend = backend;
}

function imageFilePath(id: string): string {
  return `${IMAGE_DIR}/${id}.png`;
}

/**
 * What kind of picture these bytes are.
 *
 * Every file in the store is named .png because that is what the app makes,
 * but the store takes whatever it is given and a data: URL has to say what it
 * really holds or the browser will not draw it.
 */
function imageMediaType(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return "image/webp";
  return "image/png";
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  // In chunks: spreading a whole picture into fromCharCode overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function bytesFromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Keep a picture. The id it returns is what an outcome carries. */
export async function putImage(bytes: Uint8Array): Promise<string> {
  const id = newId();
  await restoreImage(id, bytes);
  return id;
}

/**
 * Keep a picture under an id it already has, for an archive being unpacked:
 * the randomizers in it name these ids, so a new one would break every
 * outcome that points at it.
 */
export async function restoreImage(id: string, bytes: Uint8Array): Promise<void> {
  if (!imageBackend) throw new Error("the image store has no library to write to");
  await imageBackend.mkdir(IMAGE_DIR);
  await imageBackend.writeBytes(imageFilePath(id), bytes);
}

/** The bytes, or null when there is no such picture. */
export async function imageBytes(id: string): Promise<Uint8Array | null> {
  if (!imageBackend || !id) return null;
  try {
    return await imageBackend.readBytes(imageFilePath(id));
  } catch {
    return null;
  }
}

/** A URL to draw with, made once per picture. */
export async function imageUrl(id: string): Promise<string | null> {
  const known = imageUrls.get(id);
  if (known) return known;
  const inFlight = imageLoads.get(id);
  if (inFlight) return inFlight;
  const load = (async () => {
    const bytes = await imageBytes(id);
    if (!bytes) return null;
    // Between the read starting and finishing someone else may have made it.
    const raced = imageUrls.get(id);
    if (raced) return raced;
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: imageMediaType(bytes) }));
    imageUrls.set(id, url);
    return url;
  })().finally(() => imageLoads.delete(id));
  imageLoads.set(id, load);
  return load;
}

/**
 * The URL if it is already there, and null if it is not.
 *
 * Drawing a wheel is synchronous and cannot wait for a read, so it asks with
 * this, draws the segment without its picture when the answer is null, and
 * `imageUrl` warms the cache so the next draw has it.
 */
export function imageUrlSync(id: string): string | null {
  return imageUrls.get(id) ?? null;
}

/** The picture inline, for a file that has to be self-contained. */
export async function imageDataUrl(id: string): Promise<string | null> {
  const bytes = await imageBytes(id);
  if (!bytes) return null;
  return `data:${imageMediaType(bytes)};base64,${base64FromBytes(bytes)}`;
}

/** And the other way: an inline picture from a file becomes a stored one. */
export async function putImageData(dataUrl: string): Promise<string> {
  const comma = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:") || comma < 0) throw new Error("that is not an inline picture");
  const head = dataUrl.slice(5, comma);
  if (!head.includes("base64")) throw new Error("an inline picture must be base64");
  return putImage(bytesFromBase64(dataUrl.slice(comma + 1)));
}

export async function deleteImage(id: string): Promise<void> {
  const url = imageUrls.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    imageUrls.delete(id);
  }
  if (!imageBackend) return;
  await imageBackend.remove(imageFilePath(id)).catch(() => {});
}

/**
 * Delete the pictures nothing points at any more, and say how many went.
 *
 * Deleting a wheel does not delete its pictures then and there: the same
 * picture may be on another wheel, and an undo that brought the wheel back
 * without its pictures would be worse than a file left behind. So they are
 * swept up later, against the ids the whole library is using.
 */
export async function pruneImages(usedIds: Set<string>): Promise<number> {
  if (!imageBackend) return 0;
  let entries;
  try {
    entries = await imageBackend.list(IMAGE_DIR);
  } catch {
    return 0;
  }
  let gone = 0;
  for (const entry of entries) {
    if (entry.kind !== "file" || !entry.name.endsWith(".png")) continue;
    const id = entry.name.slice(0, -4);
    if (usedIds.has(id)) continue;
    await deleteImage(id);
    gone++;
  }
  return gone;
}
