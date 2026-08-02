import { describe, it, expect } from 'vitest';
import { BRAD_QUARTER, BRAD_HALF, bradDiff } from '@dd/engine/math/trig';
import { MOVE_MAG_MAX, quantizeAim, quantizeMove } from '@dd/engine/state/input';

describe('input-edge quantization (design/06/08)', () => {
  it('a zero move vector is idle: mag 0, brad 0', () => {
    expect(quantizeMove(0, 0)).toEqual({ moveBrad: 0, moveMag: 0 });
  });

  it('clamps an over-length vector to full deflection', () => {
    expect(quantizeMove(3, 4).moveMag).toBe(MOVE_MAG_MAX); // len 5 → clamped to 1
  });

  it('scales magnitude linearly for a partial stick', () => {
    expect(quantizeMove(0.5, 0).moveMag).toBe(Math.round(0.5 * MOVE_MAG_MAX));
  });

  it('move direction lands in the right quadrant', () => {
    expect(quantizeMove(1, 0).moveBrad).toBe(0); // +x
    expect(bradDiff(quantizeMove(0, 1).moveBrad, BRAD_QUARTER)).toBe(0); // +y
  });

  it('aim quantizes a world delta to an integer brad', () => {
    expect(quantizeAim(1, 0)).toBe(0);
    expect(quantizeAim(-1, 0)).toBe(BRAD_HALF);
    expect(Number.isInteger(quantizeAim(0.37, -0.91))).toBe(true);
  });
});
