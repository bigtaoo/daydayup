import { describe, it, expect } from 'vitest';
import { Rig } from '../Rig';
import { BOSS_CORE_RIG } from './bossCore';

// Mirrors Rig.test.ts's coverage for the orb-core — the point is to confirm
// the SAME generic Rig/FK machinery works unmodified for a second, structurally
// different RigDef (no eye/belly/sockets, a different bone count and diagonal
// rest angles), per design/12's "a new rig is new data, not new code" claim.
describe('Rig (boss-core)', () => {
  it('builds exactly the 4 boss-core bones, no orb-core bones leaking in', () => {
    const rig = new Rig(BOSS_CORE_RIG);
    expect([...rig.boneMap.keys()].sort()).toEqual(['core', 'ring_a', 'ring_b', 'root'].sort());
    expect(rig.boneMap.has('shell')).toBe(false);
    expect(rig.boneMap.has('eye')).toBe(false);
    expect(rig.boneMap.has('socket_l')).toBe(false);
  });

  it('excludes root from selectableBones and timelineBones', () => {
    const rig = new Rig(BOSS_CORE_RIG);
    expect(rig.selectableBones).not.toContain('root');
    expect(rig.timelineBones).not.toContain('root');
    expect(rig.selectableBones.length).toBe(3);
  });

  it('computes child bone positions parent-before-child (core sits above root)', () => {
    const rig = new Rig(BOSS_CORE_RIG);
    const wp = rig.computeFK(0, 0, new Map());
    const core = wp.get('core')!;
    expect(core.sy).toBeCloseTo(0);
    expect(core.ey).toBeLessThan(0); // rwa -90 (straight up) => negative Y in screen space
  });

  it('rings orbit at diagonal rest angles, not directly left/right like the hero sockets', () => {
    const rig = new Rig(BOSS_CORE_RIG);
    const wp = rig.computeFK(0, 0, new Map());
    const ringA = wp.get('ring_a')!;
    const ringB = wp.get('ring_b')!;
    // Both rings' tips are offset in BOTH x and y from the core's tip — a
    // purely-horizontal orbit (like socket_l/r) would have one axis ~= 0.
    const coreTip = wp.get('core')!;
    expect(Math.abs(ringA.ex - coreTip.ex)).toBeGreaterThan(1);
    expect(Math.abs(ringA.ey - coreTip.ey)).toBeGreaterThan(1);
    expect(Math.abs(ringB.ex - coreTip.ex)).toBeGreaterThan(1);
    expect(Math.abs(ringB.ey - coreTip.ey)).toBeGreaterThan(1);
  });

  it('cascades a parent rotation delta into child world angle (rings follow core)', () => {
    const rig = new Rig(BOSS_CORE_RIG);
    const transforms = new Map([['core', { rotation: 30, scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, alpha: 1 }]]);
    const rest    = rig.computeFK(0, 0, new Map());
    const rotated = rig.computeFK(0, 0, transforms);
    expect(rotated.get('core')!.wa - rest.get('core')!.wa).toBeCloseTo(30);
    expect(rotated.get('ring_a')!.sx).not.toBeCloseTo(rest.get('ring_a')!.sx, 3);
  });

  it('computeNaturalHeight scans the rest pose extent even with no clips', () => {
    const rig = new Rig(BOSS_CORE_RIG);
    expect(rig.computeNaturalHeight([])).toBeGreaterThan(0);
  });
});
