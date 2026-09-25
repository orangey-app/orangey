/**
 * Hash routing.
 *
 * Hashes rather than paths so that the single-file build works when opened
 * straight from disk, where there is no server to rewrite URLs. Everything
 * after the hash also stays on the device: browsers never send a fragment to
 * the server, so a link that carries settings — or, later, a whole wheel —
 * tells the host nothing.
 */

export type Route =
  | { name: "play"; params: LinkParams }
  | { name: "randomizer"; path: string; params: LinkParams }
  | { name: "byId"; id: string; params: LinkParams }
  /**
   * A randomizer carried inside the link itself; `payload` is the `w` value.
   * `quick` marks a quick wheel's own address: the play screen with the text
   * back in its box, rather than a wheel someone sent. On the route, not in
   * `LinkParams`, because it means nothing anywhere else.
   */
  | { name: "linked"; payload: string; params: LinkParams; quick?: true }
  /**
   * `from` is the address of the screen that opened this editor, when that
   * matters for getting back: a randomizer made from a board's picker or from
   * a wheel's "where does this send you?" would otherwise strand you on its
   * own play screen.
   */
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
 * `decodeURIComponent` throws on a malformed escape ("%", "%zz"), and a throw
 * from the router leaves the app with nothing rendered at all. A bad address
 * is a bad address: treat it as one rather than as a fatal error.
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
 * The address of an editor, remembering where it was opened from.
 *
 * `from` is itself a whole address and may carry a `from` of its own, so a
 * board, then a wheel's editor, then a new randomizer's editor unwinds one
 * step per Back. It is encoded as a single value, which is why it can nest.
 */
export function editHash(path: string, from?: string): string {
  const base = `#/edit/${encodeURIComponent(path)}`;
  return from ? `${base}?from=${encodeURIComponent(from)}` : base;
}

/**
 * Where an editor's `from` leads, if it is somewhere Back may go.
 *
 * Only a randomizer or another editor, and only one still in the library: the
 * address arrives in the URL, so it is rebuilt from the parsed route rather
 * than followed as written. That drops anything else it carries, such as a
 * `roll=1` that would roll the moment you arrived.
 */
export function referrer(route: Route, exists: (path: string) => boolean): string | null {
  if (route.name !== "edit" || !route.from || !route.from.startsWith("#/")) return null;
  const target = parseRoute(route.from);
  if (target.name === "randomizer" && exists(target.path)) return `#/r/${encodeURIComponent(target.path)}`;
  if (target.name === "edit" && exists(target.path)) return editHash(target.path, target.from);
  return null;
}

/**
 * Where Back goes: an editor returns to the screen that opened it when it
 * knows one, and otherwise to the randomizer it edits; anywhere else returns
 * to the one last played, if it is still in the library, and otherwise to the
 * plain play screen. A route, not browser history, so it never bounces
 * between two settings pages or out of the app.
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
 * A link to paste onto a slide.
 *
 * It addresses the randomizer by its id rather than by its path, because a
 * link on a slide outlives any tidying up of the library: renaming a wheel or
 * moving it to another folder changes its file name, and would otherwise
 * quietly break every deck that pointed at it.
 */
export function slideLink(base: string, id: string, options: SlideLinkOptions = {}): string {
  const query: string[] = [];
  if (options.roll) query.push("roll=1");
  if (options.present) query.push("present=1");
  const suffix = query.length ? `?${query.join("&")}` : "";
  return `${stripHash(base)}#/id/${encodeURIComponent(id)}${suffix}`;
}

/**
 * A link with the wheel inside it. Longer than a library link and frozen at
 * today's version, but it works for anyone, anywhere — see model/link.ts.
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
 * A link from a slide has to be an https one: browsers refuse to follow a
 * link from a web page to a local file, so a deck cannot open a downloaded
 * copy of Orangey. The dialog says so rather than handing over a link that
 * will silently do nothing.
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
