/**
 * Render-side unit conversion (design/06 "fromFp is render-only, never in logic").
 * Both functions are one-liners over the engine's fixed-point/brad constants
 * (FP_SCALE=1000, WORLD.pxPerGrid=32, WORLD.bradFull=65536) — pin the actual
 * conversion factors, not just "it returns a number".
 */
import { describe, it, expect } from 'vitest';
import { WORLD, toFp } from '@dd/engine';
import { fpToPx, bradToRad, PX_PER_GRID } from './coords';

describe('fpToPx', () => {
  it('converts 0 fp to 0 px', () => {
    expect(fpToPx(toFp(0))).toBe(0);
  });

  it('converts exactly 1 grid unit of fp to PX_PER_GRID px', () => {
    expect(fpToPx(toFp(1))).toBe(PX_PER_GRID);
    expect(PX_PER_GRID).toBe(WORLD.pxPerGrid);
  });

  it('converts a fractional grid amount proportionally', () => {
    expect(fpToPx(toFp(2.5))).toBeCloseTo(2.5 * WORLD.pxPerGrid, 6);
  });

  it('handles negative fp (movement the other direction)', () => {
    expect(fpToPx(toFp(-3))).toBeCloseTo(-3 * WORLD.pxPerGrid, 6);
  });
});

describe('bradToRad', () => {
  it('converts 0 brad to 0 rad', () => {
    expect(bradToRad(0)).toBe(0);
  });

  it('converts a full turn (WORLD.bradFull) to 2π', () => {
    expect(bradToRad(WORLD.bradFull)).toBeCloseTo(Math.PI * 2, 10);
  });

  it('converts a quarter turn to π/2', () => {
    expect(bradToRad(WORLD.bradFull / 4)).toBeCloseTo(Math.PI / 2, 10);
  });

  it('converts a half turn to π', () => {
    expect(bradToRad(WORLD.bradFull / 2)).toBeCloseTo(Math.PI, 10);
  });
});
