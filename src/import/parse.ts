/**
 * Delimited-text parsing (plan C7).
 *
 * RFC 4180 for the quoting rules — doubled quotes inside quoted fields,
 * delimiters and newlines allowed inside quotes — plus the practical bits:
 * a UTF-8 BOM, CRLF or LF, and a "delimiter" that is really a run of spaces.
 */

export type Delimiter = "," | ";" | "\t" | "|" | "  ";

export const DELIMITERS: Delimiter[] = [",", ";", "\t", "|", "  "];

export function delimiterName(d: Delimiter): string {
  return { ",": "comma", ";": "semicolon", "\t": "tab", "|": "pipe", "  ": "spaces" }[d];
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Split into rows of fields. Blank lines are dropped. */
export function parseDelimited(text: string, delimiter: Delimiter): string[][] {
  const src = stripBom(text).replace(/\r\n?/g, "\n");
  if (delimiter === "  ") return parseWhitespace(src);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    if (row.length > 1 || row[0].trim() !== "") rows.push(row);
    row = [];
  };

  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field.trim() === "") {
      quoted = true;
      field = "";
      i++;
      continue;
    }
    if (ch === delimiter) {
      endField();
      i++;
      continue;
    }
    if (ch === "\n") {
      endRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== "" || row.length > 0) endRow();
  return rows.map((r) => r.map((f) => f.trim()));
}

function parseWhitespace(src: string): string[][] {
  return src
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => l.trim().split(/\s{2,}|\t+/).map((f) => f.trim()));
}

/** Does this text look like JSON rather than a table? */
export function looksLikeJson(text: string): boolean {
  const t = stripBom(text).trim();
  return t.startsWith("{") || t.startsWith("[");
}
