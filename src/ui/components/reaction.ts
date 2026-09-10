/**
 * The control that tags an outcome for Orangey.
 *
 * One small button that cycles none → cheer → wince → none, so a row in the
 * outcome table stays one click wide. The same control sits under each coin
 * face. The labels are what he does, matching the file format and the
 * Settings card; nothing here names a pose.
 */

import { OUTCOME_REACTIONS, type OutcomeReaction } from "../../model/randomizer.ts";
import { h } from "../dom.ts";

export const REACTION_LABELS: Record<OutcomeReaction | "none", string> = {
  none: "—",
  cheer: "Cheer",
  wince: "Wince",
};

export const REACTION_TITLES: Record<OutcomeReaction | "none", string> = {
  none: "Orangey does nothing special",
  cheer: "Orangey cheers this one",
  wince: "Orangey winces at this one",
};

export function nextReaction(current: OutcomeReaction | null | undefined): OutcomeReaction | null {
  if (!current) return OUTCOME_REACTIONS[0];
  const i = OUTCOME_REACTIONS.indexOf(current);
  return i < 0 || i === OUTCOME_REACTIONS.length - 1 ? null : OUTCOME_REACTIONS[i + 1];
}

export interface ReactionControlOptions {
  current: OutcomeReaction | null | undefined;
  /** What the outcome is called, for the accessible name. */
  subject: string;
  onChange: (next: OutcomeReaction | null) => void;
}

export function reactionControl(opts: ReactionControlOptions): HTMLButtonElement {
  const key = opts.current ?? "none";
  const el = h("button", {
    type: "button",
    class: `reaction-control reaction-${key}`,
    dataset: { reaction: key },
    title: `${REACTION_TITLES[key]} — press to change`,
    "aria-label": `Orangey: ${key === "none" ? "no reaction" : REACTION_LABELS[key].toLowerCase()}, for ${opts.subject}`,
    text: REACTION_LABELS[key],
  });
  el.addEventListener("click", () => opts.onChange(nextReaction(opts.current)));
  return el;
}
