/**
 * A wheel typed at the table, one option per line.
 *
 * The quick wheel on the play screen is a textarea, and this is how its text
 * becomes outcomes and back. Pure and DOM-free (P13), so it is tested under
 * `node --test` like the importer it sits beside.
 *
 * A line is an option. A trailing ` | 3` or ` x3` weighs it: the first takes
 * any number, since "| 0.5" is a reasonable thing to write; the second only a
 * whole one, since "x0.5" is not how anyone writes a count. The weight is
 * read only when something is left over for a label, so a line that is just
 * "x3" is an option called "x3". A leading bullet is dropped, because lists
 * pasted from notes arrive with them.
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
 * The text that gives these outcomes back: what the textarea shows when a
 * quick wheel is reopened from its address. Weights other than 1 come back
 * as ` | n`, whichever way they were typed; bullets and blank lines do not
 * come back, because the address never held them.
 */
export function quickText(items: readonly ListItem[]): string {
  return items.map((i) => (i.weight === 1 ? i.label : `${i.label} | ${i.weight}`)).join("\n");
}
