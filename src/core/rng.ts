/**
 * Random sources.
 *
 * Two implementations of one interface (plan C4, decision D8):
 *   - CryptoSource  wraps crypto.getRandomValues; not reproducible, the default.
 *   - SeededSource  xoshiro128** driven by a string seed; reproducible, opt-in.
 *
 * Both produce unbiased integers by rejection sampling. Nothing else in the
 * codebase may call Math.random or crypto directly.
 */

export interface RandomSource {
  /** Uniform integer in [min, max], both ends inclusive. */
  int(min: number, max: number): number;
  /** Uniform float in [0, 1) with 53 bits of entropy. */
  float(): number;
  /** The seed string for reproducible sources; undefined for the crypto source. */
  readonly seed?: string;
}

export class RangeError_ extends Error {}

const TWO32 = 4294967296;

function checkRange(min: number, max: number): void {
  if (!Number.isInteger(min) || !Number.isInteger(max)) {
    throw new RangeError_(`int() needs integer bounds, got ${min}..${max}`);
  }
  if (max < min) throw new RangeError_(`int() needs max >= min, got ${min}..${max}`);
  if (max - min + 1 > Number.MAX_SAFE_INTEGER) {
    throw new RangeError_("int() range is too large");
  }
}

/**
 * Unbiased integer from a source of uniform 32-bit words.
 *
 * The naive `min + (word % n)` is biased whenever n does not divide 2^32: the
 * low residues occur once more often than the high ones. We reject the tail
 * that causes it, so every value is equally likely at the cost of a rare extra
 * draw. Ranges wider than 2^32 are built from two words.
 */
export function intFromWords(next: () => number, min: number, max: number): number {
  checkRange(min, max);
  const n = max - min + 1;
  if (n === 1) return min;
  if (n <= TWO32) {
    const limit = TWO32 - (TWO32 % n);
    let x = next();
    while (x >= limit) x = next();
    return min + (x % n);
  }
  // Wide range: 53 bits, rejection on the same principle.
  const limit = Math.floor(Number.MAX_SAFE_INTEGER / n) * n;
  for (;;) {
    const hi = next() % 2097152; // 21 bits
    const x = hi * TWO32 + next();
    if (x < limit) return min + (x % n);
  }
}

function floatFromWords(next: () => number): number {
  // 53 bits: 26 high + 27 low, the standard construction.
  const hi = next() >>> 6; // 26 bits
  const lo = next() >>> 5; // 27 bits
  return (hi * 134217728 + lo) / 9007199254740992;
}

/** The default source. Not reproducible: crypto RNGs cannot be seeded. */
export class CryptoSource implements RandomSource {
  readonly seed = undefined;
  #buf = new Uint32Array(64);
  #i = this.#buf.length;

  #next = (): number => {
    if (this.#i >= this.#buf.length) {
      globalThis.crypto.getRandomValues(this.#buf);
      this.#i = 0;
    }
    return this.#buf[this.#i++];
  };

  int(min: number, max: number): number {
    return intFromWords(this.#next, min, max);
  }
  float(): number {
    return floatFromWords(this.#next);
  }
}

/** FNV-1a over the UTF-8 bytes of a string, as two 32-bit halves. */
export function fnv1a64(s: string): [number, number] {
  const bytes = new TextEncoder().encode(s);
  let h1 = 0x811c9dc5 | 0;
  let h2 = 0x01000193 | 0;
  for (const b of bytes) {
    h1 = Math.imul(h1 ^ b, 0x01000193);
    h2 = Math.imul(h2 + b + 0x9e3779b9, 0x85ebca6b);
  }
  return [h1 >>> 0, h2 >>> 0];
}

/** A small stable hash for non-cryptographic use (wheel colour rotation, C8.3). */
export function hash32(s: string): number {
  return fnv1a64(s)[0];
}

function splitmix32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return ((t = t ^ (t >>> 15)) >>> 0);
  };
}

/**
 * xoshiro128** — small, fast, and statistically sound for our purposes.
 * State is seeded through splitmix32 so that even a weak seed string
 * ("1", "a") produces a well-mixed state.
 */
export class SeededSource implements RandomSource {
  readonly seed: string;
  #s: Uint32Array;

  constructor(seed: string) {
    this.seed = seed;
    const [h1, h2] = fnv1a64(seed);
    const mix = splitmix32(h1 ^ Math.imul(h2, 0x2545f491));
    this.#s = new Uint32Array([mix(), mix(), mix(), mix()]);
    if ((this.#s[0] | this.#s[1] | this.#s[2] | this.#s[3]) === 0) this.#s[0] = 1;
    for (let i = 0; i < 16; i++) this.#next(); // discard the first outputs
  }

  #next = (): number => {
    const s = this.#s;
    const r = Math.imul(rotl(Math.imul(s[1], 5), 7), 9) >>> 0;
    const t = (s[1] << 9) >>> 0;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl(s[3], 11);
    return r;
  };

  int(min: number, max: number): number {
    return intFromWords(this.#next, min, max);
  }
  float(): number {
    return floatFromWords(this.#next);
  }
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/** Convenience: the source a roll should use given the current seed setting. */
export function sourceFor(seed: string | null | undefined): RandomSource {
  return seed ? new SeededSource(seed) : new CryptoSource();
}
