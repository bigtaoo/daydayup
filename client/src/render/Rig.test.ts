import { describe, it, expect } from 'vitest';
import { Rig } from './Rig';
import { ORB_CORE_RIG } from './orbCoreRig';
import type { ResolvedBoneTransform } from './types';

describe('Rig (orb-core, ported computeFK)', () => {
  it('builds exactly the 6 orb-core bones', () => {
    const rig = new Rig(ORB_CORE_RIG);
    expect([...rig.boneMap.keys()].sort()).toEqual(
      ['belly', 'eye', 'root', 'shell', 'socket_l', 'socket_r'].sort(),
    );
  });

  it('computeFK places root at the given position with zero world angle', () => {
    const rig = new Rig(ORB_CORE_RIG);
    const wp = rig.computeFK(100, 200, new Map());
    const root = wp.get('root')!;
    expect(root.sx).toBe(100);
    expect(root.sy).toBe(200);
    expect(root.wa).toBe(0);
  });

  it('computes child bone positions parent-before-child (shell sits above root)', () => {
    const rig = new Rig(ORB_CORE_RIG);
    const wp = rig.computeFK(0, 0, new Map());
    const shell = wp.get('shell')!;
    expect(shell.sx).toBeCloseTo(0);
    expect(shell.sy).toBeCloseTo(0);
    expect(shell.ey).toBeLessThan(0); // rwa -90 => straight up => negative Y
  });

  it('cascades a parent rotation delta into child world position (sockets follow shell)', () => {
    const rig = new Rig(ORB_CORE_RIG);
    const transforms = new Map<string, ResolvedBoneTransform>([
      ['shell', { rotation: 30, scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, alpha: 1 }],
    ]);
    const rest = rig.computeFK(0, 0, new Map());
    const rotated = rig.computeFK(0, 0, transforms);

    expect(rotated.get('shell')!.wa - rest.get('shell')!.wa).toBeCloseTo(30);
    expect(rotated.get('socket_l')!.sx).not.toBeCloseTo(rest.get('socket_l')!.sx, 3);
  });
});
