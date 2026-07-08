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
});
