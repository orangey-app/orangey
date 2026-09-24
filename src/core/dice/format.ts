/** Turning a RollResult into the strings the UI and screen readers use. */

import type { RollResult, TermResult } from "./evaluate.ts";

/** A Fate die reads as a sign, not as a number between -1 and 1. */
function faceText(t: TermResult, value: number): string {
  if (!t.fate) return String(value);
  return value > 0 ? "+1" : value < 0 ? "-1" : "0";
}

function dieText(t: TermResult, d: { value: number; kept: boolean; rerolled?: boolean; exploded?: boolean }): string {
  const face = `${faceText(t, d.value)}${d.exploded ? "!" : ""}`;
  // A rerolled die reads like a dropped one: it happened, it does not count.
  return d.kept ? face : `(${face})`;
}

function termDetail(t: TermResult): string {
  if (!t.dice) return t.text;
  return `${t.text} [${t.dice.map((d) => dieText(t, d)).join(", ")}]`;
}

/**
 * Is the whole roll a count of successes?
 *
 * Only then does "= 3 successes" make sense. Mixing a success pool with a
 * constant or an ordinary term gives a number that is not a count of
 * anything, so it stays a plain total.
 */
function allSuccesses(r: RollResult): boolean {
  return r.terms.length > 0 && r.terms.every((t) => t.successes === true);
}

function totalWord(r: RollResult): string {
  if (!allSuccesses(r)) return String(r.total);
  return `${r.total} success${r.total === 1 ? "" : "es"}`;
}

/** One line for the history log: "4d6kh3 [6, 5, (2), 4] = 15". */
export function formatResult(r: RollResult): string {
  const detail = r.terms
    .map((t, i) => `${i === 0 ? (t.sign < 0 ? "-" : "") : t.sign < 0 ? " - " : " + "}${termDetail(t)}`)
    .join("");
  return `${detail} = ${totalWord(r)}`;
}

/** Spoken form; dropped dice are named rather than shown in brackets. */
export function speakResult(r: RollResult): string {
  const parts = r.terms.map((t) => {
    if (!t.dice) return `${t.sign < 0 ? "minus " : ""}${t.value}`;
    const kept = t.dice.filter((d) => d.kept).map((d) => faceText(t, d.value));
    const dropped = t.dice.filter((d) => !d.kept).map((d) => faceText(t, d.value));
    let s = `${t.text}: ${kept.join(", ")}`;
    if (dropped.length) s += `, dropping ${dropped.join(", ")}`;
    return `${t.sign < 0 ? "minus " : ""}${s}`;
  });
  return `${parts.join("; ")}. Total ${totalWord(r)}.`;
}

/** Compact form for the big result panel. */
export function totalText(r: RollResult): string {
  return String(r.total);
}
