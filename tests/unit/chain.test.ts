import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { CHAIN_FULL_SIZE, advanceChain, chainPlacement, chainTarget, type ChainLink } from "../../src/ui/components/chain.ts";
import { emptyRandomizer, makeItem, type ListRandomizer } from "../../src/model/randomizer.ts";
import { rollRandomizer } from "../../src/ui/roll.ts";
import { SeededSource } from "../../src/core/rng.ts";

const link = (id: string, name = id): ChainLink => ({ id, name, from: "", found: true });
/** A library holding these ids, and nothing else. */
const library = (...ids: string[]) => (id: string) => (ids.includes(id) ? { name: `The ${id}` } : null);

describe("a chain of randomizers", () => {
  test("keeps the two newest at full size and iconizes what came before", () => {
    assert.deepEqual(chainPlacement(1, 0), ["full"]);
    assert.deepEqual(chainPlacement(2, 1), ["full", "full"]);
    assert.deepEqual(chainPlacement(3, 2), ["icon", "full", "full"]);
    assert.deepEqual(chainPlacement(4, 3), ["icon", "icon", "full", "full"]);
    assert.equal(chainPlacement(4, 3).filter((p) => p === "full").length, CHAIN_FULL_SIZE);

    // Clicking an icon brings that one back, with the randomizer that sent
    // you to it; the pair that was full size goes to the strip in its place.
    assert.deepEqual(chainPlacement(4, 1), ["full", "full", "icon", "icon"]);
    // Nothing sent you to the root, so on its own it is the only one full size.
    assert.deepEqual(chainPlacement(4, 0), ["full", "icon", "icon", "icon"]);
  });

  test("starts again from the randomizer that rolled, and will not go round twice", () => {
    const links = [link("enc", "Encounters"), link("treasure", "Treasure"), link("gems", "Gems")];

    // Rolling the root answers its question again, so the chain it had opened
    // is no longer part of this one.
    assert.deepEqual(advanceChain(links, 0, null, library()).links, [links[0]]);
    // The same from the middle: Gems belonged to Treasure's previous answer.
    const onwards = advanceChain(links, 1, { id: "art", label: "A painting" }, library("art"));
    assert.deepEqual(onwards.links.map((l) => l.id), ["enc", "treasure", "art"]);
    assert.equal(onwards.note, null);

    // Back to one that is already open: the chain stops and says so, rather
    // than opening Encounters a second time and leading straight back here.
    const round = advanceChain(links, 2, { id: "enc", label: "Roll on the encounter table" }, library("enc"));
    assert.deepEqual(round.links, links);
    assert.match(round.note ?? "", /^Encounters is already open here/);
  });

  test("follows an outcome that points somewhere, even when it is gone", () => {
    const wheel: ListRandomizer = {
      ...(emptyRandomizer("list", "Encounters") as ListRandomizer),
      items: [makeItem("The dragon's hoard", 1, { goesTo: "hoard" }), makeItem("Nothing", 0)],
    };
    // Only one outcome can come up, so this is the one that points.
    assert.deepEqual(chainTarget(wheel, rollRandomizer(wheel, new SeededSource("x"))), {
      id: "hoard",
      label: "The dragon's hoard",
    });
    // Dice have no outcomes to hang a link on.
    const dice = emptyRandomizer("dice", "d20");
    assert.equal(chainTarget(dice, rollRandomizer(dice, new SeededSource("x"))), null);

    // Deleted, and it still comes up: the link opens under the name the
    // outcome gave it, and the screen says the randomizer is not there.
    const gone = advanceChain([link("enc", "Encounters")], 0, { id: "hoard", label: "The dragon's hoard" }, () => null);
    assert.equal(gone.note, null);
    assert.deepEqual(gone.links[1], { id: "hoard", name: "The dragon's hoard", from: "The dragon's hoard", found: false });
  });
});
