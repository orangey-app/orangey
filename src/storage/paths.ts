/** Library paths: "/"-separated, no leading slash, folders have no trailing slash. */

export const ROOT = "";

export function join(...parts: string[]): string {
  return parts.filter((p) => p !== "" && p !== ROOT).join("/");
}

export function parent(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? ROOT : path.slice(0, i);
}

export function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

export function segments(path: string): string[] {
  return path === ROOT ? [] : path.split("/");
}

export function isInside(path: string, folder: string): boolean {
  if (folder === ROOT) return true;
  return path === folder || path.startsWith(`${folder}/`);
}

/** Folder and file names the user types; keep them usable on every OS. */
export function sanitizeName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+|[. ]+$/g, "")
    .slice(0, 80);
}

export function nameError(name: string): string | null {
  const clean = sanitizeName(name);
  if (clean === "") return "Give it a name";
  if (clean !== name.trim()) return null; // silently cleaned, not an error
  return null;
}

/** Natural sort: "Chapter 2" before "Chapter 10" (decision D11). */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}
