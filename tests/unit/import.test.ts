import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { detect, guessColumns, parseNumberLoose } from "../../src/import/detect.ts";
import { parseDelimited, delimiterName } from "../../src/import/parse.ts";
import { buildItems, itemsFromJson, renderReport } from "../../src/import/map.ts";

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8");

const importAll = (text: string, extrasToMetadata = false) => {
  const d = detect(text);
  const g = guessColumns(d.rows, d.hasHeader);
  return { detection: d, ...buildItems(d.rows, d.hasHeader, { ...g, extrasToMetadata }) };
};

describe("reading a file someone exported from a spreadsheet", () => {
  test("every fixture is read with the right delimiter, header and first label", () => {
    // file -> [delimiter, has a header row, entries, the first label]. The
    // first label is checked because a byte-order mark or a stray quote is
    // easiest to spot there.
    const cases: [string, string, boolean, number, string][] = [
      ["simple.csv", ",", false, 4, "Goblin"],
      ["simple.tsv", "\t", false, 4, "Goblin"],
      ["semicolon.csv", ";", false, 3, "Goblin"],
      ["pipe.csv", "|", false, 3, "Goblin"],
      ["spaces.txt", "  ", false, 3, "Goblin"],
      ["bom.csv", ",", true, 2, "Goblin"],
      ["quoted.csv", ",", true, 3, "Wolf, grey"],
      ["broken.csv", ",", true, 4, "Goblin patrol"],
    ];
    for (const [file, delimiter, hasHeader, items, firstLabel] of cases) {
      const what = `${file} read as ${delimiterName(delimiter as never)}`;
      const r = importAll(fixture(file));
      assert.equal(r.detection.delimiter, delimiter, what);
      assert.equal(r.detection.hasHeader, hasHeader, `${what}: header row`);
      assert.equal(r.items.length, items, `${what}: ${renderReport(r.report)}`);
      assert.equal(r.items[0].label, firstLabel, `${what}: first label`);
    }
  });

  test("quoted fields keep their delimiters, quotes and newlines", () => {
    const rows = parseDelimited(fixture("quoted.csv"), ",");
    assert.deepEqual(rows[1], ["Wolf, grey", "30"]);
    assert.deepEqual(rows[2], ['He said "hi"', "20"]);
    assert.deepEqual(rows[3], ["Two\nlines", "10"]);
  });

  test("loose number parsing accepts what spreadsheets emit", () => {
    const cases: [string, number | null][] = [
      ["50", 50],
      [" 12.5 ", 12.5],
      ["12,5", 12.5], // a decimal comma, as most of Europe writes it
      ["30%", 30],
      ["many", null],
      ["", null],
      ["1,234,567", null], // thousands separators are too ambiguous to guess at
    ];
    for (const [text, expected] of cases) {
      assert.equal(parseNumberLoose(text), expected, `for "${text}"`);
    }
  });
});

describe("choosing the columns", () => {
  test("labels, weights and descriptions are found by name, by shape, and in any order", () => {
    const columnsOf = (text: string) => {
      const d = detect(text);
      return guessColumns(d.rows, d.hasHeader);
    };
    assert.deepEqual(
      columnsOf("Name,Probability,Description\nGoblin,50,Small\nOrc,30,Large\n"),
      { label: 0, weight: 1, description: 2, color: null },
      "from the header names",
    );
    assert.deepEqual(
      columnsOf("Goblin,50\nOrc,30\n"),
      { label: 0, weight: 1, description: null, color: null },
      "from the data, with no header to go on",
    );
    // The weight is not always to the right of the label.
    assert.deepEqual(columnsOf("Weight,Name\n50,Goblin\n30,Orc\n"), { label: 1, weight: 0, description: null, color: null });

    // Columns nobody asked for are not lost: they can be kept as metadata.
    const extras = importAll("Name,Weight,Region,Tier\nGoblin,50,Forest,1\n", true);
    assert.equal(extras.items[0].description, "Forest");
    assert.deepEqual(extras.items[0].metadata, { Tier: "1" });
  });
});

describe("the import report", () => {
  test("the broken fixture reports exactly what went wrong, row by row", () => {
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
    // Whatever it warns about, the entries it did understand still come through.
    assert.deepEqual(r.items.map((i) => `${i.label}:${i.weight}`), [
      "Goblin patrol:50",
      "Merchant:20",
      "Wolf pack:20",
      "Wolf pack:15",
    ]);
  });

  test("a good file reports only successes, a missing weight is filled in, and an empty one is refused", () => {
    const good = importAll(fixture("simple.csv"));
    assert.equal(renderReport(good.report), "✓ 4 entries ready\n✓ Weights valid (total 100)");
    assert.ok(good.usable);

    const gap = importAll("Name,Weight\nGoblin,\nOrc,30\n");
    assert.equal(gap.items[0].weight, 1);
    assert.ok(renderReport(gap.report).includes("1 entry had no weight — using 1"), renderReport(gap.report));

    const empty = importAll(",,,\n,,,\n");
    assert.equal(empty.usable, false);
    assert.ok(renderReport(empty.report).includes("✗"));
  });
});

describe("importing JSON", () => {
  test("strings, objects and labelled weights all import, and a broken file is reported not thrown", () => {
    const plain = itemsFromJson('["Goblin", "Orc"]');
    assert.deepEqual(plain.items.map((i) => [i.label, i.weight]), [["Goblin", 1], ["Orc", 1]]);

    // "name" is what most other tools call the label.
    const objects = itemsFromJson('{"items":[{"label":"Goblin","weight":50},{"name":"Orc","weight":30,"disabled":true}]}');
    assert.equal(objects.items[0].weight, 50);
    assert.equal(objects.items[1].label, "Orc");
    assert.equal(objects.items[1].disabled, true);

    const unlabelled = itemsFromJson('[{"weight":5},{"label":"Orc"}]');
    assert.equal(unlabelled.items.length, 1);
    assert.ok(renderReport(unlabelled.report).includes("✗ 1 entry had no label — skipped"));

    const broken = itemsFromJson("{oops");
    assert.equal(broken.usable, false);
    assert.ok(renderReport(broken.report).startsWith("✗ Not valid JSON"));
  });
});
