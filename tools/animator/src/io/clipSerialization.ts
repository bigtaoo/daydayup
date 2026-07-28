import type { AnimationClip, BoneKeyframe, Keyframe } from '../core/types';

/** Shared clip (de)serialization, split out of IOController.ts 2026-07-28 — both the
 *  `.editortao` project format and the `.tao` runtime bundle store clips this same shape. */

export interface SerializedBoneKeyframe {
  rotation?:   number;
  scaleX?:     number;
  scaleY?:     number;
  translateX?: number;
  translateY?: number;
  alpha?:      number;
  easing?:     string;
}

export interface SerializedKeyframe {
  time:  number;
  bones: Record<string, SerializedBoneKeyframe>;
}

export interface SerializedClip {
  duration:  number;
  loop:      boolean;
  keyframes: SerializedKeyframe[];
}

export function serializeKeyframe(kf: Keyframe): SerializedKeyframe {
  const bones: Record<string, SerializedBoneKeyframe> = {};
  kf.bones.forEach((bkf, id) => { bones[id] = { ...bkf }; });
  return { time: kf.time, bones };
}

export function serializeClip(clip: AnimationClip): SerializedClip {
  return {
    duration:  clip.duration,
    loop:      clip.loop,
    keyframes: clip.keyframes.map(kf => serializeKeyframe(kf)),
  };
}

export function deserializeKeyframe(s: SerializedKeyframe): Keyframe {
  const bones = new Map<string, BoneKeyframe>();
  for (const [id, bkf] of Object.entries(s.bones)) {
    bones.set(id, bkf as BoneKeyframe);
  }
  return { time: s.time, bones };
}

export function deserializeClip(s: SerializedClip): AnimationClip {
  return {
    duration:  s.duration,
    loop:      s.loop,
    keyframes: s.keyframes.map(kf => deserializeKeyframe(kf)),
  };
}
