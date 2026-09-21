import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { draftProblem } from "../../src/model/draft.ts";
import { starters } from "../../src/model/starters.ts";
import { emptyRandomizer, makeItem, type DiceRandomizer, type ListRandomizer, type NumberRandomizer } from "../../src/model/randomizer.ts";

describe("a draft in the editor", () => {
  test("says what would stop the file being read back, and nothing more", () => {
    // What ships must be saveable, or the editor would refuse its own files.
    for (const starter of starters()) {
      assert.equal(draftProblem(starter.randomizer), null, `${starter.randomizer.name} is a valid draft`);
    }

    const list = emptyRandomizer("list", "Wheel") as ListRandomizer;
    assert.equal(draftProblem(list), null);
    assert.ok(
      draftProblem({ ...list, items: [makeItem("Fine", 1), makeItem("", 1)] }),
      "an outcome with no label at all",
    );

    const number = emptyRandomizer("number", "Roll") as NumberRandomizer;
    assert.equal(draftProblem(number), null);
    assert.ok(draftProblem({ ...number, min: 10, max: 1 }), "a maximum below the minimum");
    assert.ok(draftProblem({ ...number, count: 1.5 }), "a fractional count");

    const dice = emptyRandomizer("dice", "Attack") as DiceRandomizer;
    assert.equal(draftProblem(dice), null);
    assert.ok(draftProblem({ ...dice, expression: "2d" }), "a half-written expression");
  });
});
