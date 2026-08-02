/**
 * Entity — the base render view. Covers `pushState`'s `bodyFacingRad` param: it
 * defaults to `facingRad` (every entity except a player view — enemies, bullets,
 * pickups — has no separate body orientation, see Actor's upper/lower body split),
 * but can be overridden independently, and both are held (not interpolated) exactly
 * like the pre-existing `facingRad` — angles snap to the current tick's value.
 */
import { describe, it, expect } from 'vitest';
import { Entity } from './Entity';

describe('Entity.pushState — bodyFacingRad', () => {
  it('defaults bodyFacingRad to facingRad when omitted', () => {
    const e = new Entity();
    e.pushState(0, 0, 0, Math.PI / 2);
    expect(e.facingRad).toBe(Math.PI / 2);
    expect(e.bodyFacingRad).toBe(Math.PI / 2);
  });

  it('accepts an independent bodyFacingRad', () => {
    const e = new Entity();
    e.pushState(0, 0, 0, Math.PI, -Math.PI / 2);
    expect(e.facingRad).toBe(Math.PI);
    expect(e.bodyFacingRad).toBe(-Math.PI / 2);
  });

  it('both angles snap to the latest tick — no interpolation/wrap smoothing', () => {
    const e = new Entity();
    e.pushState(0, 0, 0, 0, 0);
    e.pushState(1, 1, 0, Math.PI, Math.PI / 2);
    expect(e.facingRad).toBe(Math.PI);
    expect(e.bodyFacingRad).toBe(Math.PI / 2);
  });
});
