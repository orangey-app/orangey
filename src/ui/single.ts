/**
 * Which build this is, and where the other one lives. The site build serves
 * `orangey.html` beside `index.html` for Settings to offer as a download
 * (fetched relatively, so any base path works); the single-file build marks
 * itself with a meta tag.
 */

export const SINGLE_FILE_NAME = "orangey.html";

/** The GitHub home; releases carry the single file for people who want a copy. */
export const REPO_URL = "https://github.com/orangey-app/orangey";

export function isSingleFile(doc: Document = document): boolean {
  return doc.querySelector('meta[name="orangey-build"]')?.getAttribute("content") === "single";
}

export function releasesUrl(): string {
  return `${REPO_URL}/releases/latest`;
}
