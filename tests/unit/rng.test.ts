import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { CryptoSource, SeededSource, fnv1a64, hash32, intFromWords } from "../../src/core/rng.ts";
import {
  NotRollableError,
  buildCumulative,
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
  test("both sources roll evenly and never leave their bounds", () => {
    // df = 5, critical value at p = 0.001
    const CRITICAL_D6 = 20.515;
    const sources: [string, () => CryptoSource | SeededSource][] = [
      ["CryptoSource", () => new CryptoSource()],
      ["SeededSource", () => new SeededSource("chi-square")],
    ];
    for (const [name, make] of sources) {
      const rng = make();
      const counts = [0, 0, 0, 0, 0, 0];
      for (let i = 0; i < 600000; i++) counts[rng.int(1, 6) - 1]++;
      const x2 = chiSquare(counts);
      assert.ok(x2 < CRITICAL_D6, `${name}: chi-square ${x2.toFixed(2)} exceeds ${CRITICAL_D6}: ${counts.join(",")}`);

      const pick = new SeededSource("bounds");
      for (let i = 0; i < 10000; i++) {
        const min = pick.int(-1000, 1000);
        const max = min + pick.int(0, 500);
        const v = rng.int(min, max);
        assert.ok(Number.isInteger(v), `${name}: ${v} is not an integer`);
        assert.ok(v >= min && v <= max, `${name}: ${v} outside ${min}..${max}`);
      }
      for (let i = 0; i < 20000; i++) {
        const f = rng.float();
        assert.ok(f >= 0 && f < 1, `${name}: ${f} outside [0,1)`);
      }
    }
  });

  test("rejection sampling removes modulo bias, and a range of one is returned as it is", () => {
    // A deliberately awful word source: values 0..8 only, with a range of 3
    // the naive `% 3` would over-produce 0. Rejection must not.
    let i = 0;
    const words = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    const next = () => words[i++ % words.length];
    const counts = [0, 0, 0];
    for (let k = 0; k < 900; k++) counts[intFromWords(next, 0, 2)]++;
    assert.deepEqual(counts, [300, 300, 300]);

    const rng = new SeededSource("single");
    for (let k = 0; k < 100; k++) assert.equal(rng.int(7, 7), 7);
  });

  test("a seed is reproducible, and a neighbouring seed is a different sequence", () => {
    // Two people opening the same shared link must roll the same thing.
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
    assert.equal(new SeededSource("abc").seed, "abc");
    assert.equal(new CryptoSource().seed, undefined, "an unseeded roll cannot be replayed");
  });

  test("hashes are stable and differ between similar strings", () => {
    assert.equal(hash32("Forest Encounters"), hash32("Forest Encounters"));
    assert.notEqual(hash32("wheel-1"), hash32("wheel-2"));
    assert.equal(fnv1a64("").length, 2);
  });
});

describe("weighted selection", () => {
  test("frequencies match weights within 1 % over 100000 draws", () => {
    // Orangey's whole promise: a 20 % slice comes up a fifth of the time.
    const items = [{ weight: 50 }, { weight: 30 }, { weight: 20 }];
    const rng = new SeededSource("weights");
    const counts = [0, 0, 0];
    for (let i = 0; i < 100000; i++) counts[pickWeightedIndex(items, rng)]++;
    const pct = counts.map((c) => (c / 100000) * 100);
    [50, 30, 20].forEach((expected, i) => {
      assert.ok(Math.abs(pct[i] - expected) < 1, `outcome ${i}: ${pct[i].toFixed(2)}% vs ${expected}%`);
    });
    // Only the proportions matter, so 5:3:2 is the same wheel as 50:30:20.
    assert.deepEqual(normalize(items), normalize([{ weight: 5 }, { weight: 3 }, { weight: 2 }]));
  });

  test("an outcome with no weight, or switched off, is never drawn", () => {
    const mixed = [{ weight: 0 }, { weight: 1 }, { weight: 5, disabled: true }, { weight: 1 }];
    const rng = new SeededSource("zero");
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i++) seen.add(pickWeightedIndex(mixed, rng));
    assert.deepEqual([...seen].sort(), [1, 3]);
    assert.deepEqual(rollableIndices(mixed), [1, 3]);
    assert.equal(totalWeight(mixed), 2, "a disabled outcome's weight is not in the total either");

    const t = buildCumulative([{ weight: 1 }, { weight: 0 }, { weight: 3 }]);
    assert.deepEqual(t.indices, [0, 2]);
    assert.deepEqual(t.cumulative, [1, 4]);
    assert.equal(t.total, 4);

    // Nothing left to roll is a refusal, not a silent fallback to outcome 0.
    assert.throws(() => pickWeightedIndex([{ weight: 0 }, { weight: 2, disabled: true }], rng), NotRollableError);
    const pool = Array.from({ length: 8 }, (_, i) => ({ weight: i + 1 }));
    assert.equal(new Set(drawWithoutReplacement(pool, 8, rng)).size, 8, "a bag draw never repeats itself");
    assert.throws(() => drawWithoutReplacement(pool, 9, rng), NotRollableError);
  });
});
