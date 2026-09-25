import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuickOptions, quickText } from "../../src/import/quick.ts";

test("a quick wheel reads one option per line, with weights and bullets", () => {
  const items = parseQuickOptions([
    "Goblins",
    "",
    "   ",
    "- Bandits | 3",
    "* Wolves x2",
    "• Nothing | 0.5",
    "x3",
    "A | B",
    "Crates ×4",
    "L".repeat(300),
  ].join("\n"));
  assert.deepEqual(
    items.map((i) => [i.label.length > 40 ? `${i.label.length} chars` : i.label, i.weight]),
    [
      ["Goblins", 1],
      ["Bandits", 3],
      ["Wolves", 2],
      ["Nothing", 0.5],
      // a weight needs something left to weigh, and a pipe needs a number
      ["x3", 1],
      ["A | B", 1],
      ["Crates", 4],
      ["200 chars", 1],
    ],
  );
  assert.equal(new Set(items.map((i) => i.id)).size, items.length, "every option gets its own id");

  // One option is one item; whether that rolls is whyCannotRoll's business.
  assert.equal(parseQuickOptions("Only this\n\n").length, 1);
  assert.equal(parseQuickOptions("\n \n").length, 0);

  // Reopened from the address, the text comes back with its weights.
  assert.equal(quickText(parseQuickOptions("A\n- B x3\nC | 0.5")), "A\nB | 3\nC | 0.5");
});
