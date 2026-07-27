import { describe, it, expect } from 'vitest';
import { facingFromAim } from './facing';

describe('facingFromAim (design/12 two-hemisphere billboard model)', () => {
  it('aiming right (0 rad) is unflipped, front hemisphere (dy=0 counts as front)', () => {
    expect(facingFromAim(0)).toEqual({ flipX: 1, showBack: false });
  });

  it('aiming left (π rad) flips L/R, stays front hemisphere', () => {
    expect(facingFromAim(Math.PI)).toEqual({ flipX: -1, showBack: false });
  });

  it('aiming down-screen/toward camera (π/2) is the front hemisphere', () => {
    expect(facingFromAim(Math.PI / 2).showBack).toBe(false);
  });

  it('aiming up-screen/away from camera (-π/2) is the back hemisphere', () => {
    expect(facingFromAim(-Math.PI / 2).showBack).toBe(true);
  });

  it('flips independently of hemisphere (down-left vs down-right)', () => {
    const downRight = facingFromAim(Math.PI / 4);
    const downLeft = facingFromAim((3 * Math.PI) / 4);
    expect(downRight.flipX).toBe(1);
    expect(downLeft.flipX).toBe(-1);
    expect(downRight.showBack).toBe(downLeft.showBack);
  });
});
