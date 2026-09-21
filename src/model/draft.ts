/**
 * Is this draft one the app could read back?
 *
 * `validateRandomizer` says whether a file is well formed, and it stays that
 * way: a file already on disk with an odd dice expression must still open, so
 * it can be fixed (P10). But an editor must not *write* something it could
 * not then load, which is a stricter question and a different one. This asks
 * it, without a DOM, so both editors and the tests can use the same answer.
 *
 * It returns a sentence for a person to read, or null when the draft is fine.
 */

import { Check } from "./validate.ts";
import { validateRandomizer, type Randomizer } from "./randomizer.ts";
import { tryParse } from "../core/dice/grammar.ts";
import { validateSpec } from "../core/number.ts";

/**
 * "randomizer.items[3].label" is precise and unreadable. The field at the end
 * is the part a person needs, with the index kept because it says which row.
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
