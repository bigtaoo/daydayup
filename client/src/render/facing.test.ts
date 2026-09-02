import { describe, it, expect } from 'vitest';
import { canonicalAimRad, facingFromAngle, turnToward } from './facing';

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

// `turnToward` — the rate limiter Scene.reconcile runs the body facing through, so an
// auto-aim target switch reads as a turn rather than a twitch (2026-08-18).
describe('turnToward', () => {
  it('steps toward the target by exactly maxStep while still far away', () => {
    expect(turnToward(0, 1, 0.25)).toBeCloseTo(0.25, 6);
    expect(turnToward(0, -1, 0.25)).toBeCloseTo(-0.25, 6);
  });

  it('lands exactly on the target once within reach, with no overshoot or creep', () => {
    expect(turnToward(0, 0.1, 0.25)).toBe(0.1);
    expect(turnToward(0.1, 0.1, 0.25)).toBe(0.1);
  });

  it('takes the SHORT way around the circle, not the long way through zero', () => {
    // From just below +PI to just above -PI is a 0.2 rad hop across the seam. Naive
    // subtraction would read it as ~6.08 rad and turn the body all the way round.
    const from = Math.PI - 0.1;
    const to = -Math.PI + 0.1;
    expect(turnToward(from, to, 0.25)).toBe(to);
    expect(turnToward(to, from, 0.25)).toBe(from);
  });

  it('still picks the short way when the two angles are many turns apart numerically', () => {
    // Same direction, expressed 2 full turns higher — the step must be tiny, not huge.
    const stepped = turnToward(0, Math.PI * 4 + 0.1, 0.25);
    expect(stepped).toBeCloseTo(Math.PI * 4 + 0.1, 6);
  });

  it('never moves further than maxStep for a half-turn, the worst case', () => {
    expect(Math.abs(turnToward(0, Math.PI, 0.27))).toBeCloseTo(0.27, 6);
  });
});

/**
 * `canonicalAimRad` — the pre-mirror space every body-space offset in a rig has to be stated
 * in. It was a private on `RigSkin` until 2026-09-02, reachable only through a posed Pixi rig;
 * four separate call sites now depend on it (socket rotation, the eye slide, the recoil push,
 * the melee swing arc), so it is asserted directly.
 *
 * The property that matters is not the formula, it is what the formula BUYS: after the rig's
 * `view.scale.x = flipX` mirror, an offset built from this angle lands on the same side of the
 * body whichever way the character faces, with the vertical component NOT mirrored.
 */
describe('canonicalAimRad — offsets survive the whole-rig mirror', () => {
  const screen = (rad: number, flipX: 1 | -1) => {
    const a = canonicalAimRad(rad, flipX);
    return { x: flipX * Math.cos(a), y: Math.sin(a) }; // what `view.scale.x` renders
  };

  it('is the identity for a right-facing rig', () => {
    for (const rad of [0, 0.7, -1.2, Math.PI / 2]) expect(canonicalAimRad(rad, 1)).toBe(rad);
  });

  it('a unit offset lands on the TRUE world direction after the mirror, either way round', () => {
    // The whole contract in one assertion, and the bug it prevents: without the pi- reflection a
    // left-facing character's gun points at the mirror image of its reticle.
    for (const rad of [0.3, 1.9, -2.4, Math.PI]) {
      for (const flipX of [1, -1] as const) {
        const s = screen(rad, flipX);
        expect(s.x).toBeCloseTo(Math.cos(rad), 12);
        expect(s.y).toBeCloseTo(Math.sin(rad), 12);
      }
    }
  });

  it('mirrors the horizontal component and leaves the vertical one alone', () => {
    const a = canonicalAimRad(0.6, -1);
    expect(Math.cos(a)).toBeCloseTo(-Math.cos(0.6), 12);
    expect(Math.sin(a)).toBeCloseTo(Math.sin(0.6), 12);
  });

  it('composes with the facing decision the rig actually makes', () => {
    // `facingFromAngle` is what chooses `flipX`, so the two are only correct together.
    for (const rad of [0.4, 2.2, -0.9, -2.8]) {
      const s = screen(rad, facingFromAngle(rad).flipX);
      expect(s.x).toBeCloseTo(Math.cos(rad), 12);
      expect(s.y).toBeCloseTo(Math.sin(rad), 12);
    }
  });
});

/**
 * `canonicalAimRad` — the pre-mirror space every body-space offset in a rig has to be stated
 * in. It was a private on `RigSkin` until 2026-09-02, reachable only through a posed Pixi rig;
 * four separate call sites now depend on it (socket rotation, the eye slide, the recoil push,
 * the melee swing arc), so it is asserted directly.
 *
 * The property that matters is not the formula, it is what the formula BUYS: after the rig's
 * `view.scale.x = flipX` mirror, an offset built from this angle lands on the same side of the
 * body whichever way the character faces, with the vertical component NOT mirrored.
 */
describe('canonicalAimRad — offsets survive the whole-rig mirror', () => {
  const screen = (rad: number, flipX: 1 | -1) => {
    const a = canonicalAimRad(rad, flipX);
    return { x: flipX * Math.cos(a), y: Math.sin(a) }; // what `view.scale.x` renders
  };

  it('is the identity for a right-facing rig', () => {
    for (const rad of [0, 0.7, -1.2, Math.PI / 2]) expect(canonicalAimRad(rad, 1)).toBe(rad);
  });

  it('a unit offset lands on the TRUE world direction after the mirror, either way round', () => {
    // The whole contract in one assertion, and the bug it prevents: without the pi- reflection a
    // left-facing character's gun points at the mirror image of its reticle.
    for (const rad of [0.3, 1.9, -2.4, Math.PI]) {
      for (const flipX of [1, -1] as const) {
        const s = screen(rad, flipX);
        expect(s.x).toBeCloseTo(Math.cos(rad), 12);
        expect(s.y).toBeCloseTo(Math.sin(rad), 12);
      }
    }
  });

  it('mirrors the horizontal component and leaves the vertical one alone', () => {
    const a = canonicalAimRad(0.6, -1);
    expect(Math.cos(a)).toBeCloseTo(-Math.cos(0.6), 12);
    expect(Math.sin(a)).toBeCloseTo(Math.sin(0.6), 12);
  });

  it('composes with the facing decision the rig actually makes', () => {
    // `facingFromAngle` is what chooses `flipX`, so the two are only correct together.
    for (const rad of [0.4, 2.2, -0.9, -2.8]) {
      const s = screen(rad, facingFromAngle(rad).flipX);
      expect(s.x).toBeCloseTo(Math.cos(rad), 12);
      expect(s.y).toBeCloseTo(Math.sin(rad), 12);
    }
  });
});
