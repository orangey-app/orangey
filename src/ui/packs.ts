/**
 * Packs on screen: publishing a folder as one, installing one from a file or a
 * link, updating it, its credit, and the editable copy (model/pack.ts has the
 * rules, storage/library.ts the files).
 */

import { slugify } from "../model/file.ts";
import { compareVersions, creditLine, nextVersion, readManifest, type InstalledPack, type NeededPack, type PackManifest } from "../model/pack.ts";
import { installedPackOf, neededPacks } from "./storage-actions.ts";
import { newId } from "../model/randomizer.ts";
import { ValidationError } from "../model/validate.ts";
import type { LibraryNode } from "../storage/library.ts";
import { LIBRARY_FILE_SUFFIX, parseLibrary, planExport, serializeLibrary, type ReadLibraryFile } from "../storage/libraryfile.ts";
import { parent, segments } from "../storage/paths.ts";
import { button, download, h, openDialog } from "./dom.ts";
import { navigate } from "./router.ts";
import { state } from "./state.ts";
import type { View } from "./view.ts";

export const LICENCES = ["CC BY 4.0", "CC BY-SA 4.0", "CC BY-NC 4.0", "CC BY-NC-SA 4.0", "CC0 1.0", "MIT", "All rights reserved"];

// ---- publishing -----------------------------------------------------------------

/**
 * "Publish as a pack…" on a folder: asks for the details (remembered in the
 * folder for next time, with the version moved on by one), then downloads the
 * pack file to put on a website, itch.io or a forum.
 */
export function publishPack(folder: LibraryNode, opener?: HTMLElement | null): void {
  const before: Partial<PackManifest> = folder.pack ?? {};
  const input = (name: string, label: string, value: string, extra: Record<string, string> = {}) => {
    const el = h("input", { type: "text", name, value, "aria-label": label, ...extra });
    return { el, field: h("label", { class: "field" }, h("span", { class: "field-label", text: label }), el) };
  };
  const title = input("title", "Title", before.title ?? folder.name);
  const author = input("author", "Author", before.author ?? "");
  const version = input("version", "Version", before.version ? nextVersion(before.version) : "1.0", { inputmode: "decimal" });
  const licence = input("licence", "Licence", before.licence ?? "", { list: "pack-licences", placeholder: "CC BY 4.0" });
  const homepage = input("homepage", "Web page (optional)", before.homepage ?? "", { type: "url", placeholder: "https://" });
  const description = h("textarea", { name: "description", "aria-label": "Description", rows: "3" });
  description.value = before.description ?? "";
  const snapshots = h("input", { type: "checkbox", name: "allowSnapshots" });
  snapshots.checked = before.allowSnapshots !== false;
  const problem = h("p", { class: "form-problem", role: "alert" });
  problem.hidden = true;

  const dialog = h("dialog", { class: "pack-dialog", "aria-label": "Publish as a pack" },
    h("form", { method: "dialog", onsubmit: (e: Event) => { e.preventDefault(); submit(); } },
      h("h2", { text: `Publish “${folder.name}” as a pack` }),
      h("p", { class: "faint", text: "A pack is a file with this folder's randomizers and your name on it. People install it in one step, see your credit wherever they roll, and get your next version as an update." }),
      title.field, author.field, version.field, licence.field,
      h("datalist", { id: "pack-licences" }, ...LICENCES.map((l) => h("option", { value: l }))),
      homepage.field,
      h("label", { class: "field" }, h("span", { class: "field-label", text: "Description (optional)" }), description),
      h("label", { class: "check" }, snapshots, h("span", { text: " Let writing apps keep a copy in a player's journal, so it rolls on a computer without this pack" })),
      problem,
      h("div", { class: "row gap-l" },
        h("div", { class: "spacer" }),
        button("Cancel", () => dialog.close(), { type: "button" }),
        h("button", { type: "submit", class: "primary" }, "Publish"),
      ),
    ),
  );

  function submit(): void {
    let pack: PackManifest;
    try {
      pack = readManifest({
        id: before.id ?? newId(),
        title: title.el.value,
        author: author.el.value,
        version: version.el.value,
        licence: licence.el.value,
        homepage: homepage.el.value,
        description: description.value,
        allowSnapshots: snapshots.checked,
      });
    } catch (e) {
      problem.hidden = false;
      problem.textContent = e instanceof ValidationError ? e.issues.map((i) => `${i.path.replace(/^pack\./, "")} ${i.message}`).join("; ") : String(e);
      return;
    }
    dialog.close();
    void writePack(folder, pack);
  }

  openDialog(dialog, opener);
  (before.author ? version.el : author.el).focus();
}

async function writePack(folder: LibraryNode, pack: PackManifest): Promise<void> {
  await state.library.setPackDetails(folder.path, pack);
  const node = state.library.find(folder.path) ?? folder;
  const sources = state.library.files().map((n) => ({ path: n.path, randomizer: n.randomizer ?? undefined }));
  // Someone else's installed pack that this one uses stays out, and is named as needed.
  const plan = planExport(sources, state.library.files(node).map((n) => n.path), node.path, (p) => installedPackOf(state.library, p));
  const needs = neededPacks(state.library, plan.leftOut.keys());
  const folders = new Set<string>();
  for (const f of state.library.folders(node)) if (f !== node) folders.add(f.path.slice(node.path.length + 1));
  for (const e of plan.entries) {
    const parts = segments(parent(e.path));
    for (let i = 1; i <= parts.length; i++) folders.add(parts.slice(0, i).join("/"));
  }
  const text = serializeLibrary(pack.title, new Date().toISOString(), [...folders].sort(), plan.entries, pack, needs);
  download(`${slugify(pack.title)}-${pack.version}${LIBRARY_FILE_SUFFIX}`, text, "application/json");
  state.toast(
    `Published ${pack.title} ${pack.version}: ${plan.entries.length} randomizer${plan.entries.length === 1 ? "" : "s"}.` +
      (plan.linked ? ` ${plan.linked} of them are outside the folder and came along because something in it goes to them; move them in to keep the pack tidy.` : "") +
      (plan.pictures ? ` ${plan.pictures} picture${plan.pictures === 1 ? " was" : "s were"} left out.` : "") +
      (needs.length ? ` It uses ${needs.map((n) => n.title).join(", ")}, which ${needs.length === 1 ? "is" : "are"} not copied in: players install ${needs.length === 1 ? "it" : "them"} too.` : ""),
  );
}

// ---- installing and updating ----------------------------------------------------

/** A pack read and waiting for the person to say yes: from a dropped file, or fetched from a link. */
let waiting: { read: ReadLibraryFile; source?: string } | null = null;

/**
 * Packs an import needed and this library does not have (a backup's installed
 * packs, or a file that uses one). Kept until each is installed or the person
 * says later, so installing one returns here for the next.
 */
let needed: NeededPack[] = [];

const stillNeeded = () => (needed = needed.filter((p) => !state.library.findPack(p.id)));

/**
 * After an import: when it named packs this library lacks, shows the screen
 * that offers them and returns true; otherwise false, and nothing changes.
 */
export function offerNeeded(packs: readonly NeededPack[] | undefined): boolean {
  const known = new Set(needed.map((p) => p.id));
  needed = [...needed, ...(packs ?? []).filter((p) => !known.has(p.id))];
  if (stillNeeded().length === 0) return false;
  // Already on #/install (a pack just installed from a dropped file): replacing
  // the address is what makes the screen draw again.
  navigate("#/install", location.hash === "#/install");
  return true;
}

function neededCard(): Node[] {
  const out: Node[] = [
    h("h2", { text: needed.length === 1 ? "One pack to install again" : `${needed.length} packs to install again` }),
    h("p", { text: "What you brought in uses these packs. Packs are not copied into backups and exports: they are their authors' to hand out. Installing one again gives back the tables that point at it." }),
  ];
  const list = h("ul", { class: "needed-packs" });
  for (const p of needed) {
    list.append(h("li", {},
      credit(p),
      p.source
        ? button("Install from its link", () => navigate(`#/install?from=${encodeURIComponent(p.source!)}`), { class: "primary install-needed" })
        : h("p", { class: "faint", text: "Installed from a file: find that file (or ask its author) and drop it on Import." }),
    ));
  }
  out.push(list, h("div", { class: "row gap-s" }, button("Later", () => { needed = []; navigate("#/library"); }, { class: "ghost" })));
  return out;
}

/** Shows the install screen for a pack read from a file or pasted text. */
export function offerPack(read: ReadLibraryFile, source?: string): void {
  waiting = { read, source };
  navigate("#/install");
}

/** Where a pack's file can be fetched from, as a link to install it: `…/#/install?from=<address>`. */
export function installLink(appBase: string, from: string): string {
  return `${appBase}#/install?from=${encodeURIComponent(from)}`;
}

/**
 * The install screen. With `from`, the pack is fetched from that address first.
 * Nothing is installed until the person presses the button: a link alone
 * never writes into anyone's library.
 */
export function createInstallView(from: string | null): View {
  const el = h("div", { class: "card install-pack", "aria-busy": "true" });
  let gone = false;

  const show = (read: ReadLibraryFile, source?: string) => {
    if (gone) return;
    el.removeAttribute("aria-busy");
    el.replaceChildren(...installCard(read, source));
  };
  const fail = (title: string, ...more: (Node | string)[]) => {
    if (gone) return;
    el.removeAttribute("aria-busy");
    el.replaceChildren(h("h2", { text: title }), ...more.map((m) => (typeof m === "string" ? h("p", { text: m }) : m)));
  };

  if (from) {
    el.append(h("p", { class: "faint", text: "Fetching the pack…" }));
    void fetchPack(from).then(
      (read) => show(read, from),
      (e: Error) =>
        fail("That pack could not be fetched", e.message,
          h("p", {}, "You can download it yourself and drop the file on the Import page: ", h("a", { href: from, target: "_blank", rel: "noopener", text: from })),
          button("Go to Import", () => navigate("#/import"))),
    );
  } else if (waiting) {
    const w = waiting;
    waiting = null;
    show(w.read, w.source);
  } else if (stillNeeded().length) {
    el.removeAttribute("aria-busy");
    el.replaceChildren(...neededCard());
  } else {
    fail("No pack to install", "Drop a pack file on the Import page, or open an install link.", button("Go to Import", () => navigate("#/import")));
  }
  return { el, destroy: () => void (gone = true) };
}

async function fetchPack(from: string): Promise<ReadLibraryFile> {
  let url: URL;
  try {
    url = new URL(from);
  } catch {
    throw new Error("The link does not hold a web address.");
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") throw new Error("Packs are fetched over https only.");
  let text: string;
  try {
    const res = await fetch(url, { credentials: "omit" });
    if (!res.ok) throw new Error(`The site answered ${res.status}.`);
    text = await res.text();
  } catch (e) {
    // A refused cross-site fetch looks the same as no network, so both are said.
    throw new Error(e instanceof TypeError ? "The site did not let Orangey fetch the file (or there is no connection)." : (e as Error).message);
  }
  const read = parseLibrary(text);
  if (!read.pack) throw new Error("That file is a library file, not a pack: it says nothing of who made it or which version it is.");
  return read;
}

/** What the person sees before saying yes: the credit, what is in it, and what will happen. */
function installCard(read: ReadLibraryFile, source?: string): Node[] {
  const pack = read.pack!;
  const here = state.library.findPack(pack.id);
  const out: Node[] = [h("h2", { text: pack.title }), credit(pack)];
  if (pack.description) out.push(h("p", { class: "pack-description", text: pack.description }));
  const count = read.entries.length;
  out.push(h("p", { class: "faint", text: `${count} randomizer${count === 1 ? "" : "s"}${read.failed.length ? `, and ${read.failed.length} that could not be read` : ""}.` }));

  const done = (folder: string) => {
    if (!state.prefs.expandedFolders.includes(folder)) void state.savePrefs({ expandedFolders: [...state.prefs.expandedFolders, folder] });
    // A pack that uses another, or the next pack a backup needs: offered now.
    if (!offerNeeded(read.needs)) navigate("#/library");
  };

  if (!here?.pack) {
    out.push(
      h("p", { text: "It goes into a folder of its own and stays as its author made it. To change it, make an editable copy." }),
      h("div", { class: "row gap-s" },
        button("Install pack", async () => {
          const { folder } = await state.library.installPack(read, { source });
          state.toast(`Installed ${pack.title} ${pack.version} in “${folder}”`);
          done(folder);
        }, { class: "primary install-button" }),
        button("Cancel", () => navigate("#/library"), { class: "ghost" }),
      ),
    );
    return out;
  }

  const installed = here.pack;
  const order = compareVersions(pack.version, installed.version);
  const names = (rs: string[]) => (rs.length > 6 ? `${rs.slice(0, 6).join(", ")} and ${rs.length - 6} more` : rs.join(", "));
  const local = (id: string) => installed.ids?.[id] ?? id;
  const now = state.library.files(here).flatMap((f) => (f.randomizer ? [f.randomizer] : []));
  const incoming = new Set(read.entries.map((e) => local(e.file.randomizer.id)));
  const nowIds = new Set(now.map((r) => r.id));
  const added = read.entries.filter((e) => !nowIds.has(local(e.file.randomizer.id))).map((e) => e.file.randomizer.name);
  const removed = now.filter((r) => !incoming.has(r.id)).map((r) => r.name);

  out.push(h("p", {
    class: "pack-state",
    text: order > 0
      ? `You have version ${installed.version} in “${here.path}”. This is ${pack.version}.`
      : order === 0
        ? `You have this version (${installed.version}) already, in “${here.path}”.`
        : `You have a newer version (${installed.version}) in “${here.path}”. This is ${pack.version}.`,
  }));
  if (read.failed.length) {
    // Updating from a damaged file would delete what it failed to carry.
    out.push(
      h("p", { class: "warning", text: `This file has ${read.failed.length} randomizer${read.failed.length === 1 ? "" : "s"} that could not be read (${names(read.failed.map((f) => f.path))}), so it cannot update the pack: that would remove them. Ask its author for a fixed file.` }),
      h("div", { class: "row gap-s" }, button("Back to the library", () => navigate("#/library"), { class: "ghost" })),
    );
    return out;
  }
  if (added.length) out.push(h("p", { text: `New: ${names(added)}.` }));
  if (removed.length) out.push(h("p", { class: "warning", text: `No longer in it: ${names(removed)}. Updating removes ${removed.length === 1 ? "it" : "them"} from your library.` }));
  const label = order > 0 ? `Update to ${pack.version}` : order === 0 ? "Install it again" : `Go back to ${pack.version}`;
  out.push(h("div", { class: "row gap-s" },
    button(label, async () => {
      const result = await state.library.updatePack(here.path, read, { source });
      state.toast(`${pack.title} is now ${pack.version}: ${result.kept} kept, ${result.added} new, ${result.removed} removed`);
      done(here.path);
    }, { class: order > 0 ? "primary update-button" : "update-button" }),
    button("Cancel", () => navigate("#/library"), { class: "ghost" }),
  ));
  return out;
}

// ---- credit -----------------------------------------------------------------------

/** "Delve Oracles by A. Writer · v1.0 · CC BY 4.0", with the web page as a link. */
export function credit(pack: PackManifest): HTMLElement {
  return h("p", { class: "pack-credit" },
    creditLine(pack),
    pack.homepage ? h("span", {}, " · ", h("a", { href: pack.homepage, target: "_blank", rel: "noopener", text: "web page" })) : null,
  );
}

/** "About this pack": the credit, the description, and where updates come from. */
export function aboutPack(folder: LibraryNode, opener?: HTMLElement | null): void {
  const pack = folder.pack as InstalledPack;
  const dialog = h("dialog", { class: "pack-dialog", "aria-label": pack.title },
    h("h2", { text: pack.title }),
    credit(pack),
    pack.description ? h("p", { class: "pack-description", text: pack.description }) : null,
    pack.installed ? h("p", { class: "faint", text: `Installed ${new Date(pack.installed).toLocaleDateString()}${pack.source ? ` from ${pack.source}` : ""}. Drop a newer version of its file on the Import page to update it.` }) : null,
    pack.allowSnapshots === false ? h("p", { class: "faint", text: "Its author asks writing apps not to keep copies of it in journals." }) : null,
    h("div", { class: "row gap-l" },
      h("div", { class: "spacer" }),
      pack.source ? button("Check for an update", () => { dialog.close(); navigate(`#/install?from=${encodeURIComponent(pack.source!)}`); }) : null,
      button("Close", () => dialog.close(), { class: "primary" }),
    ),
  );
  openDialog(dialog, opener);
}

/** "Make an editable copy": the pack's randomizers as the user's own. */
export async function editableCopy(folder: string): Promise<string> {
  const copy = await state.library.copyPack(folder);
  state.toast(`“${copy}” is yours to change; updates to the pack leave it alone.`);
  return copy;
}
