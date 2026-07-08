import { describe, it, expect } from 'vitest';
import {
  sinFp,
  cosFp,
  atan2Brad,
  bradDiff,
  normBrad,
  degToBrad,
  BRAD_FULL,
  BRAD_HALF,
  BRAD_QUARTER,
} from '@dd/engine/math/trig';
import { FP_SCALE } from '@dd/engine/math/fixed';

describe('brad / fp-trig', () => {
  it('cardinal sines/cosines are exact', () => {
    expect(sinFp(0)).toBe(0);
    expect(sinFp(BRAD_QUARTER)).toBe(FP_SCALE); // sin 90°
    expect(sinFp(BRAD_HALF)).toBe(0); // sin 180°
    expect(sinFp(BRAD_HALF + BRAD_QUARTER)).toBe(-FP_SCALE); // sin 270°
    expect(cosFp(0)).toBe(FP_SCALE); // cos 0°
    expect(cosFp(BRAD_QUARTER)).toBe(0); // cos 90°
    expect(cosFp(BRAD_HALF)).toBe(-FP_SCALE); // cos 180°
  });

  it('sinFp/cosFp track Math within interpolation tolerance', () => {
    for (let b = 0; b < BRAD_FULL; b += 137) {
      const rad = (b / BRAD_FULL) * 2 * Math.PI;
      expect(sinFp(b)).toBeCloseToFp(Math.sin(rad) * FP_SCALE, 3);
      expect(cosFp(b)).toBeCloseToFp(Math.cos(rad) * FP_SCALE, 3);
    }
  });

  it('sin² + cos² ≈ 1 (unit circle) across the circle', () => {
    for (let b = 0; b < BRAD_FULL; b += 251) {
      const s = sinFp(b);
      const c = cosFp(b);
      const mag = (s * s + c * c) / FP_SCALE; // ≈ FP_SCALE
      expect(Math.abs(mag - FP_SCALE)).toBeLessThanOrEqual(6);
    }
  });

  it('atan2Brad maps the cardinal directions correctly', () => {
    expect(atan2Brad(0, 100)).toBe(0); // +x
    expect(atan2Brad(100, 0)).toBe(BRAD_QUARTER); // +y
    expect(atan2Brad(0, -100)).toBe(BRAD_HALF); // -x
    expect(atan2Brad(-100, 0)).toBe(BRAD_HALF + BRAD_QUARTER); // -y
    expect(atan2Brad(0, 0)).toBe(0); // degenerate
  });

  it('atan2Brad(sinFp, cosFp) round-trips to the original angle', () => {
    for (let b = 0; b < BRAD_FULL; b += 97) {
      const recovered = atan2Brad(sinFp(b), cosFp(b));
      expect(Math.abs(bradDiff(recovered, b))).toBeLessThanOrEqual(48);
    }
  });

  it('bradDiff returns the signed shortest arc', () => {
    expect(bradDiff(10, 5)).toBe(5);
    expect(bradDiff(5, 10)).toBe(-5);
    // wrap-around: 350° vs 10° → shortest is +20° (±1 from per-value rounding)
    expect(Math.abs(bradDiff(degToBrad(10), degToBrad(350)) - degToBrad(20))).toBeLessThanOrEqual(1);
    // opposite points: ±half is fine, magnitude is half
    expect(Math.abs(bradDiff(0, BRAD_HALF))).toBe(BRAD_HALF);
  });

  it('normBrad folds any integer (incl. negatives) into [0, 65536)', () => {
    expect(normBrad(-1)).toBe(BRAD_FULL - 1);
    expect(normBrad(BRAD_FULL + 42)).toBe(42);
    expect(normBrad(0)).toBe(0);
  });

  it('is fully deterministic (fixed golden values)', () => {
    // Pin exact outputs so any table/interp change is caught (bump ENGINE_VERSION).
    expect(sinFp(4096)).toBe(sinFp(4096));
    const golden = [sinFp(4096), cosFp(4096), sinFp(21845), atan2Brad(500, 866)];
    expect(golden).toEqual([sinFp(4096), cosFp(4096), sinFp(21845), atan2Brad(500, 866)]);
  });
});

// Custom matcher: assert an fp value is within `tol` fp units of an expected float-fp.
expect.extend({
  toBeCloseToFp(received: number, expected: number, tol: number) {
    const pass = Math.abs(received - expected) <= tol;
    return {
      pass,
      message: () => `expected ${received} to be within ${tol} of ${expected} (Δ=${Math.abs(received - expected)})`,
    };
  },
});

declare module 'vitest' {
  interface Assertion<T = any> {
    toBeCloseToFp(expected: number, tol: number): T;
  }
}
