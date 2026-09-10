/**
 * Which build this is, and where the other one lives.
 *
 * The site build serves `orangey.html` beside `index.html`, so Settings can
 * offer it as a download. The single-file build marks itself with a meta tag
 * at build time, and Settings says so instead of offering the file it
 * already is.
 */

export const SINGLE_FILE_NAME = "orangey.html";

/** The GitHub home; releases carry the single file for people who want a copy. */
export const REPO_URL = "https://github.com/orangey-app/orangey-app.github.io";

export function isSingleFile(doc: Document = document): boolean {
  return doc.querySelector('meta[name="orangey-build"]')?.getAttribute("content") === "single";
}

export function releasesUrl(): string {
  return `${REPO_URL}/releases/latest`;
}
