/** Turning a RollResult into the strings the UI and screen readers use. */

import type { RollResult, TermResult } from "./evaluate.ts";

function termDetail(t: TermResult): string {
  if (!t.dice) return t.text;
  const dice = t.dice.map((d) => (d.kept ? String(d.value) : `(${d.value})`)).join(", ");
  return `${t.text} [${dice}]`;
}

/** One line for the history log: "4d6kh3 [6, 5, (2), 4] = 15". */
export function formatResult(r: RollResult): string {
  const detail = r.terms
    .map((t, i) => `${i === 0 ? (t.sign < 0 ? "-" : "") : t.sign < 0 ? " - " : " + "}${termDetail(t)}`)
    .join("");
  return `${detail} = ${r.total}`;
}

/** Spoken form; dropped dice are named rather than shown in brackets. */
export function speakResult(r: RollResult): string {
  const parts = r.terms.map((t) => {
    if (!t.dice) return `${t.sign < 0 ? "minus " : ""}${t.value}`;
    const kept = t.dice.filter((d) => d.kept).map((d) => d.value);
    const dropped = t.dice.filter((d) => !d.kept).map((d) => d.value);
    let s = `${t.text}: ${kept.join(", ")}`;
    if (dropped.length) s += `, dropping ${dropped.join(", ")}`;
    return `${t.sign < 0 ? "minus " : ""}${s}`;
  });
  return `${parts.join("; ")}. Total ${r.total}.`;
}

/** Compact form for the big result panel. */
export function totalText(r: RollResult): string {
  return String(r.total);
}
