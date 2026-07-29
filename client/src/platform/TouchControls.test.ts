import { describe, it, expect, beforeEach } from 'vitest';
import { TouchControls } from './TouchControls';

// width=1000, height=500 → unit=500 gives round numbers throughout:
// stickRadius=90, button r=40, margin m=60, gap=96
// weapon1 = { cx: 940, cy: 60, r: 40 }, weapon2 = { cx: 844, cy: 60, r: 40 }
function laidOut(): TouchControls {
  const c = new TouchControls();
  c.layout(1000, 500);
  return c;
}

describe('TouchControls.layout', () => {
  it('sizes the stick radius and corner buttons off the shorter screen dimension', () => {
    const c = laidOut();
    const v = c.getVisual();
    expect(v.stickRadius).toBe(90);
    expect(v.weapon1).toEqual({ cx: 940, cy: 60, r: 40 });
    expect(v.weapon2).toEqual({ cx: 844, cy: 60, r: 40 });
  });
});

describe('TouchControls movement stick', () => {
  let c: TouchControls;
  beforeEach(() => { c = laidOut(); });

  it('opens a move stick at the touch-down origin on the left half', () => {
    c.pointerDown(1, 100, 100);
    expect(c.hasActiveTouch()).toBe(true);
    expect(c.getVisual().move).toEqual({ ox: 100, oy: 100, dx: 0, dy: 0 });
    expect(c.getVisual().aim).toBeNull();
  });

  it('tracks drag offset within the stick radius, unclamped', () => {
    c.pointerDown(1, 100, 100);
    c.pointerMove(1, 150, 150); // dx=50, dy=50, len≈70.7 < 90
    const move = c.getVisual().move!;
    expect(move.dx).toBeCloseTo(50);
    expect(move.dy).toBeCloseTo(50);
    expect(c.read().moveX).toBeCloseTo(50 / 90);
    expect(c.read().moveY).toBeCloseTo(50 / 90);
  });

  it('clamps drag magnitude to the stick radius past the edge', () => {
    c.pointerDown(1, 100, 100);
    c.pointerMove(1, 300, 100); // dx=200, dy=0, len=200 > 90
    const move = c.getVisual().move!;
    expect(move.dx).toBeCloseTo(90);
    expect(move.dy).toBeCloseTo(0);
    expect(c.read().moveX).toBeCloseTo(1);
  });

  it('clears on pointerUp for the matching id', () => {
    c.pointerDown(1, 100, 100);
    c.pointerUp(1);
    expect(c.hasActiveTouch()).toBe(false);
    expect(c.getVisual().move).toBeNull();
  });

  it('ignores pointerMove/pointerUp for a non-matching id', () => {
    c.pointerDown(1, 100, 100);
    c.pointerMove(2, 999, 999); // a second, unrelated touch id
    expect(c.getVisual().move).toEqual({ ox: 100, oy: 100, dx: 0, dy: 0 });
    c.pointerUp(2);
    expect(c.hasActiveTouch()).toBe(true); // stick 1 is untouched by id 2's pointerUp
  });
});

describe('TouchControls aim/fire stick', () => {
  let c: TouchControls;
  beforeEach(() => { c = laidOut(); });

  it('opens an aim stick at the touch-down origin on the right half', () => {
    c.pointerDown(2, 600, 100);
    expect(c.getVisual().aim).toEqual({ ox: 600, oy: 100, dx: 0, dy: 0 });
    expect(c.getVisual().move).toBeNull();
  });

  it('an idle (untouched) aim stick reports no direction and does not fire', () => {
    c.pointerDown(2, 600, 100);
    const inp = c.read();
    expect(inp.aim).toEqual({ mode: 'dir', dx: 0, dy: 0 });
    expect(inp.firing).toBe(false);
  });

  it('a dragged aim stick reports a unit direction and fires', () => {
    c.pointerDown(2, 600, 100);
    c.pointerMove(2, 630, 60); // dx=30, dy=-40 → a 3-4-5 triangle, magnitude 50
    const inp = c.read();
    expect(inp.firing).toBe(true);
    expect(inp.aim.mode).toBe('dir');
    if (inp.aim.mode === 'dir') {
      expect(inp.aim.dx).toBeCloseTo(0.6);
      expect(inp.aim.dy).toBeCloseTo(-0.8);
    }
  });

  it('a bare tap-and-hold (zero drag) does not fire, matching the visual "held" threshold', () => {
    c.pointerDown(2, 600, 100);
    c.pointerMove(2, 600, 100); // no actual movement
    expect(c.read().firing).toBe(false);
  });
});

describe('TouchControls weapon-swap buttons', () => {
  let c: TouchControls;
  let switched: number[];
  beforeEach(() => {
    c = laidOut();
    switched = [];
    c.onSwitchWeapon = (slot) => switched.push(slot);
  });

  it('tapping weapon1 fires the callback and opens no stick', () => {
    c.pointerDown(1, 940, 60); // dead centre of weapon1
    expect(switched).toEqual([1]);
    expect(c.hasActiveTouch()).toBe(false);
    expect(c.getVisual().aim).toBeNull();
  });

  it('tapping weapon2 fires the callback and opens no stick', () => {
    c.pointerDown(1, 844, 60); // dead centre of weapon2
    expect(switched).toEqual([2]);
    expect(c.hasActiveTouch()).toBe(false);
  });

  it('buttons take priority over the stick zones even though both sit in the right half', () => {
    // Exactly on weapon1's edge (still inside the circle) — would otherwise start an aim stick.
    c.pointerDown(1, 940 + 39, 60);
    expect(switched).toEqual([1]);
    expect(c.getVisual().aim).toBeNull();
  });

  it('a touch just outside both button circles falls through to the aim stick', () => {
    c.pointerDown(1, 940 + 41, 60); // 41 > r(40), and far from weapon2 too
    expect(switched).toEqual([]);
    expect(c.getVisual().aim).not.toBeNull();
  });
});

describe('TouchControls.getVisual().active', () => {
  it('starts false, and never touches everything else before any touch', () => {
    const c = laidOut();
    expect(c.getVisual().active).toBe(false);
  });

  it('flips true on the very first pointerDown and never resets', () => {
    const c = laidOut();
    c.pointerDown(1, 100, 100);
    expect(c.getVisual().active).toBe(true);
    c.pointerUp(1);
    expect(c.getVisual().active).toBe(true); // stays true — "this session uses touch"
  });

  it('flips true even for a button tap, which never opens a stick', () => {
    const c = laidOut();
    c.pointerDown(1, 940, 60); // weapon1 button
    expect(c.getVisual().active).toBe(true);
  });
});
