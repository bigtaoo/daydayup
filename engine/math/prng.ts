/**
 * Deterministic Linear Congruential Generator (LCG). Ported from `funny`
 * (server/engine/src/math/prng.ts) per design/06.
 *
 * Multiplier and increment from Numerical Recipes (Knuth). Produces uint32
 * values — never calls Math.random(). Safe for deterministic game logic and
 * replay verification.
 *
 * Injected per-concern, never global (design/06/08): roomgenPrng, aiPrng,
 * combatPrng, dropPrng — each `new Prng(seed ^ <distinct constant>)` so the
 * streams never alias.
 */
export class Prng {
  private state: number;

  constructor(seed: number) {
    // Ensure uint32; guard against 0 (LCG with state=0 stays 0 for mult=0)
    this.state = (seed >>> 0) || 1;
  }

  /**
   * Read-only view of the current internal state (uint32). Does NOT advance the
   * stream — for state hashing / replay verification only (design/08). Two engines
   * that have drawn the same sequence expose the same value here.
   */
  peek(): number {
    return this.state >>> 0;
  }

  /** Advance state and return next uint32 */
  private next(): number {
    // state = (1664525 × state + 1013904223) mod 2^32
    this.state = (Math.imul(1664525, this.state) + 1013904223) >>> 0;
    return this.state;
  }

  /** Return integer in [0, max). max must be a positive integer. */
  nextInt(max: number): number {
    return (this.next() >>> 0) % max;
  }

  /**
   * Weighted pick: given integer weights, return the index chosen proportionally.
   * Deterministic (single `next()` draw). Used by drop tables (design/05/09).
   * Weights must be non-negative integers with a positive sum.
   */
  weightedIndex(weights: readonly number[]): number {
    let total = 0;
    for (const w of weights) total += w;
    let roll = this.nextInt(total);
    for (let i = 0; i < weights.length; i++) {
      roll -= weights[i]!;
      if (roll < 0) return i;
    }
    return weights.length - 1; // unreachable when sum > 0
  }

  /**
   * Fisher-Yates shuffle in-place.
   * Returns the same array (mutated).
   */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.nextInt(i + 1);
      const tmp = arr[i];
      arr[i] = arr[j]!;
      arr[j] = tmp!;
    }
    return arr;
  }
}
