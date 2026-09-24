import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rollsInScope, type HistoryRow } from "../../src/ui/state.ts";
import { clearRollsPrompt } from "../../src/ui/components/recent.ts";
import { historyCsv } from "../../src/ui/views/history.ts";

const roll = (id: string, over: Partial<HistoryRow> = {}): HistoryRow => ({
  id,
  at: 0,
  randomizerId: null,
  randomizerName: "Forest Encounters",
  type: "list",
  resultText: "Goblin patrol",
  speakText: "Goblin patrol",
  ...over,
});

// One of each way an entry names where it came from.
const forest = roll("h1", { randomizerId: "forest", repeat: { kind: "randomizer", id: "forest" } });
const damage = roll("h2", { randomizerId: "damage", randomizerName: "Damage", type: "dice", repeat: { kind: "dice", expression: "2d6" } });
const treasure = roll("h3", { randomizerId: "treasure", repeat: { kind: "randomizer", id: "treasure" } });
const adHoc = roll("h4", { randomizerName: "d20", type: "dice", repeat: { kind: "dice", expression: "d20" } });
const all = [forest, damage, treasure, adHoc];

describe("the rolls a scoped clear is about", () => {
  test("only the randomizers in front of the user are picked, however they name themselves", () => {
    const cases: [string, string[], string[]][] = [
      ["the one randomizer a play screen has open", ["forest"], ["h1"]],
      // a dice entry carries its expression in `repeat`, so the id on the entry is what matches
      ["a dice randomizer from the library", ["damage"], ["h2"]],
      ["the several a board shows", ["forest", "treasure"], ["h1", "h3"]],
      ["a randomizer that has not been rolled", ["hoard"], []],
      // an ad-hoc roll belongs to no randomizer, so an id never takes it
      ["a screen that names everything it can see", ["forest", "damage", "treasure"], ["h1", "h2", "h3"]],
      ["no ids at all, which is the whole history", [], ["h1", "h2", "h3", "h4"]],
    ];
    for (const [what, ids, expected] of cases) {
      assert.deepEqual(rollsInScope(all, ids).map((r) => r.id), expected, what);
    }
  });

  test("Clear says what is about to go", () => {
    const cases: [string, number, string, string][] = [
      ["a randomizer by name", 6, "Forest Encounters", "Clear 6 rolls of Forest Encounters?"],
      ["a phrase that points at the screen", 12, "this board", "Clear 12 rolls from this board?"],
      ["one roll is not one rolls", 1, "Forest Encounters", "Clear 1 roll of Forest Encounters?"],
      ["no scope is the History screen's meaning", 40, "", "Clear the whole history?"],
    ];
    for (const [what, count, scope, expected] of cases) assert.equal(clearRollsPrompt(count, scope), expected, what);
  });
});

describe("a struck roll", () => {
  test("is still struck when it comes back from the store, and an older entry is not struck", () => {
    // IndexedDB keeps the whole record and hands it back structure-cloned, so
    // that is the round trip a reload actually makes.
    const cases: [string, HistoryRow, boolean][] = [
      ["a roll the table struck", { ...forest, struck: true }, true],
      ["one whose line was taken off again", { ...forest, struck: false }, false],
      ["an entry written before the flag existed", forest, false],
    ];
    for (const [what, entry, expected] of cases) {
      const stored = structuredClone(entry) as HistoryRow;
      assert.equal(stored.struck === true, expected, what);
    }
  });

  test("is exported like any other, with the column saying it was struck", () => {
    const chained = roll("h5", {
      randomizerName: "Wolves",
      resultText: "3 wolves",
      parts: ["2d4 [1, 2] = 3"],
      from: { randomizerName: "Forest Encounters", label: "Wolf pack" },
    });
    const csv = historyCsv([{ ...forest, struck: true }, { ...damage, randomizerName: "Damage, heavy" }, chained]);
    const [header, struckRow, plainRow, chainedRow] = csv.split("\n");
    // details and from came later, so they are appended: every column a
    // sheet already reads by position stays where it was.
    assert.equal(header, "time,randomizer,type,result,seed,struck,details,from");
    assert.equal(struckRow.endsWith(",yes,,"), true, "a struck roll says so in the struck column");
    assert.equal(plainRow.endsWith(",,,"), true, "an ordinary roll leaves it empty");
    assert.match(plainRow, /"Damage, heavy"/, "a name with a comma is still quoted");
    assert.equal(chainedRow.endsWith(',,"2d4 [1, 2] = 3",Forest Encounters → Wolf pack'), true, chainedRow);
  });
});
