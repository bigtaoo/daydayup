import { describe, it, expect } from 'vitest';
import { PRESETS, clonePreset } from './presets';

describe('clonePreset', () => {
  it('returns null for an unknown preset name', () => {
    expect(clonePreset('does-not-exist')).toBeNull();
  });

  it('returns a clip with the same duration, loop, and keyframe times as the original', () => {
    const clone = clonePreset('idle')!;
    const original = PRESETS.idle;

    expect(clone.duration).toBe(original.duration);
    expect(clone.loop).toBe(original.loop);
    expect(clone.keyframes.map(kf => kf.time)).toEqual(original.keyframes.map(kf => kf.time));
  });

  it('produces a clip object that is not the same reference as the preset', () => {
    const clone = clonePreset('idle')!;
    expect(clone).not.toBe(PRESETS.idle);
  });

  it('produces keyframe objects that are not the same references as the original', () => {
    const clone = clonePreset('idle')!;
    const original = PRESETS.idle;

    clone.keyframes.forEach((kf, i) => {
      expect(kf).not.toBe(original.keyframes[i]);
      expect(kf.bones).not.toBe(original.keyframes[i].bones);
    });
  });

  it('produces bone-keyframe objects that are not shared with the original (independence guarantee)', () => {
    const clone = clonePreset('idle')!;
    const original = PRESETS.idle;

    for (let i = 0; i < clone.keyframes.length; i++) {
      const cloneBones = clone.keyframes[i].bones;
      const originalBones = original.keyframes[i].bones;
      for (const [boneId, cloneBkf] of cloneBones) {
        expect(cloneBkf).not.toBe(originalBones.get(boneId));
      }
    }
  });

  it('mutating the cloned clip does not affect the original preset — top-level fields', () => {
    const clone = clonePreset('idle')!;
    const original = PRESETS.idle;
    const originalDuration = original.duration;
    const originalLoop = original.loop;

    clone.duration = 999;
    clone.loop = !original.loop;

    expect(original.duration).toBe(originalDuration);
    expect(original.loop).toBe(originalLoop);
  });

  it('mutating the cloned keyframes array does not affect the original', () => {
    const clone = clonePreset('idle')!;
    const original = PRESETS.idle;
    const originalLength = original.keyframes.length;

    clone.keyframes.push({ time: 999, bones: new Map() });
    clone.keyframes.splice(0, 1);

    expect(original.keyframes.length).toBe(originalLength);
  });

  it('mutating a bone keyframe field on the clone does not affect the original preset', () => {
    const clone = clonePreset('idle')!;
    const original = PRESETS.idle;

    const cloneShellKf0 = clone.keyframes[0].bones.get('shell')!;
    const originalShellKf0 = original.keyframes[0].bones.get('shell')!;
    const originalTranslateY = originalShellKf0.translateY;

    cloneShellKf0.translateY = 12345;

    expect(originalShellKf0.translateY).toBe(originalTranslateY);
  });

  it('adding a new bone entry to the clone`s keyframe bones map does not affect the original', () => {
    const clone = clonePreset('idle')!;
    const original = PRESETS.idle;

    clone.keyframes[0].bones.set('brand_new_bone', { rotation: 1 });

    expect(original.keyframes[0].bones.has('brand_new_bone')).toBe(false);
  });

  it('works for every registered preset, not just idle', () => {
    for (const name of Object.keys(PRESETS)) {
      const clone = clonePreset(name);
      expect(clone).not.toBeNull();
      expect(clone).not.toBe(PRESETS[name]);
    }
  });
});
