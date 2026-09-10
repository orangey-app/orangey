import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { detect, guessColumns, guessHeader, parseNumberLoose } from "../../src/import/detect.ts";
import { parseDelimited, delimiterName } from "../../src/import/parse.ts";
import { buildItems, itemsFromJson, renderReport } from "../../src/import/map.ts";

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8");

const importAll = (text: string, extrasToMetadata = false) => {
  const d = detect(text);
  const g = guessColumns(d.rows, d.hasHeader);
  return { detection: d, ...buildItems(d.rows, d.hasHeader, { ...g, extrasToMetadata }) };
};

describe("delimiter detection", () => {
  const cases: [string, string, boolean, number][] = [
    ["simple.csv", ",", false, 4],
    ["simple.tsv", "\t", false, 4],
    ["semicolon.csv", ";", false, 3],
    ["pipe.csv", "|", false, 3],
    ["spaces.txt", "  ", false, 3],
    ["bom.csv", ",", true, 2],
    ["quoted.csv", ",", true, 3],
    ["broken.csv", ",", true, 4],
  ];

  for (const [file, delimiter, hasHeader, items] of cases) {
    test(`${file} is read as ${delimiterName(delimiter as never)}${hasHeader ? " with a header" : ""}`, () => {
      const r = importAll(fixture(file));
      assert.equal(r.detection.delimiter, delimiter);
      assert.equal(r.detection.hasHeader, hasHeader);
      assert.equal(r.items.length, items, renderReport(r.report));
    });
  }

  test("quoted fields keep their delimiters, quotes and newlines", () => {
    const rows = parseDelimited(fixture("quoted.csv"), ",");
    assert.deepEqual(rows[1], ["Wolf, grey", "30"]);
    assert.deepEqual(rows[2], ['He said "hi"', "20"]);
    assert.deepEqual(rows[3], ["Two\nlines", "10"]);
  });

  test("a byte-order mark does not end up in the first label", () => {
    const r = importAll(fixture("bom.csv"));
    assert.equal(r.items[0].label, "Goblin");
  });

  test("loose number parsing accepts what spreadsheets emit", () => {
    assert.equal(parseNumberLoose("50"), 50);
    assert.equal(parseNumberLoose(" 12.5 "), 12.5);
    assert.equal(parseNumberLoose("12,5"), 12.5);
    assert.equal(parseNumberLoose("30%"), 30);
    assert.equal(parseNumberLoose("many"), null);
    assert.equal(parseNumberLoose(""), null);
    assert.equal(parseNumberLoose("1,234,567"), null);
  });

  test("a header is only assumed when the data supports it", () => {
    assert.equal(guessHeader([["Name", "Weight"], ["Goblin", "50"]]), true);
    assert.equal(guessHeader([["Goblin", "50"], ["Orc", "30"]]), false);
    assert.equal(guessHeader([["Goblin", "50"]]), false);
  });

  test("columns are guessed from header names", () => {
    const d = detect("Name,Probability,Description\nGoblin,50,Small\nOrc,30,Large\n");
    assert.deepEqual(guessColumns(d.rows, d.hasHeader), { label: 0, weight: 1, description: 2, color: null });
  });

  test("columns are guessed from the data when there is no header", () => {
    const d = detect("Goblin,50\nOrc,30\n");
    assert.deepEqual(guessColumns(d.rows, d.hasHeader), { label: 0, weight: 1, description: null, color: null });
  });

  test("a weight column to the left of the label is still found", () => {
    const d = detect("Weight,Name\n50,Goblin\n30,Orc\n");
    const g = guessColumns(d.rows, d.hasHeader);
    assert.equal(g.label, 1);
    assert.equal(g.weight, 0);
  });
});

describe("import report", () => {
  test("the broken fixture reports exactly what went wrong", () => {
    const r = importAll(fixture("broken.csv"));
    assert.equal(
      renderReport(r.report),
      [
        "✓ 4 entries ready",
        "✓ Weights valid (total 105)",
        "⚠ 1 entry has no description",
        '⚠ 1 duplicate label: "Wolf pack" (rows 4, 7) — kept both',
        "✗ 1 row had no label (row 6) — skipped",
        '✗ 1 entry has an invalid weight: row 5 "many" — will be skipped',
      ].join("\n"),
    );
    assert.deepEqual(r.items.map((i) => `${i.label}:${i.weight}`), [
      "Goblin patrol:50",
      "Merchant:20",
      "Wolf pack:20",
      "Wolf pack:15",
    ]);
  });

  test("a good file reports only successes", () => {
    const r = importAll(fixture("simple.csv"));
    assert.equal(renderReport(r.report), "✓ 4 entries ready\n✓ Weights valid (total 100)");
    assert.ok(r.usable);
  });

  test("nothing usable is reported as such", () => {
    const r = importAll(",,,\n,,,\n");
    assert.equal(r.usable, false);
    assert.ok(renderReport(r.report).includes("✗"));
  });

  test("missing weights default to 1 and say so", () => {
    const r = importAll("Name,Weight\nGoblin,\nOrc,30\n");
    assert.ok(renderReport(r.report).includes("1 entry had no weight — using 1"));
    assert.equal(r.items[0].weight, 1);
  });

  test("unmapped columns can become metadata", () => {
    const r = importAll("Name,Weight,Region,Tier\nGoblin,50,Forest,1\n", true);
    assert.deepEqual(r.items[0].metadata, { Tier: "1" });
    assert.equal(r.items[0].description, "Forest");
  });

  test("5000 rows import in under 500 ms", () => {
    const text = fixture("large.csv");
    const started = performance.now();
    const r = importAll(text);
    const elapsed = performance.now() - started;
    assert.equal(r.items.length, 5000);
    assert.ok(elapsed < 500, `took ${elapsed.toFixed(0)} ms`);
  });
});

describe("JSON import", () => {
  test("a plain array of strings works", () => {
    const r = itemsFromJson('["Goblin", "Orc"]');
    assert.deepEqual(r.items.map((i) => [i.label, i.weight]), [["Goblin", 1], ["Orc", 1]]);
  });

  test("objects with label and weight work, and name is accepted too", () => {
    const r = itemsFromJson('{"items":[{"label":"Goblin","weight":50},{"name":"Orc","weight":30,"disabled":true}]}');
    assert.equal(r.items[0].weight, 50);
    assert.equal(r.items[1].label, "Orc");
    assert.equal(r.items[1].disabled, true);
  });

  test("entries without a label are skipped and reported", () => {
    const r = itemsFromJson('[{"weight":5},{"label":"Orc"}]');
    assert.equal(r.items.length, 1);
    assert.ok(renderReport(r.report).includes("✗ 1 entry had no label — skipped"));
  });

  test("broken JSON is reported, not thrown", () => {
    const r = itemsFromJson("{oops");
    assert.equal(r.usable, false);
    assert.ok(renderReport(r.report).startsWith("✗ Not valid JSON"));
  });
});
