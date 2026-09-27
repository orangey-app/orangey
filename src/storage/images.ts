/**
 * The image store: the pictures an outcome can carry.
 *
 * A randomizer file names a picture by id and the bytes live beside the library,
 * under `images/`, so the file stays small and readable and a shared picture is
 * stored once (see "Pictures live beside the library" in ARCHITECTURE.md).
 * Nothing here resizes or re-encodes; the store keeps the bytes it is given.
 */

import { IMAGE_DIR, type LibraryBackend } from "./library.ts";
import { base64FromBytes, bytesFromBase64 } from "./zip.ts";
import { newId } from "../model/randomizer.ts";

/**
 * The backend the library is on. Pictures belong to the library, so moving the
 * library takes them along.
 */
let imageBackend: LibraryBackend | null = null;

/**
 * One object URL per picture, kept for the life of the page: a wheel asks for
 * the same picture every frame, and a URL per ask would leak one per frame.
 */
const imageUrls = new Map<string, string>();
/** Reads still in flight, so two asks make one read. */
const imageLoads = new Map<string, Promise<string | null>>();
/**
 * Ids looked for and not found. An outcome can outlive its picture, and a wheel
 * landing on it would otherwise read the backend every frame. Cleared when the
 * picture is put back or the library changes.
 */
const imageMisses = new Set<string>();
/**
 * The file each picture is stored under, by id, built once per backend from one
 * listing. A store may hold pictures of any kind named `.png`, so the name is
 * looked up, not guessed.
 */
let imageNames: Promise<Map<string, string>> | null = null;

/** Called once when the library opens, and again if the library moves. */
export function useImageStore(backend: LibraryBackend): void {
  if (imageBackend === backend) return;
  for (const url of imageUrls.values()) URL.revokeObjectURL(url);
  imageUrls.clear();
  imageLoads.clear();
  imageMisses.clear();
  imageNames = null;
  imageBackend = backend;
}

/** Which of the four extensions this store holds each picture under. */
function imageNameMap(): Promise<Map<string, string>> {
  if (imageNames) return imageNames;
  const backend = imageBackend;
  imageNames = (async () => {
    const names = new Map<string, string>();
    if (!backend) return names;
    const entries = await backend.list(IMAGE_DIR).catch(() => []);
    for (const entry of entries) {
      if (entry.kind !== "file" || !PICTURE_FILE.test(entry.name)) continue;
      names.set(imageIdFromName(entry.name), entry.name);
    }
    return names;
  })();
  return imageNames;
}

/** The four kinds the store takes; `zip.ts` accepts the same set. */
const PICTURE_FILE = /\.(png|jpe?g|webp|gif)$/i;

export function imageIdFromName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "");
}

/** What a new picture of these bytes should be called. */
function imageFileName(id: string, bytes: Uint8Array): string {
  const type = imageMediaType(bytes);
  const ext = type === "image/jpeg" ? "jpg" : type === "image/gif" ? "gif" : type === "image/webp" ? "webp" : "png";
  return `${id}.${ext}`;
}

/** Where a picture already in the store lives, or null if it is not there. */
async function imageFilePath(id: string): Promise<string | null> {
  const name = (await imageNameMap()).get(id);
  return name ? `${IMAGE_DIR}/${name}` : null;
}

/** The file name a picture is stored under, for an archive entry. */
export async function imageStoredName(id: string): Promise<string | null> {
  return (await imageNameMap()).get(id) ?? null;
}

/**
 * What kind of picture these bytes are. A data: URL must say, or the browser
 * will not draw it.
 */
function imageMediaType(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return "image/webp";
  return "image/png";
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
  const names = await imageNameMap();
  // Replacing keeps the existing name, so a picture is never stored under two
  // extensions.
  const name = names.get(id) ?? imageFileName(id, bytes);
  await imageBackend.writeBytes(`${IMAGE_DIR}/${name}`, bytes);
  names.set(id, name);
  // It is there now, so anyone who asked before and was told no may ask again.
  imageMisses.delete(id);
}

/** The bytes, or null when there is no such picture. */
export async function imageBytes(id: string): Promise<Uint8Array | null> {
  if (!imageBackend || !id) return null;
  const path = await imageFilePath(id);
  if (!path) return null;
  try {
    return await imageBackend.readBytes(path);
  } catch {
    return null;
  }
}

/** A URL to draw with, made once per picture. */
export async function imageUrl(id: string): Promise<string | null> {
  const known = imageUrls.get(id);
  if (known) return known;
  if (imageMisses.has(id)) return null;
  const inFlight = imageLoads.get(id);
  if (inFlight) return inFlight;
  const load = (async () => {
    const bytes = await imageBytes(id);
    if (!bytes) {
      imageMisses.add(id);
      return null;
    }
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
 * The URL if it is already made, else null. Drawing a wheel is synchronous, so
 * it draws the segment without its picture and `imageUrl` warms the cache for
 * the next draw.
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
  imageMisses.add(id);
  const url = imageUrls.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    imageUrls.delete(id);
  }
  if (!imageBackend) return;
  const names = await imageNameMap();
  const name = names.get(id);
  names.delete(id);
  if (name) await imageBackend.remove(`${IMAGE_DIR}/${name}`).catch(() => {});
}

/**
 * Delete the pictures nothing points at any more, and return how many went.
 * Deleting a wheel leaves its pictures for this sweep: another wheel may use
 * them, and an undo must bring the wheel back whole.
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
    if (entry.kind !== "file" || !PICTURE_FILE.test(entry.name)) continue;
    const id = imageIdFromName(entry.name);
    if (usedIds.has(id)) continue;
    await deleteImage(id);
    gone++;
  }
  return gone;
}
