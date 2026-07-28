/**
 * Ported verbatim from tools/animator/src/animation/interpolate.ts — pure
 * interpolation functions, no DOM/Pixi, shared between the editor and the
 * game-side runtime (design/12).
 */
import type { EasingType, BoneKeyframe, ResolvedBoneTransform, AnimationClip } from './types';

export function applyEasing(t: number, type: EasingType = 'linear'): number {
  switch (type) {
    case 'ease-in': return t * t;
    case 'ease-out': return t * (2 - t);
    case 'ease-in-out': return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    case 'step': return t < 1 ? 0 : 1;
    default: return t;
  }
}

const DEFAULTS: Required<Omit<BoneKeyframe, 'easing'>> = {
  rotation: 0, scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, alpha: 1,
};

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function interpolateBone(kf1: BoneKeyframe, kf2: BoneKeyframe, f: number): ResolvedBoneTransform {
  const ef = applyEasing(f, kf1.easing ?? 'linear');
  return {
    rotation: lerp(kf1.rotation ?? DEFAULTS.rotation, kf2.rotation ?? DEFAULTS.rotation, ef),
    scaleX: lerp(kf1.scaleX ?? DEFAULTS.scaleX, kf2.scaleX ?? DEFAULTS.scaleX, ef),
    scaleY: lerp(kf1.scaleY ?? DEFAULTS.scaleY, kf2.scaleY ?? DEFAULTS.scaleY, ef),
    translateX: lerp(kf1.translateX ?? DEFAULTS.translateX, kf2.translateX ?? DEFAULTS.translateX, ef),
    translateY: lerp(kf1.translateY ?? DEFAULTS.translateY, kf2.translateY ?? DEFAULTS.translateY, ef),
    alpha: lerp(kf1.alpha ?? DEFAULTS.alpha, kf2.alpha ?? DEFAULTS.alpha, ef),
  };
}

function resolveOne(kf: BoneKeyframe): ResolvedBoneTransform {
  return {
    rotation: kf.rotation ?? DEFAULTS.rotation,
    scaleX: kf.scaleX ?? DEFAULTS.scaleX,
    scaleY: kf.scaleY ?? DEFAULTS.scaleY,
    translateX: kf.translateX ?? DEFAULTS.translateX,
    translateY: kf.translateY ?? DEFAULTS.translateY,
    alpha: kf.alpha ?? DEFAULTS.alpha,
  };
}

/**
 * Sample an AnimationClip at time t, returning every bone's resolved transform.
 *
 * Perf (2026-07-28): real clips are tiny (3-5 keyframes, 1-5 bones each — checked
 * against orb-core's own shipped clips), so the two linear scans below cost
 * nothing; the actual per-frame cost this rewrite removes is the previous
 * version's 4 `Map`/`Set` ALLOCATIONS (kf1Map/kf2Map/boneIds/result) plus two
 * `.forEach` closures, at ~60fps × every rigged actor on screen. Same two-pass,
 * overwrite-in-scan-order algorithm as before (forward pass keeps the LATEST
 * at-or-before-t keyframe per bone by letting later writes win; backward pass
 * keeps the EARLIEST after-t keyframe per bone the same way) — just backed by
 * plain objects instead of Map/Set, since bone ids are always plain strings.
 * `interpolate.test.ts`'s sparse-per-bone-keyframe case guards this stayed
 * behavior-identical.
 */
export function sampleClip(clip: AnimationClip, t: number): Map<string, ResolvedBoneTransform> {
  const result = new Map<string, ResolvedBoneTransform>();
  const kfs = clip.keyframes;
  if (kfs.length === 0) return result;

  const kf1ByBone: Record<string, { kf: typeof kfs[number]; idx: number }> = Object.create(null);
  for (let i = 0; i < kfs.length; i++) {
    if (kfs[i].time > t) break;
    for (const id of kfs[i].bones.keys()) kf1ByBone[id] = { kf: kfs[i], idx: i };
  }

  const kf2ByBone: Record<string, typeof kfs[number]> = Object.create(null);
  for (let i = kfs.length - 1; i >= 0; i--) {
    if (kfs[i].time <= t) break;
    for (const id of kfs[i].bones.keys()) kf2ByBone[id] = kfs[i];
  }

  for (const boneId in kf1ByBone) {
    const entry1 = kf1ByBone[boneId]!;
    const kf2 = kf2ByBone[boneId];
    if (!kf2) { result.set(boneId, resolveOne(entry1.kf.bones.get(boneId)!)); continue; }
    const kf1 = entry1.kf;
    const span = kf2.time - kf1.time;
    const f = span > 0 ? (t - kf1.time) / span : 0;
    result.set(boneId, interpolateBone(kf1.bones.get(boneId)!, kf2.bones.get(boneId)!, f));
    delete kf2ByBone[boneId]; // processed via the kf1+kf2 pair path — don't re-visit below
  }
  for (const boneId in kf2ByBone) {
    result.set(boneId, resolveOne(kf2ByBone[boneId]!.bones.get(boneId)!));
  }

  return result;
}
