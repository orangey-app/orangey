/**
 * What a drag from the library carries, shared by the library (which starts
 * it) and a board (which takes it).
 *
 * Every drag carries one path as text/plain, which is what a folder and a
 * board have always read. A drag of a selection also carries all of its
 * paths, as JSON under a type of Orangey's own, so a board can take the lot;
 * anything that does not know that type still gets the row that was dragged.
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
