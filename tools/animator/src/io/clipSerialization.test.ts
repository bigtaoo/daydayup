import { describe, it, expect } from 'vitest';
import type { AnimationClip, BoneKeyframe, Keyframe } from '../core/types';
import {
  serializeKeyframe,
  serializeClip,
  deserializeKeyframe,
  deserializeClip,
  type SerializedKeyframe,
  type SerializedClip,
} from './clipSerialization';

describe('serializeKeyframe', () => {
  it('converts the bones Map into a plain Record, keeping time as-is', () => {
    const bkf: BoneKeyframe = { rotation: 30, scaleX: 1.2, easing: 'ease-in' };
    const kf: Keyframe = { time: 0.5, bones: new Map([['shell', bkf]]) };

    const out = serializeKeyframe(kf);

    expect(out).toEqual({ time: 0.5, bones: { shell: { rotation: 30, scaleX: 1.2, easing: 'ease-in' } } });
  });

  it('copies each bone keyframe object rather than sharing the reference', () => {
    const bkf: BoneKeyframe = { rotation: 10 };
    const kf: Keyframe = { time: 0, bones: new Map([['shell', bkf]]) };

    const out = serializeKeyframe(kf);
    out.bones.shell.rotation = 999;

    expect(bkf.rotation).toBe(10);
  });

  it('handles an empty bones map', () => {
    const kf: Keyframe = { time: 1, bones: new Map() };
    expect(serializeKeyframe(kf)).toEqual({ time: 1, bones: {} });
  });

  it('handles multiple bones', () => {
    const kf: Keyframe = {
      time: 2,
      bones: new Map([
        ['shell', { rotation: 5 }],
        ['eye', { alpha: 0.5 }],
      ]),
    };

    expect(serializeKeyframe(kf)).toEqual({
      time: 2,
      bones: { shell: { rotation: 5 }, eye: { alpha: 0.5 } },
    });
  });
});

describe('serializeClip', () => {
  it('serializes duration, loop, and every keyframe', () => {
    const clip: AnimationClip = {
      duration: 1.5,
      loop: true,
      keyframes: [
        { time: 0, bones: new Map([['shell', { rotation: 0 }]]) },
        { time: 1.5, bones: new Map([['shell', { rotation: 90 }]]) },
      ],
    };

    const out = serializeClip(clip);

    expect(out).toEqual({
      duration: 1.5,
      loop: true,
      keyframes: [
        { time: 0, bones: { shell: { rotation: 0 } } },
        { time: 1.5, bones: { shell: { rotation: 90 } } },
      ],
    });
  });

  it('serializes a clip with no keyframes', () => {
    const clip: AnimationClip = { duration: 0, loop: false, keyframes: [] };
    expect(serializeClip(clip)).toEqual({ duration: 0, loop: false, keyframes: [] });
  });
});

describe('deserializeKeyframe', () => {
  it('converts the bones Record back into a Map, keeping time as-is', () => {
    const s: SerializedKeyframe = { time: 0.5, bones: { shell: { rotation: 30, easing: 'ease-out' } } };

    const kf = deserializeKeyframe(s);

    expect(kf.time).toBe(0.5);
    expect(kf.bones).toBeInstanceOf(Map);
    expect(kf.bones.get('shell')).toEqual({ rotation: 30, easing: 'ease-out' });
  });

  it('handles an empty bones record', () => {
    const kf = deserializeKeyframe({ time: 0, bones: {} });
    expect(kf.bones.size).toBe(0);
  });

  it('handles multiple bones', () => {
    const kf = deserializeKeyframe({
      time: 1,
      bones: { shell: { rotation: 1 }, eye: { alpha: 0.2 } },
    });

    expect([...kf.bones.keys()].sort()).toEqual(['eye', 'shell']);
    expect(kf.bones.get('eye')).toEqual({ alpha: 0.2 });
  });
});

describe('deserializeClip', () => {
  it('reconstructs duration, loop, and every keyframe as Keyframe objects', () => {
    const s: SerializedClip = {
      duration: 0.9,
      loop: false,
      keyframes: [
        { time: 0, bones: { shell: { alpha: 1 } } },
        { time: 0.9, bones: { shell: { alpha: 0 } } },
      ],
    };

    const clip = deserializeClip(s);

    expect(clip.duration).toBe(0.9);
    expect(clip.loop).toBe(false);
    expect(clip.keyframes).toHaveLength(2);
    expect(clip.keyframes[0].bones.get('shell')).toEqual({ alpha: 1 });
    expect(clip.keyframes[1].bones.get('shell')).toEqual({ alpha: 0 });
  });

  it('handles a clip with no keyframes', () => {
    const clip = deserializeClip({ duration: 0, loop: true, keyframes: [] });
    expect(clip.keyframes).toEqual([]);
  });
});

describe('serialize/deserialize round trip', () => {
  it('deserializeClip(serializeClip(clip)) reproduces the same logical clip', () => {
    const original: AnimationClip = {
      duration: 0.6,
      loop: true,
      keyframes: [
        { time: 0,    bones: new Map([['shell', { rotation: 10, translateY: 0 }], ['eye', { translateY: 0 }]]) },
        { time: 0.3,  bones: new Map([['shell', { rotation: 10, translateY: -5 }]]) },
      ],
    };

    const roundTripped = deserializeClip(serializeClip(original));

    expect(roundTripped.duration).toBe(original.duration);
    expect(roundTripped.loop).toBe(original.loop);
    expect(roundTripped.keyframes).toHaveLength(original.keyframes.length);
    roundTripped.keyframes.forEach((kf, i) => {
      expect(kf.time).toBe(original.keyframes[i].time);
      expect([...kf.bones.entries()]).toEqual([...original.keyframes[i].bones.entries()]);
    });
  });
});
