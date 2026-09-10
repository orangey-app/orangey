/**
 * What a brand-new library starts with.
 *
 * An empty library on first open is a blank page with buttons on it. A handful
 * of real, useful randomizers shows what the app is for and gives something
 * to roll in the first ten seconds. They are ordinary files: rename, edit or
 * delete them like anything else.
 */

import { emptyRandomizer, makeItem, type Randomizer } from "./randomizer.ts";

export interface Starter {
  folder: string;
  randomizer: Randomizer;
}

function list(name: string, description: string, rows: [string, number, string?][], view: "wheel" | "list" = "wheel"): Randomizer {
  const base = emptyRandomizer("list", name);
  return {
    ...base,
    description,
    view,
    items: rows.map(([label, weight, note]) => makeItem(label, weight, note ? { description: note } : {})),
  } as Randomizer;
}

function dice(name: string, expression: string, description: string): Randomizer {
  return { ...emptyRandomizer("dice", name), expression, description } as Randomizer;
}

export function starters(): Starter[] {
  return [
    {
      folder: "Encounters",
      randomizer: list("Forest Encounters", "Daytime, levels 1–4", [
        ["Goblin patrol", 50, "Three goblins, one with a horn"],
        ["Merchant", 20, "Friendly, overpriced"],
        ["Wolf pack", 20, "2d4 wolves, hungry"],
        ["Nothing", 9],
        ["Young green dragon", 1, "Run."],
      ]),
    },
    {
      folder: "Encounters",
      randomizer: list("Minor Treasure", "Pockets, packs and small chests", [
        ["2d6 × 10 gp", 40],
        ["A silver ring", 20, "Worth 25 gp"],
        ["A map to somewhere else", 15],
        ["A potion of healing", 15],
        ["A cursed copper coin", 10, "It always lands on its edge"],
      ]),
    },
    {
      folder: "Board games",
      randomizer: list("Who goes first", "Rename the players, then spin", [
        ["Player 1", 1], ["Player 2", 1], ["Player 3", 1], ["Player 4", 1],
      ]),
    },
    {
      folder: "",
      randomizer: list("Yes or no", "A quick oracle", [
        ["Yes", 45], ["Yes, but…", 15], ["No", 45], ["No, but…", 15],
      ], "list"),
    },
    { folder: "Dice", randomizer: dice("Attack roll", "d20 + 5", "Longsword, +3 Strength, proficient") },
    { folder: "Dice", randomizer: dice("Advantage", "2d20kh1", "Roll twice, keep the higher") },
    { folder: "Dice", randomizer: dice("Ability score", "4d6kh3", "Roll four, drop the lowest") },
  ];
}
