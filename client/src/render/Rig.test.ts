import { describe, it, expect } from 'vitest';
import { Rig, type RigDef } from './Rig';
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

// ROADMAP: previously a rig with a bone listed before its parent silently computed a
// wrong rla here (defaulting parentRwa to 0) and only crashed later, deep inside
// computeFK, with a bare "Cannot read properties of undefined" pointing nowhere near
// the actual authoring mistake. The constructor now fails fast with a real diagnosis.
describe('Rig — bone ordering validation (parent-before-child)', () => {
  const rigDef = (bones: RigDef['bones']): RigDef => ({ id: 'test-rig', label: 'Test', bones, drawOrder: [] });

  it('constructs fine when every bone lists its parent before itself (the normal case)', () => {
    expect(() => new Rig(rigDef([
      { id: 'root', parent: null, len: 0, rwa: 0, label: 'Root' },
      { id: 'arm', parent: 'root', len: 10, rwa: 0, label: 'Arm' },
      { id: 'hand', parent: 'arm', len: 5, rwa: 0, label: 'Hand' },
    ]))).not.toThrow();
  });

  it('throws a clear, actionable error when a bone lists a parent not yet defined', () => {
    expect(() => new Rig(rigDef([
      { id: 'root', parent: null, len: 0, rwa: 0, label: 'Root' },
      { id: 'hand', parent: 'arm', len: 5, rwa: 0, label: 'Hand' }, // 'arm' comes AFTER this
      { id: 'arm', parent: 'root', len: 10, rwa: 0, label: 'Arm' },
    ]))).toThrow(/bone 'hand' lists parent 'arm'.*not yet defined/);
  });

  it('throws the same way for a parent id that is a plain typo (never defined anywhere)', () => {
    expect(() => new Rig(rigDef([
      { id: 'root', parent: null, len: 0, rwa: 0, label: 'Root' },
      { id: 'arm', parent: 'roor', len: 10, rwa: 0, label: 'Arm' }, // typo: 'roor'
    ]))).toThrow(/bone 'arm' lists parent 'roor'/);
  });

  it('names the offending rig id in the error message', () => {
    const bad: RigDef = { id: 'my-broken-rig', label: 'Broken', drawOrder: [], bones: [
      { id: 'child', parent: 'missing', len: 1, rwa: 0, label: 'Child' },
    ] };
    expect(() => new Rig(bad)).toThrow(/my-broken-rig/);
  });
});
