import { describe, it, expect } from 'vitest';
import { Rig } from '../Rig';
import { CRITTER_CORE_RIG } from './critterCore';

// Mirrors Rig.test.ts / bossCore.test.ts's coverage — confirms the same generic
// Rig/FK machinery works unmodified for the smallest-possible RigDef (a single
// non-root bone, no orbiting sockets, no eye/belly split), per design/13's
// "a new rig is new data, not new code" claim extended to a one-bone body.
describe('Rig (critter-core)', () => {
  it('builds exactly the 2 critter-core bones (root + body), no orb/boss bones leaking in', () => {
    const rig = new Rig(CRITTER_CORE_RIG);
    expect([...rig.boneMap.keys()].sort()).toEqual(['body', 'root'].sort());
    expect(rig.boneMap.has('shell')).toBe(false);
    expect(rig.boneMap.has('core')).toBe(false);
    expect(rig.boneMap.has('eye')).toBe(false);
  });

  it('excludes root from selectableBones and timelineBones', () => {
    const rig = new Rig(CRITTER_CORE_RIG);
    expect(rig.selectableBones).not.toContain('root');
    expect(rig.timelineBones).not.toContain('root');
    expect(rig.selectableBones.length).toBe(1);
    expect(rig.selectableBones).toEqual(['body']);
    expect(rig.timelineBones).toEqual(['body']);
  });

  it('exposes drawOrder and defaultShadow straight from the RigDef', () => {
    const rig = new Rig(CRITTER_CORE_RIG);
    expect(rig.drawOrder).toEqual(['body']);
    expect(rig.defaultShadow).toEqual({ w: 50, h: 16 });
  });

  it('computes the body bone position parent-before-child (body sits above root)', () => {
    const rig = new Rig(CRITTER_CORE_RIG);
    const wp = rig.computeFK(0, 0, new Map());
    const root = wp.get('root')!;
    const body = wp.get('body')!;

    expect(root.sx).toBeCloseTo(0);
    expect(root.sy).toBeCloseTo(0);
    expect(body.sx).toBeCloseTo(root.ex);
    expect(body.sy).toBeCloseTo(root.ey);
    expect(body.ey).toBeLessThan(0); // rwa -90 (straight up) => negative Y in screen space
    expect(body.ex).toBeCloseTo(0);
  });

  it('cascades a rotation delta on body into its world angle', () => {
    const rig = new Rig(CRITTER_CORE_RIG);
    const rest = rig.computeFK(0, 0, new Map());
    const transforms = new Map([['body', { rotation: 45, scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, alpha: 1 }]]);
    const rotated = rig.computeFK(0, 0, transforms);

    expect(rotated.get('body')!.wa - rest.get('body')!.wa).toBeCloseTo(45);
  });

  it('respects a length scale override on body', () => {
    const rig = new Rig(CRITTER_CORE_RIG);
    const rest = rig.computeFK(0, 0, new Map());
    const scaled = rig.computeFK(0, 0, new Map(), new Map([['body', 2]]));

    const restLen = Math.hypot(rest.get('body')!.ex - rest.get('body')!.sx, rest.get('body')!.ey - rest.get('body')!.sy);
    const scaledLen = Math.hypot(scaled.get('body')!.ex - scaled.get('body')!.sx, scaled.get('body')!.ey - scaled.get('body')!.sy);
    expect(scaledLen).toBeCloseTo(restLen * 2);
  });

  it('computeNaturalHeight scans the rest pose extent even with no clips', () => {
    const rig = new Rig(CRITTER_CORE_RIG);
    expect(rig.computeNaturalHeight([])).toBeGreaterThan(0);
  });
});
