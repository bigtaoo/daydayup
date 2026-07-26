import { describe, it, expect } from 'vitest';
import { Rig } from './Rig';
import { ORB_CORE_RIG } from './rigs/orbCore';
import type { ResolvedBoneTransform } from '../core/types';

describe('Rig (orb-core)', () => {
  it('builds exactly the 6 orb-core bones with no leftover humanoid bones', () => {
    const rig = new Rig(ORB_CORE_RIG);
    expect([...rig.boneMap.keys()].sort()).toEqual(
      ['belly', 'eye', 'root', 'shell', 'socket_l', 'socket_r'].sort(),
    );
    expect(rig.boneMap.has('spine')).toBe(false);
    expect(rig.boneMap.has('head')).toBe(false);
    expect(rig.boneMap.has('r_upper_arm')).toBe(false);
  });

  it('excludes root from selectableBones and timelineBones', () => {
    const rig = new Rig(ORB_CORE_RIG);
    expect(rig.selectableBones).not.toContain('root');
    expect(rig.timelineBones).not.toContain('root');
    expect(rig.selectableBones.length).toBe(5);
  });

  it('computeFK places root at the given position with zero world angle', () => {
    const rig = new Rig(ORB_CORE_RIG);
    const wp = rig.computeFK(100, 200, new Map());
    const root = wp.get('root')!;
    expect(root.sx).toBe(100);
    expect(root.sy).toBe(200);
    expect(root.ex).toBe(100);
    expect(root.ey).toBe(200);
    expect(root.wa).toBe(0);
  });

  it('computes child bone positions parent-before-child (shell sits above root)', () => {
    const rig = new Rig(ORB_CORE_RIG);
    const wp = rig.computeFK(0, 0, new Map());
    const shell = wp.get('shell')!;
    // rwa -90 (straight up) => negative Y in screen space
    expect(shell.sx).toBeCloseTo(0);
    expect(shell.sy).toBeCloseTo(0);
    expect(shell.ey).toBeLessThan(0);
    expect(Math.abs(shell.ex)).toBeCloseTo(0, 5);
  });

  it('cascades a parent rotation delta into child world angle (eye/belly/sockets follow shell)', () => {
    const rig = new Rig(ORB_CORE_RIG);
    const transforms = new Map<string, ResolvedBoneTransform>([
      ['shell', { rotation: 30, scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, alpha: 1 }],
    ]);
    const rest   = rig.computeFK(0, 0, new Map());
    const rotated = rig.computeFK(0, 0, transforms);

    // shell's own world angle shifted by exactly the rotation delta
    expect(rotated.get('shell')!.wa - rest.get('shell')!.wa).toBeCloseTo(30);
    // socket_l/socket_r pivot from shell's tip, which moved — so their world
    // position differs from rest even though they carry no rotation of their own.
    expect(rotated.get('socket_l')!.sx).not.toBeCloseTo(rest.get('socket_l')!.sx, 3);
  });

  it('applies bone length scales multiplicatively', () => {
    const rig = new Rig(ORB_CORE_RIG);
    const rest   = rig.computeFK(0, 0, new Map());
    const scaled = rig.computeFK(0, 0, new Map(), new Map([['socket_r', 2]]));
    const restLen   = Math.hypot(rest.get('socket_r')!.ex - rest.get('socket_r')!.sx, rest.get('socket_r')!.ey - rest.get('socket_r')!.sy);
    const scaledLen = Math.hypot(scaled.get('socket_r')!.ex - scaled.get('socket_r')!.sx, scaled.get('socket_r')!.ey - scaled.get('socket_r')!.sy);
    expect(scaledLen).toBeCloseTo(restLen * 2, 5);
  });

  it('computeNaturalHeight scans the rest pose extent even with no clips, and grows with a moving clip', () => {
    const rig = new Rig(ORB_CORE_RIG);
    const restOnly = rig.computeNaturalHeight([]);
    expect(restOnly).toBeGreaterThan(0);

    const clip = {
      duration: 1,
      loop: false,
      keyframes: [
        { time: 0, bones: new Map([['socket_r', { rotation: 90 }]]) },
      ],
    };
    expect(rig.computeNaturalHeight([clip])).toBeGreaterThanOrEqual(restOnly);
  });
});
