/**
 * The dialog that hands over a link for a slide.
 *
 * Out of `play.ts` because it is a self-contained piece of explaining: two
 * kinds of link with different trade-offs, a size warning, and the awkward
 * truth that a copy of Orangey opened from a file cannot be linked to at all.
 * None of that is about playing.
 */

import type { Randomizer } from "../../model/randomizer.ts";
import type { LibraryNode } from "../../storage/library.ts";
import { button, h, openDialog, setChildren } from "../dom.ts";
import { state } from "../state.ts";
import { appBase, isLinkableBase, slideLink, wheelLink } from "../router.ts";
import { LINK_HARD_LIMIT, LINK_SOFT_LIMIT, encodeRandomizer } from "../../model/link.ts";

/**
 * Two kinds of link, side by side.
 *
 * "With the wheel inside" carries the randomizer in the address, so it
 * rolls on anyone's machine and keeps rolling whatever happens to the
 * library — frozen at today's version, and longer. "To my library" is short
 * and follows every edit, but only works where the library is. The first is
 * offered first, because it is what most people pasting into a deck mean.
 */
export async function openLinkDialog(randomizer: Randomizer, node: LibraryNode | null): Promise<void> {
  // Where the keyboard came from, so it goes back there on close.
  const opener = document.activeElement as HTMLElement | null;
  const base = appBase();
  const rollOnOpen = h("input", { type: "checkbox", checked: true });
  const fullScreen = h("input", { type: "checkbox", checked: true });
  const field = h("input", { type: "text", readonly: true, "aria-label": "Link to paste onto a slide", spellcheck: "false" });
  const note = h("p", { class: "faint link-note" });
  const sizeNote = h("p", { class: "warning link-size" });

  let payload: string | null = null;
  try {
    payload = await encodeRandomizer(randomizer);
  } catch {
    payload = null;
  }
  const embeddedLength = payload === null ? Infinity : wheelLink(base, payload, { roll: true, present: true }).length;
  const canEmbed = payload !== null && embeddedLength <= LINK_HARD_LIMIT;
  const canLibrary = node?.randomizer != null;
  if (!canEmbed && !canLibrary) {
    state.toast("This randomizer is too big to put in a link, and it is not in your library.");
    return;
  }

  let kind: "embedded" | "library" = canEmbed ? "embedded" : "library";
  const kinds = h("div", { class: "segmented link-kinds", role: "group", "aria-label": "What the link carries" });

  const refresh = () => {
    const opts = { roll: rollOnOpen.checked, present: fullScreen.checked };
    field.value = kind === "embedded" && payload
      ? wheelLink(base, payload, opts)
      : slideLink(base, node!.randomizer!.id, opts);
    note.textContent = kind === "embedded"
      ? "The wheel travels inside the link, so it works for anyone who opens the deck, on any machine, with nothing installed. It is a snapshot: editing the wheel afterwards does not change decks you have already made."
      : "Short, and it follows every edit you make. It points at the randomizer's identity rather than its file name, so renaming it or moving it to another folder will not break the deck — but it only works on a device where this library is stored.";
    const tooLong = kind === "embedded" && field.value.length > LINK_SOFT_LIMIT;
    sizeNote.hidden = !tooLong;
    if (tooLong) {
      sizeNote.textContent = `This link is ${field.value.length} characters. Slides and PowerPoint will take it, but it is unwieldy to handle;${canLibrary ? " a link to your library would be a few dozen." : " trimming the table would shorten it."}`;
    }
    for (const b of kinds.querySelectorAll("button")) {
      b.setAttribute("aria-pressed", b.dataset.kind === kind ? "true" : "false");
    }
  };

  const kindButton = (value: "embedded" | "library", label: string) => {
    const b = button(label, () => { kind = value; refresh(); }, { class: `link-kind-${value}` });
    b.dataset.kind = value;
    return b;
  };
  setChildren(kinds,
    canEmbed ? kindButton("embedded", "With the wheel inside") : null,
    canLibrary ? kindButton("library", "To my library") : null,
  );

  rollOnOpen.addEventListener("change", refresh);
  fullScreen.addEventListener("change", refresh);
  refresh();

  const copied = h("span", { class: "faint" });
  const dialog = h("dialog", { class: "link-dialog", "aria-label": "Link for a slide" },
    h("h2", { text: "Link for a slide" }),
    h("p", { class: "faint", text:
      `Put this on a shape or an image in Google Slides or PowerPoint. Clicking it during the presentation opens ${randomizer.name} and rolls it; closing the tab returns you to the deck.` }),
    kinds.children.length > 1 ? kinds : null,
    field,
    h("div", { class: "row tight gap-m" },
      h("label", { class: "row tight" }, rollOnOpen, "Roll as soon as it opens"),
      h("label", { class: "row tight" }, fullScreen, "Fill the screen"),
    ),
    isLinkableBase(base)
      ? null
      : h("p", { class: "warning", text:
          "This copy of Orangey is open from a file rather than a web address, so this link will not work from a slide — browsers refuse to follow a link from a web page to a local file. Open the published copy and make the link there." }),
    sizeNote,
    note,
    h("div", { class: "row gap-l" },
      button("Copy", async () => {
        try {
          await navigator.clipboard.writeText(field.value);
          copied.textContent = "Copied";
        } catch {
          field.select();
          copied.textContent = "Press Ctrl+C to copy";
        }
      }, { class: "primary copy-link" }),
      copied,
      h("div", { class: "spacer" }),
      button("Close", () => dialog.close()),
    ),
  );
  openDialog(dialog, opener);
  field.select();
}
