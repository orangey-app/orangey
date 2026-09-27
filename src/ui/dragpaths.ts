/**
 * What a drag from the library carries. Every drag sets one path as text/plain;
 * a drag of a selection also sets all its paths as JSON under
 * `LIBRARY_PATHS_TYPE`, so a board can take the lot.
 */

export const LIBRARY_PATHS_TYPE = "text/orangey-paths";

/** The paths a drop carries: the selection's when it has one, else just `first`. */
export function draggedPaths(raw: string, first: string): string[] {
  if (!raw) return [first];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((p) => typeof p === "string")) return parsed as string[];
  } catch {
    // A drag from somewhere else that happens to use the name: one path.
  }
  return [first];
}
