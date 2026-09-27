/**
 * The quick wheel's text, one option per line, to outcomes and back. No DOM.
 *
 * A trailing ` | 3` or ` x3` sets the weight: `|` takes any number, `x` only a
 * whole one. The weight is read only if a label is left, so a line that is
 * just "x3" is an option called "x3". A leading bullet is dropped.
 */

import { makeItem, type ListItem } from "../model/randomizer.ts";

/** The longest label a file may hold; a longer line is cut to it. */
const QUICK_LABEL_MAX = 200;

const QUICK_BULLET = /^[-*•]\s+/;
const QUICK_PIPE_WEIGHT = /^(.*\S)\s+\|\s*(\d+(?:\.\d+)?|\.\d+)$/;
const QUICK_TIMES_WEIGHT = /^(.*\S)\s+[x×X](\d+)$/;

export function parseQuickOptions(text: string): ListItem[] {
  const items: ListItem[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(QUICK_BULLET, "").trim();
    if (!line) continue;
    let label = line;
    let weight = 1;
    const pipe = line.match(QUICK_PIPE_WEIGHT);
    const times = pipe ? null : line.match(QUICK_TIMES_WEIGHT);
    if (pipe) {
      label = pipe[1];
      weight = Number(pipe[2]);
    } else if (times && Number(times[2]) > 0) {
      label = times[1];
      weight = Number(times[2]);
    }
    items.push(makeItem(label.slice(0, QUICK_LABEL_MAX), weight));
  }
  return items;
}

/**
 * The textarea text for these outcomes, used when a quick wheel is reopened
 * from its address. Weights other than 1 come back as ` | n`; bullets and
 * blank lines are not kept.
 */
export function quickText(items: readonly ListItem[]): string {
  return items.map((i) => (i.weight === 1 ? i.label : `${i.label} | ${i.weight}`)).join("\n");
}
