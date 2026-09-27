/**
 * Hash routing. Hashes rather than paths so the single-file build works from
 * disk; a fragment is also never sent to the server, so links that carry a
 * wheel tell the host nothing.
 */

export type Route =
  | { name: "play"; params: LinkParams }
  | { name: "randomizer"; path: string; params: LinkParams }
  | { name: "byId"; id: string; params: LinkParams }
  /**
   * A randomizer carried inside the link (`payload` is the `w` value). `quick`
   * marks a quick wheel's own address: the play screen with the text back in its
   * box.
   */
  | { name: "linked"; payload: string; params: LinkParams; quick?: true }
  /** `from` is the address of the screen that opened this editor, for Back. */
  | { name: "edit"; path: string; from?: string; params: LinkParams }
  | { name: "library"; params: LinkParams }
  | { name: "import"; params: LinkParams }
  | { name: "history"; params: LinkParams }
  | { name: "settings"; params: LinkParams };

export interface LinkParams {
  /** Roll the moment the page opens, for a link on a slide. */
  roll: boolean;
  /** Open straight into the full-screen result view. */
  present: boolean;
}

const NO_PARAMS: LinkParams = { roll: false, present: false };

function readParams(query: string): LinkParams {
  const search = new URLSearchParams(query);
  const on = (key: string) => {
    if (!search.has(key)) return false;
    const value = (search.get(key) ?? "").toLowerCase();
    return value !== "0" && value !== "false" && value !== "no";
  };
  return { roll: on("roll"), present: on("present") };
}

/**
 * `decodeURIComponent` throws on a malformed escape; a bad address must not stop
 * the app rendering.
 */
function decodeArg(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch (e) {
    if (e instanceof URIError) return null;
    throw e;
  }
}

export function parseRoute(hash: string): Route {
  const clean = hash.replace(/^#\/?/, "");
  const queryAt = clean.indexOf("?");
  const withoutQuery = queryAt < 0 ? clean : clean.slice(0, queryAt);
  const query = queryAt < 0 ? "" : clean.slice(queryAt + 1);
  const params = queryAt < 0 ? NO_PARAMS : readParams(query);

  const [head, ...rest] = withoutQuery.split("/");
  const arg = decodeArg(rest.join("/"));
  switch (head) {
    case "roll": {
      // The payload is base64url, which URLSearchParams leaves alone, but a
      // deck program may have escaped it on the way in.
      const search = new URLSearchParams(query);
      const w = search.get("w") ?? "";
      if (!w) return { name: "play", params };
      return search.get("quick") === "1" ? { name: "linked", payload: w, params, quick: true } : { name: "linked", payload: w, params };
    }
    case "r":
      return arg ? { name: "randomizer", path: arg, params } : { name: "play", params };
    case "id":
      return arg ? { name: "byId", id: arg, params } : { name: "play", params };
    case "edit": {
      if (!arg) return { name: "library", params };
      const from = new URLSearchParams(query).get("from");
      return from ? { name: "edit", path: arg, from, params } : { name: "edit", path: arg, params };
    }
    case "library":
      return { name: "library", params };
    case "import":
      return { name: "import", params };
    case "history":
      return { name: "history", params };
    case "settings":
      return { name: "settings", params };
    default:
      return { name: "play", params };
  }
}

/**
 * The address of an editor. `from` is itself a whole address and may carry its
 * own `from`, so Back unwinds one step at a time.
 */
export function editHash(path: string, from?: string): string {
  const base = `#/edit/${encodeURIComponent(path)}`;
  return from ? `${base}?from=${encodeURIComponent(from)}` : base;
}

/**
 * Where an editor's `from` leads, if Back may go there: only a randomizer or
 * another editor still in the library. The address is rebuilt from the parsed
 * route, dropping anything else it carries (such as `roll=1`).
 */
export function referrer(route: Route, exists: (path: string) => boolean): string | null {
  if (route.name !== "edit" || !route.from || !route.from.startsWith("#/")) return null;
  const target = parseRoute(route.from);
  if (target.name === "randomizer" && exists(target.path)) return `#/r/${encodeURIComponent(target.path)}`;
  if (target.name === "edit" && exists(target.path)) return editHash(target.path, target.from);
  return null;
}

/**
 * Where Back goes: an editor returns to the screen that opened it, else to the
 * randomizer it edits; anywhere else goes to the last randomizer played, if it
 * still exists, else the play screen. A route, not browser history, so it never
 * bounces between settings pages or out of the app.
 */
export function backTarget(route: Route, lastPath: string | null, exists: (path: string) => boolean): string {
  if (route.name === "edit") return referrer(route, exists) ?? `#/r/${encodeURIComponent(route.path)}`;
  if (lastPath && exists(lastPath)) return `#/r/${encodeURIComponent(lastPath)}`;
  return "#/";
}

export interface SlideLinkOptions {
  roll?: boolean;
  present?: boolean;
}

/**
 * A link to paste onto a slide. It names the randomizer by id, not path, so
 * renaming or moving it does not break decks that point at it.
 */
export function slideLink(base: string, id: string, options: SlideLinkOptions = {}): string {
  const query: string[] = [];
  if (options.roll) query.push("roll=1");
  if (options.present) query.push("present=1");
  const suffix = query.length ? `?${query.join("&")}` : "";
  return `${stripHash(base)}#/id/${encodeURIComponent(id)}${suffix}`;
}

/**
 * A link with the wheel inside it: longer and frozen at today's version, but it
 * works anywhere (see model/link.ts).
 */
export function wheelLink(base: string, payload: string, options: SlideLinkOptions = {}): string {
  const query = [`w=${payload}`];
  if (options.roll) query.push("roll=1");
  if (options.present) query.push("present=1");
  return `${stripHash(base)}#/roll?${query.join("&")}`;
}

function stripHash(url: string): string {
  const at = url.indexOf("#");
  return at < 0 ? url : url.slice(0, at);
}

/** Where this copy of Orangey is being served from. */
export function appBase(): string {
  return stripHash(`${location.origin}${location.pathname}${location.search}`);
}

/**
 * Slide links must be http(s): browsers will not follow a link from a web page
 * to a local file.
 */
export function isLinkableBase(base: string): boolean {
  return /^https?:\/\//i.test(base);
}

export function navigate(hash: string, replace = false): void {
  if (replace) history.replaceState(null, "", hash);
  else location.hash = hash;
  if (replace) window.dispatchEvent(new HashChangeEvent("hashchange"));
}

export function currentRoute(): Route {
  return parseRoute(location.hash);
}
