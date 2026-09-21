/**
 * The picture an outcome can carry.
 *
 * A game master shows the table what they have met: the wheel lands on
 * "Owlbear" and there is an owlbear. The bytes live in the image store beside
 * the library, not in the randomizer's file, so a wheel of a dozen portraits
 * is still a small readable JSON.
 */

import { IMAGE_MAX_EDGE } from "../../model/randomizer.ts";
import { imageUrl, imageUrlSync, putImage } from "../../storage/images.ts";
import { button, h } from "../dom.ts";

/**
 * A picture chosen by a person, cut down to something a screen can use: a
 * 4000px photograph from a phone is four megabytes of library for pixels
 * nobody sees.
 */
export async function shrinkForWheel(file: File): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size < 400_000) {
    bitmap.close();
    return new Uint8Array(await file.arrayBuffer());
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    return new Uint8Array(await file.arrayBuffer());
  }
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  // A photograph re-encoded as PNG is several times the size of the JPEG it
  // came from, and the library carries every byte of it. WebP is a fraction
  // of either. Anything that might have transparency stays PNG, where a
  // lossy round trip would show.
  const photo = file.type === "image/jpeg" || file.type === "image/webp";
  const type = photo ? "image/webp" : "image/png";
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.85));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : new Uint8Array(await file.arrayBuffer());
}

export interface PictureCellOptions {
  /** The picture this outcome has now, if any. */
  current: () => string | undefined;
  /** What this picture is of, for the screen reader. */
  subject: () => string;
  onChange: (id: string | undefined) => void;
}

/** Add, replace or remove one outcome's picture. */
export function pictureCell(opts: PictureCellOptions): HTMLElement {
  const holder = h("span", { class: "picture-cell" });
  const input = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", style: { display: "none" }, "aria-label": `Picture for ${opts.subject()}` });

  input.addEventListener("change", () => {
    const file = (input as HTMLInputElement).files?.[0];
    (input as HTMLInputElement).value = "";
    if (!file) return;
    void (async () => {
      const id = await putImage(await shrinkForWheel(file));
      opts.onChange(id);
    })();
  });

  function render(): void {
    const id = opts.current();
    holder.replaceChildren(input);
    if (!id) {
      holder.append(button("＋", () => input.click(), { class: "ghost icon-button add-picture", "aria-label": `Add a picture to ${opts.subject()}` }));
      return;
    }
    const url = imageUrlSync(id);
    if (!url) {
      // Not read from the store yet: show the slot, then fill it in. A null
      // answer means the picture is gone — say so and stop, because rendering
      // again would ask again, and get the same answer, for ever.
      void imageUrl(id).then((found) => {
        if (found) render();
        else renderMissing();
      });
      holder.append(h("span", { class: "faint", text: "…" }));
      return;
    }
    const thumb = h("img", { class: "picture-thumb", src: url, alt: `Picture for ${opts.subject()}` });
    thumb.addEventListener("click", () => input.click());
    holder.append(
      thumb,
      // The picture leaves the outcome; the bytes are swept up when the editor
      // closes, because the same picture may be on another outcome.
      button("✕", () => opts.onChange(undefined), { class: "ghost icon-button remove-picture", "aria-label": `Remove the picture from ${opts.subject()}` }),
    );
  }

  /**
   * The outcome still names a picture, but the store has not got it: the file
   * was deleted from the library folder, or an archive arrived without it.
   * The buttons stay, so it can be replaced or the reference dropped.
   */
  function renderMissing(): void {
    holder.replaceChildren(
      input,
      h("span", { class: "faint picture-missing", text: "Picture missing", title: "The picture this outcome points at is not in the library" }),
      button("＋", () => input.click(), { class: "ghost icon-button add-picture", "aria-label": `Replace the missing picture for ${opts.subject()}` }),
      button("✕", () => opts.onChange(undefined), { class: "ghost icon-button remove-picture", "aria-label": `Remove the missing picture from ${opts.subject()}` }),
    );
  }

  render();
  return holder;
}
