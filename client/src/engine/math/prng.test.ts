import { describe, it, expect } from 'vitest';
import { Prng } from '@dd/engine/math/prng';

describe('Prng (deterministic LCG)', () => {
  it('same seed → identical sequence (replay foundation)', () => {
    const a = new Prng(12345);
    const b = new Prng(12345);
    const seqA = Array.from({ length: 64 }, () => a.nextInt(1000));
    const seqB = Array.from({ length: 64 }, () => b.nextInt(1000));
    expect(seqA).toEqual(seqB);
  });

  it('different seeds diverge', () => {
    const a = new Prng(1);
    const b = new Prng(2);
    const seqA = Array.from({ length: 16 }, () => a.nextInt(1_000_000));
    const seqB = Array.from({ length: 16 }, () => b.nextInt(1_000_000));
    expect(seqA).not.toEqual(seqB);
  });

  it('seed 0 is guarded (does not lock to 0)', () => {
    const p = new Prng(0);
    const vals = Array.from({ length: 8 }, () => p.nextInt(100));
    expect(vals.some((v) => v !== 0)).toBe(true);
  });

  it('nextInt stays in [0, max)', () => {
    const p = new Prng(777);
    for (let i = 0; i < 5000; i++) {
      const v = p.nextInt(37);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(37);
    }
  });

  it('weightedIndex respects weights and is deterministic', () => {
    const weights = [1, 0, 3]; // index 1 has zero weight → never chosen
    const counts = [0, 0, 0];
    const p = new Prng(42);
    for (let i = 0; i < 4000; i++) counts[p.weightedIndex(weights)]!++;
    expect(counts[1]).toBe(0);
    expect(counts[2]).toBeGreaterThan(counts[0]!); // 3:1 ratio
    // reproducible
    expect(new Prng(42).weightedIndex(weights)).toBe(new Prng(42).weightedIndex(weights));
  });

  it('shuffle is deterministic for a given seed', () => {
    const base = () => [0, 1, 2, 3, 4, 5, 6, 7];
    const s1 = new Prng(9).shuffle(base());
    const s2 = new Prng(9).shuffle(base());
    expect(s1).toEqual(s2);
    expect(s1.slice().sort((x, y) => x - y)).toEqual(base()); // permutation
  });
});
