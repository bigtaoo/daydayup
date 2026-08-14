import { describe, it, expect } from 'vitest';
import { toFp, fromFp, fp, addFp, subFp, mulFp, scaleFp, negFp, isqrt, FP_SCALE } from '@dd/engine/math/fixed';

describe('fixed-point', () => {
  it('toFp/fromFp round-trips within one fp unit', () => {
    for (const g of [0, 1, 1.5, 3.2, -2.75, 46 / 32, 0.156]) {
      expect(fromFp(toFp(g))).toBeCloseTo(g, 2);
    }
  });

  it('toFp truncates toward zero deterministically', () => {
    expect(toFp(1.9999)).toBe(1999);
    expect(toFp(-1.9999)).toBe(-1999);
  });

  it('arithmetic helpers stay in fp space', () => {
    const a = toFp(2);
    const b = toFp(3);
    expect(addFp(a, b)).toBe(5000);
    expect(subFp(b, a)).toBe(1000);
    expect(mulFp(a, b)).toBe(6000); // 2 * 3 = 6 grid
    expect(scaleFp(-1, a)).toBe(-2000);
    expect(negFp(a)).toBe(-2000);
    expect(fp(1000)).toBe(FP_SCALE);
  });

  it('mulFp matches manual trunc(a*b/scale)', () => {
    const a = toFp(1.234);
    const b = toFp(5.678);
    expect(mulFp(a, b)).toBe(Math.trunc((a * b) / FP_SCALE));
  });

  it('isqrt is exact floor sqrt for a range and matches at fp scale', () => {
    for (let n = 0; n < 10000; n++) {
      expect(isqrt(n)).toBe(Math.floor(Math.sqrt(n)));
    }
    // distance use: dx=3 grid, dy=4 grid → 5 grid in fp
    const dx = toFp(3);
    const dy = toFp(4);
    expect(isqrt(dx * dx + dy * dy)).toBe(5000);
  });

  it('isqrt clamps negatives to 0', () => {
    expect(isqrt(-42)).toBe(0);
  });

  it('isqrt is exact for large n straddling the 2^32 boundary', () => {
    // Regression test: the digit-by-digit loop's `bit`/`res` variables can
    // legitimately exceed 2^31 for n >= 2^32. A prior implementation used
    // `>>` (32-bit SIGNED coercion) instead of Math.trunc(x / 2), which
    // silently wrapped/corrupted `res` for any n >= 4_294_967_296.
    const boundary = 2 ** 32;
    const values = [
      boundary - 1,
      boundary,
      boundary + 1,
      5_000_000_000, // isqrt(5e9) = 70710 — the reported repro case
      Number.MAX_SAFE_INTEGER,
    ];
    for (const n of values) {
      expect(isqrt(n)).toBe(Math.floor(Math.sqrt(n)));
    }
  });

  it('isqrt covers the realistic Fp squared-distance range (up to a large room)', () => {
    // dx/dy in fp units (FP_SCALE = 1000); a room up to 1000 grid units on a
    // side gives fp deltas up to 1_000_000, so distSq up to ~2e12 — well past
    // the 2^32 (~4.3e9) boundary that broke the old bitwise implementation.
    for (const gridDelta of [0, 1, 24, 100, 768, 1000, 10000]) {
      const d = toFp(gridDelta);
      const distSq = d * d + d * d;
      expect(isqrt(distSq)).toBe(Math.floor(Math.sqrt(distSq)));
    }
  });

  it('isqrt is exact on perfect squares across many magnitudes, including past 2^32', () => {
    // A digit-by-digit sqrt algorithm can be off-by-one right AT a perfect
    // square boundary even when it's correct elsewhere — check k*k -> k
    // directly (not just floor-of-float-sqrt) across small, mid, and
    // past-2^32 magnitudes.
    // k is capped near sqrt(Number.MAX_SAFE_INTEGER) (~94906265.6) so k*k
    // itself stays an exactly-representable double — squaring anything
    // larger would make the TEST's own `k*k` lossy, not exercise isqrt.
    const ks = [0, 1, 2, 3, 7, 1000, 65536, 65537, 100000, 94906265, 94906266];
    for (const k of ks) {
      expect(isqrt(k * k)).toBe(k);
    }
  });

  it('isqrt(0) and isqrt just below/above 0 are exact', () => {
    expect(isqrt(0)).toBe(0);
    expect(isqrt(1)).toBe(1);
    expect(isqrt(3)).toBe(1); // just below 4 = 2^2
    expect(isqrt(4)).toBe(2); // exact
  });

  it('addFp/subFp handle negative results correctly', () => {
    const a = toFp(2);
    const b = toFp(5);
    expect(subFp(a, b)).toBe(-3000); // 2 - 5 = -3 grid
    expect(addFp(negFp(a), negFp(b))).toBe(-7000); // -2 + -5 = -7 grid
  });

  it('mulFp truncates toward zero for negative operands (matches Math.trunc, not floor)', () => {
    const a = toFp(-1.5);
    const b = toFp(2);
    // -1.5 * 2 = -3 exactly, no truncation ambiguity here...
    expect(mulFp(a, b)).toBe(-3000);
    // ...but a case that actually exercises trunc-vs-floor divergence:
    // (-1000 * 1999) / 1000 = -1999 exactly is too clean; use fractional fp inputs.
    const c = toFp(-1.234);
    const d = toFp(5.678);
    expect(mulFp(c, d)).toBe(Math.trunc((c * d) / FP_SCALE));
    expect(mulFp(c, d)).toBeLessThan(0);
  });

  it('scaleFp handles zero and negative coefficients', () => {
    const a = toFp(4.5);
    expect(scaleFp(0, a)).toBe(0);
    expect(scaleFp(-3, a)).toBe(-13500);
  });

  it('fp() and fromFp() round-trip negative raw values', () => {
    expect(fp(-2500)).toBe(-2500);
    expect(fromFp(fp(-2500))).toBe(-2.5);
  });

  it('negFp is its own inverse', () => {
    const a = toFp(7.25);
    expect(negFp(negFp(a))).toBe(a);
    // negFp(0) is -0 (JS `-0` semantics from unary minus) — equal to 0 under
    // `===`/game-logic comparisons, just not under `Object.is`/`toBe`.
    expect(negFp(fp(0)) === 0).toBe(true);
  });
});
