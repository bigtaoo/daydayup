import { describe, it, expect } from 'vitest';
import { sampleClip, interpolateBone, applyEasing } from './interpolate';
import type { AnimationClip } from '../core/types';

describe('interpolate (ported verbatim from funny — smoke test)', () => {
  it('applyEasing: linear is identity, step jumps at t=1', () => {
    expect(applyEasing(0.5, 'linear')).toBeCloseTo(0.5);
    expect(applyEasing(0.99, 'step')).toBe(0);
    expect(applyEasing(1, 'step')).toBe(1);
  });

  it('interpolateBone lerps rotation/scale/translate/alpha halfway', () => {
    const result = interpolateBone(
      { rotation: 0, translateY: 0, alpha: 1 },
      { rotation: 10, translateY: -6, alpha: 0.4 },
      0.5,
    );
    expect(result.rotation).toBeCloseTo(5);
    expect(result.translateY).toBeCloseTo(-3);
    expect(result.alpha).toBeCloseTo(0.7);
  });

  it('sampleClip resolves each bone independently and holds edge values outside its keyframe range', () => {
    const clip: AnimationClip = {
      duration: 2,
      loop: true,
      keyframes: [
        { time: 0, bones: new Map([['shell', { translateY: 0 }]]) },
        { time: 1, bones: new Map([['shell', { translateY: -6 }], ['eye', { alpha: 0.5 }]]) },
        { time: 2, bones: new Map([['shell', { translateY: 0 }]]) },
      ],
    };

    const mid = sampleClip(clip, 0.5);
    expect(mid.get('shell')!.translateY).toBeCloseTo(-3);

    // 'eye' only has a keyframe at t=1 — before it, sampleClip holds that value (no kf1 yet)
    const before = sampleClip(clip, 0.2);
    expect(before.get('eye')!.alpha).toBeCloseTo(0.5);
  });
});
