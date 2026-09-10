import type { RandomSource } from "./rng.ts";

export interface CoinResult {
  /** 0 = first face, 1 = second face. */
  side: 0 | 1;
  face: string;
  faces: [string, string];
  seed?: string;
}

export const DEFAULT_FACES: [string, string] = ["Heads", "Tails"];

export function flip(faces: [string, string], rng: RandomSource): CoinResult {
  const side = rng.int(0, 1) as 0 | 1;
  return { side, face: faces[side], faces, seed: rng.seed };
}

export function flipMany(faces: [string, string], count: number, rng: RandomSource): CoinResult[] {
  const out: CoinResult[] = [];
  for (let i = 0; i < count; i++) out.push(flip(faces, rng));
  return out;
}
