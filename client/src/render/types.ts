// Ported from tools/animator/src/core/types.ts (design/12: the FK/interpolation
// math is dependency-free by design, meant to be copied straight into the game's
// render side). Kept as a separate copy, not a shared package — tools/animator
// and client are independent Vite projects and this project's own convention
// (io/unitSize.ts) is "keep both in sync by hand", not force a shared module.

// ── Bone definitions ──────────────────────────────────────────────────────────

export interface BoneDef {
  id: string;
  parent: string | null;
  len: number;
  rwa: number; // rest world angle (degrees)
  rla: number; // rest local angle = rwa - parent.rwa
  outerW?: number;
  innerW?: number;
  bodyR?: number;
  label: string;
}

export interface WorldPose {
  sx: number; sy: number; // pivot (start)
  ex: number; ey: number; // tip (end)
  wa: number; // world angle (degrees)
}

export type WorldPositions = ReadonlyMap<string, WorldPose>;

// ── Easing ────────────────────────────────────────────────────────────────────

export type EasingType = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'step';

// ── Keyframes ─────────────────────────────────────────────────────────────────

export interface BoneKeyframe {
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
  translateX?: number;
  translateY?: number;
  alpha?: number;
  easing?: EasingType;
}

export interface ResolvedBoneTransform {
  rotation: number;
  scaleX: number;
  scaleY: number;
  translateX: number;
  translateY: number;
  alpha: number;
}

export interface Keyframe {
  time: number;
  bones: Map<string, BoneKeyframe>;
}

export interface AnimationClip {
  duration: number;
  loop: boolean;
  keyframes: Keyframe[];
}

// ── Sprite binding ────────────────────────────────────────────────────────────

export interface SpriteBinding {
  anchorX: number;
  anchorY: number;
  flipX: boolean;
  zOrder: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
}
