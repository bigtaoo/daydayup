/**
 * Built-in preset animation clips for the orb-core rig (design/12: hover-bob,
 * lean-into-travel, squash-stretch — no arms/legs/walk-cycle anywhere).
 *
 * Translate/scale/alpha are per-bone render-only properties (they do not
 * cascade through FK to child bones, unlike rotation) — so "the whole body
 * floats/squashes together" means setting the same translateY/scale/alpha on
 * every visible bone at each keyframe, not just on `root` or `shell`.
 */
import type { AnimationClip, BoneKeyframe, Keyframe } from '../core/types';

/** All bones with a sprite (excludes 'root', which is the invisible ground anchor). */
const VISIBLE = ['shell', 'eye', 'belly', 'socket_l', 'socket_r'] as const;

function kf(time: number, bones: Record<string, BoneKeyframe>): Keyframe {
  return { time, bones: new Map(Object.entries(bones)) };
}

/** Same translateY (a "hover" bob) applied to every visible bone. */
function bob(ty: number, extra: Partial<Record<(typeof VISIBLE)[number], BoneKeyframe>> = {}): Record<string, BoneKeyframe> {
  const out: Record<string, BoneKeyframe> = {};
  for (const id of VISIBLE) out[id] = { translateY: ty, ...extra[id] };
  return out;
}

/** Same alpha applied to every visible bone (full-body fade in/out). */
function fadeAll(alpha: number): Record<string, BoneKeyframe> {
  const out: Record<string, BoneKeyframe> = {};
  for (const id of VISIBLE) out[id] = { alpha };
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────

export const PRESETS: Record<string, AnimationClip> = {
  // Hover-bob: the resting idle. Gentle whole-body float, sockets drift slightly
  // out of phase so the tethers read as loose rather than rigid.
  idle: {
    duration: 2.0,
    loop: true,
    keyframes: [
      kf(0,   bob(0)),
      kf(1.0, bob(-6, { socket_l: { translateY: -4, rotation: 4 }, socket_r: { translateY: -4, rotation: -4 } })),
      kf(2.0, bob(0)),
    ],
  },

  // Lean-into-travel: shell (and everything hanging off it) leans toward the
  // direction of movement, with a faster bob layered on top of the lean.
  move: {
    duration: 0.6,
    loop: true,
    keyframes: [
      kf(0,    { shell: { rotation: 10, translateY: 0 }, eye: { translateY: 0 }, belly: { translateY: 0 }, socket_l: { translateY: 0 }, socket_r: { translateY: 0 } }),
      kf(0.15, { shell: { rotation: 10, translateY: -5 }, eye: { translateY: -5 }, belly: { translateY: -5 }, socket_l: { translateY: -3 }, socket_r: { translateY: -3 } }),
      kf(0.3,  { shell: { rotation: 10, translateY: 0 }, eye: { translateY: 0 }, belly: { translateY: 0 }, socket_l: { translateY: 0 }, socket_r: { translateY: 0 } }),
      kf(0.45, { shell: { rotation: 10, translateY: -5 }, eye: { translateY: -5 }, belly: { translateY: -5 }, socket_l: { translateY: -3 }, socket_r: { translateY: -3 } }),
      kf(0.6,  { shell: { rotation: 10, translateY: 0 }, eye: { translateY: 0 }, belly: { translateY: 0 }, socket_l: { translateY: 0 }, socket_r: { translateY: 0 } }),
    ],
  },

  // Attack: a quick recoil pulse on the firing socket (right by default).
  attack: {
    duration: 0.35,
    loop: false,
    keyframes: [
      kf(0,    { socket_r: { translateX: 0, scaleX: 1 } }),
      kf(0.08, { socket_r: { translateX: -10, scaleX: 0.85 } }),
      kf(0.2,  { socket_r: { translateX: 4, scaleX: 1.05 } }),
      kf(0.35, { socket_r: { translateX: 0, scaleX: 1 } }),
    ],
  },

  // Hurt: a squash-stretch flinch on the shell plus a brief dim, no walk/limb
  // recoil to fake since there's nothing to recoil.
  hurt: {
    duration: 0.3,
    loop: false,
    keyframes: [
      kf(0,    { shell: { scaleX: 1,    scaleY: 1,    alpha: 1 } }),
      kf(0.06, { shell: { scaleX: 1.15, scaleY: 0.8,  alpha: 0.6 } }),
      kf(0.18, { shell: { scaleX: 0.95, scaleY: 1.05, alpha: 1 } }),
      kf(0.3,  { shell: { scaleX: 1,    scaleY: 1,    alpha: 1 } }),
    ],
  },

  // Death: shell squashes and sinks while the eye dims, everything fades out.
  death: {
    duration: 0.9,
    loop: false,
    keyframes: [
      kf(0,   { shell: { scaleX: 1,   scaleY: 1,    translateY: 0 },  eye: { alpha: 1 } }),
      kf(0.3, { shell: { scaleX: 1.1, scaleY: 0.85, translateY: 6 },  eye: { alpha: 0.5 } }),
      kf(0.6, { shell: { scaleX: 0.7, scaleY: 0.5,  translateY: 14 }, eye: { alpha: 0.15 } }),
      kf(0.9, { ...fadeAll(0), shell: { scaleX: 0.4, scaleY: 0.3, translateY: 18, alpha: 0 } }),
    ],
  },

  // Spawn: the reverse of death — scales in from nothing while fading up.
  spawn: {
    duration: 0.35,
    loop: false,
    keyframes: [
      kf(0,    { ...fadeAll(0), shell: { scaleX: 0.2, scaleY: 0.2, alpha: 0 } }),
      kf(0.15, { ...fadeAll(1), shell: { scaleX: 1.15, scaleY: 0.85, alpha: 1 } }),
      kf(0.25, { shell: { scaleX: 0.95, scaleY: 1.05 } }),
      kf(0.35, { shell: { scaleX: 1, scaleY: 1 } }),
    ],
  },
};

/** Deep-clone a preset so mutations don't affect the original. */
export function clonePreset(name: string): AnimationClip | null {
  const p = PRESETS[name];
  if (!p) return null;
  return {
    duration: p.duration,
    loop: p.loop,
    keyframes: p.keyframes.map(kf => ({
      time: kf.time,
      bones: new Map(Array.from(kf.bones.entries()).map(([id, bkf]) => [id, { ...bkf }])),
    })),
  };
}
