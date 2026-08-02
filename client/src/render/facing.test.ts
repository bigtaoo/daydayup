import { describe, it, expect } from 'vitest';
import { facingFromAngle } from './facing';

describe('facingFromAngle (design/12 two-hemisphere billboard model, drives body facing)', () => {
  it('facing right (0 rad) is unflipped, front hemisphere (dy=0 counts as front)', () => {
    expect(facingFromAngle(0)).toEqual({ flipX: 1, showBack: false });
  });

  it('facing left (π rad) flips L/R, stays front hemisphere', () => {
    expect(facingFromAngle(Math.PI)).toEqual({ flipX: -1, showBack: false });
  });

  it('facing down-screen/toward camera (π/2) is the front hemisphere', () => {
    expect(facingFromAngle(Math.PI / 2).showBack).toBe(false);
  });

  it('facing up-screen/away from camera (-π/2) is the back hemisphere', () => {
    expect(facingFromAngle(-Math.PI / 2).showBack).toBe(true);
  });

  it('flips independently of hemisphere (down-left vs down-right)', () => {
    const downRight = facingFromAngle(Math.PI / 4);
    const downLeft = facingFromAngle((3 * Math.PI) / 4);
    expect(downRight.flipX).toBe(1);
    expect(downLeft.flipX).toBe(-1);
    expect(downRight.showBack).toBe(downLeft.showBack);
  });
});
