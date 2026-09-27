/**
 * Is this draft one the app could read back?
 *
 * `validateRandomizer` stays lenient: the file format is append only, and a
 * file on disk with, say, an odd dice expression must still open so it can be
 * fixed. An editor must not write what it could not load, which is the
 * stricter check here. No DOM. Returns a sentence for a person, or null.
 */

import { Check } from "./validate.ts";
import { validateRandomizer, type Randomizer } from "./randomizer.ts";
import { tryParse } from "../core/dice/grammar.ts";
import { validateSpec } from "../core/number.ts";

/**
 * Turns "randomizer.items[3].label" into the part a person needs, keeping the
 * index because it says which row.
 */
function readableField(path: string): string {
  const tail = path.replace(/^randomizer\.?/, "");
  if (!tail) return "This randomizer";
  const at = tail.match(/\[(\d+)\]/);
  const field = tail.split(".").pop()?.replace(/\[\d+\]/, "") ?? tail;
  const name = field === "label" ? "outcome" : field;
  return at ? `Outcome ${Number(at[1]) + 1}'s ${name}` : `The ${name}`;
}

export function draftProblem(model: Randomizer): string | null {
  const check = new Check();
  if (!validateRandomizer(model, check) || !check.ok) {
    const issue = check.issues[0];
    return issue ? `${readableField(issue.path)} ${issue.message}` : "This randomizer is not valid";
  }
  if (model.type === "dice") {
    const parsed = tryParse(model.expression);
    if (!parsed.ok) return parsed.error.message;
  }
  if (model.type === "number") {
    const problem = validateSpec(model);
    if (problem) return problem;
  }
  return null;
}
