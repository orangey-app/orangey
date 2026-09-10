import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { CryptoSource, SeededSource, fnv1a64, hash32, intFromWords } from "../../src/core/rng.ts";
import {
  NotRollableError,
  buildCumulative,
  displayPercents,
  drawWithoutReplacement,
  normalize,
  pickWeightedIndex,
  rollableIndices,
  totalWeight,
} from "../../src/core/weighted.ts";

/** Chi-square goodness of fit against a uniform expectation. */
function chiSquare(counts: number[]): number {
  const n = counts.reduce((a, b) => a + b, 0);
  const expected = n / counts.length;
  return counts.reduce((a, c) => a + (c - expected) ** 2 / expected, 0);
}

describe("RandomSource", () => {
  // df = 5, critical value at p = 0.001
  const CRITICAL_D6 = 20.515;

  for (const [name, make] of [
    ["CryptoSource", () => new CryptoSource()],
    ["SeededSource", () => new SeededSource("chi-square")],
  ] as const) {
    test(`${name}: d6 is uniform over 600000 draws`, () => {
      const rng = make();
      const counts = [0, 0, 0, 0, 0, 0];
      for (let i = 0; i < 600000; i++) counts[rng.int(1, 6) - 1]++;
      const x2 = chiSquare(counts);
      assert.ok(x2 < CRITICAL_D6, `chi-square ${x2.toFixed(2)} exceeds ${CRITICAL_D6}: ${counts.join(",")}`);
    });

    test(`${name}: int() never leaves its bounds`, () => {
      const rng = make();
      const pick = new SeededSource("bounds");
      for (let i = 0; i < 10000; i++) {
        const min = pick.int(-1000, 1000);
        const max = min + pick.int(0, 500);
        const v = rng.int(min, max);
        assert.ok(Number.isInteger(v), `${v} is not an integer`);
        assert.ok(v >= min && v <= max, `${v} outside ${min}..${max}`);
      }
    });

    test(`${name}: float() stays in [0, 1)`, () => {
      const rng = make();
      for (let i = 0; i < 20000; i++) {
        const f = rng.float();
        assert.ok(f >= 0 && f < 1, `${f} outside [0,1)`);
      }
    });
  }

  test("single-value ranges are returned directly", () => {
    const rng = new SeededSource("single");
    for (let i = 0; i < 100; i++) assert.equal(rng.int(7, 7), 7);
  });

  test("rejection sampling removes modulo bias", () => {
    // A deliberately awful word source: values 0..8 only, with a range of 3
    // the naive `% 3` would over-produce 0. Rejection must not.
    let i = 0;
    const words = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    const next = () => words[i++ % words.length];
    const counts = [0, 0, 0];
    for (let k = 0; k < 900; k++) counts[intFromWords(next, 0, 2)]++;
    assert.deepEqual(counts, [300, 300, 300]);
  });

  test("SeededSource is reproducible and seed-sensitive", () => {
    const a = new SeededSource("847193");
    const b = new SeededSource("847193");
    const c = new SeededSource("847194");
    const seqA = Array.from({ length: 100 }, () => a.int(1, 20));
    const seqB = Array.from({ length: 100 }, () => b.int(1, 20));
    const seqC = Array.from({ length: 100 }, () => c.int(1, 20));
    assert.deepEqual(seqA, seqB);
    assert.notDeepEqual(seqA, seqC);
    // Recorded fixture: this is the sequence a shared seed must keep producing.
    assert.deepEqual(seqA.slice(0, 6), [4, 8, 18, 10, 8, 8]);
  });

  test("CryptoSource reports no seed, SeededSource reports its own", () => {
    assert.equal(new CryptoSource().seed, undefined);
    assert.equal(new SeededSource("abc").seed, "abc");
  });

  test("hashes are stable and differ between similar strings", () => {
    assert.equal(hash32("Forest Encounters"), hash32("Forest Encounters"));
    assert.notEqual(hash32("wheel-1"), hash32("wheel-2"));
    assert.equal(fnv1a64("").length, 2);
  });
});

describe("weighted selection", () => {
  const items = [{ weight: 50 }, { weight: 30 }, { weight: 20 }];

  test("frequencies match weights within 1 % over 100000 draws", () => {
    const rng = new SeededSource("weights");
    const counts = [0, 0, 0];
    for (let i = 0; i < 100000; i++) counts[pickWeightedIndex(items, rng)]++;
    const pct = counts.map((c) => (c / 100000) * 100);
    [50, 30, 20].forEach((expected, i) => {
      assert.ok(Math.abs(pct[i] - expected) < 1, `outcome ${i}: ${pct[i].toFixed(2)}% vs ${expected}%`);
    });
  });

  test("proportional weights are equivalent", () => {
    assert.deepEqual(normalize([{ weight: 50 }, { weight: 30 }, { weight: 20 }]), normalize([{ weight: 5 }, { weight: 3 }, { weight: 2 }]));
  });

  test("weight 0 and disabled are never drawn", () => {
    const mixed = [{ weight: 0 }, { weight: 1 }, { weight: 5, disabled: true }, { weight: 1 }];
    const rng = new SeededSource("zero");
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i++) seen.add(pickWeightedIndex(mixed, rng));
    assert.deepEqual([...seen].sort(), [1, 3]);
    assert.deepEqual(rollableIndices(mixed), [1, 3]);
    assert.equal(totalWeight(mixed), 2);
  });

  test("nothing rollable throws NotRollableError", () => {
    const rng = new SeededSource("none");
    assert.throws(() => pickWeightedIndex([{ weight: 0 }, { weight: 2, disabled: true }], rng), NotRollableError);
  });

  test("displayed percentages always read as 100", () => {
    for (const n of [3, 7, 11, 13, 97]) {
      const equal = Array.from({ length: n }, () => ({ weight: 1 }));
      const sum = displayPercents(equal).reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(sum - 100) < 0.0501, `${n} equal outcomes summed to ${sum}`);
    }
  });

  test("cumulative table skips non-rollable outcomes", () => {
    const t = buildCumulative([{ weight: 1 }, { weight: 0 }, { weight: 3 }]);
    assert.deepEqual(t.indices, [0, 2]);
    assert.deepEqual(t.cumulative, [1, 4]);
    assert.equal(t.total, 4);
  });

  test("draws without replacement return distinct outcomes", () => {
    const rng = new SeededSource("bag");
    const pool = Array.from({ length: 8 }, (_, i) => ({ weight: i + 1 }));
    const drawn = drawWithoutReplacement(pool, 8, rng);
    assert.equal(new Set(drawn).size, 8);
    assert.throws(() => drawWithoutReplacement(pool, 9, rng), NotRollableError);
  });
});
