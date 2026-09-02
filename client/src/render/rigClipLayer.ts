// Split out of RigSkin.ts (2026-09-02, 500-line convention) as form ① — pure clip
// bookkeeping and pure math over `sampleClip`'s output, no Pixi and no rig knowledge, same
// category as `interpolate.ts` / `rigAttackMotion.ts`. It owns the whole answer to "which
// clips are playing and what pose do they add up to", which is the piece `RigSkin` used to
// hold as a bare `clip`/`clipT` pair.
//
// ## Why a LAYER, and not just playing the `attack` clip
//
// Clips here are sampled WHOLE: a keyframe names some bones, and `sampleClip` returns exactly
// those. Before this file `RigSkin.playClip` swapped `this.clip` outright, so playing `attack`
// dropped every bone that clip does not track back to rest for its entire duration. The hero's
// `attack` touches the sockets and the body; `idle` also bobs `socket_l` — so a shot snapped
// that socket's hover to 0 and snapped it back 350 ms later. At the starter gun's 6-tick
// cooldown (200 ms) the clip also re-triggers before it ends, so held fire pinned the body at
// bob 0 and release popped it. That is why the 2026-08-30 pass shipped a procedural envelope
// INSTEAD of the authored clips, and left a note saying they were "still the right place for a
// real per-character firing pose once every rig has one and there is a blend to play it
// through". This file is that blend; the enemy bundles gaining `move`/`attack` the same day is
// the "every rig has one".
//
// ## The additive contract
//
// The attack clip is sampled independently of the base clip and combined with it PER CHANNEL,
// at each channel's own identity:
//
//   rotation, translateX, translateY   ADD      (identity 0)
//   scaleX, scaleY, alpha              MULTIPLY (identity 1)
//
// Two consequences, and they are the whole reason this is additive rather than an override:
//
//   - A bone the attack clip does not name is untouched. `socket_l` keeps its idle bob through
//     a shot; a `move` cycle keeps running under an attack instead of freezing.
//   - A bone it DOES name keeps its base motion and gains the attack on top, so the body's
//     hover and the attack's jolt coexist instead of one replacing the other.
//
// It also puts a real authoring constraint on the data: an attack clip must START and END at
// identity, or the layer pops the frame it is triggered and the frame it expires. Every shipped
// bundle's clip is written that way and `rigComposition.test.ts` asserts it per bundle, since
// that is a claim about DATA and no amount of correct code here can rescue a clip that violates it.
import type { AnimationClip, ResolvedBoneTransform } from './types';
import { sampleClip } from './interpolate';

/** The name every bundle uses for its one-shot attack overlay. Part of the shared clip
 *  vocabulary — idle / move / attack / hurt / death / spawn — that all seven bundles carry. */
export const ATTACK_CLIP = 'attack';

/** Per-channel identity, i.e. what a bone the base clip never mentions contributes. Frozen
 *  because it is handed straight to `combine` as the left operand and must never be written. */
const IDENTITY: ResolvedBoneTransform = Object.freeze({
  rotation: 0, scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, alpha: 1,
});

/**
 * Fold `overlay` onto `base` in place and return `base`, per the additive contract above.
 *
 * In place on purpose: `base` is `sampleClip`'s freshly-allocated result for this frame and
 * nothing else holds it, so a second map would be a pure per-rig, per-frame allocation —
 * exactly the cost `interpolate.ts`'s own perf note records removing from this same path.
 */
export function layerAdditive(
  base: Map<string, ResolvedBoneTransform>,
  overlay: ReadonlyMap<string, ResolvedBoneTransform>,
): Map<string, ResolvedBoneTransform> {
  overlay.forEach((add, boneId) => {
    const b = base.get(boneId) ?? IDENTITY;
    base.set(boneId, {
      rotation: b.rotation + add.rotation,
      translateX: b.translateX + add.translateX,
      translateY: b.translateY + add.translateY,
      scaleX: b.scaleX * add.scaleX,
      scaleY: b.scaleY * add.scaleY,
      alpha: b.alpha * add.alpha,
    });
  });
  return base;
}

/**
 * The clips one rig is playing: a looping/held BASE (idle or move, chosen by the caller from
 * gameplay state) plus at most one live ATTACK overlay.
 *
 * The two clocks are deliberately different in kind. The base clock is the caller's own
 * monotonic render clock, handed in on every `playBase` — a looping clip has to stay phase-
 * continuous across clip swaps and across the frames where nothing calls it. The overlay clock
 * counts UP from its own trigger, because a one-shot's only meaningful time origin is the
 * attack that started it.
 */
export class ClipLayers {
  private base: AnimationClip | null = null;
  private baseT = 0;
  private readonly attackClip: AnimationClip | null;
  /** Seconds since the current attack was triggered, or `null` when none is in flight. */
  private attackT: number | null = null;

  constructor(private readonly clips: ReadonlyMap<string, AnimationClip>) {
    this.attackClip = clips.get(ATTACK_CLIP) ?? null;
  }

  /** True when this bundle actually ships an attack clip. A bundle without one still attacks —
   *  it just contributes nothing from this layer, and `rigAttackMotion`'s aim-relative half
   *  carries the whole read. Every shipped bundle has one since 2026-09-02; this stays because
   *  a bundle is DATA and the render layer must not assume what an artist shipped. */
  get hasAttackClip(): boolean {
    return this.attackClip !== null;
  }

  /** Select which base clip plays and at what local time (ms — converted to the seconds
   *  clip.duration/keyframe.time are authored in, tools/animator's AnimationController).
   *  An unknown name selects nothing, which is what a bundle missing that clip should do. */
  playBase(name: string, tMs: number): void {
    this.base = this.clips.get(name) ?? null;
    const tSec = tMs / 1000;
    this.baseT = this.base?.loop && this.base.duration > 0 ? tSec % this.base.duration : tSec;
  }

  /** An attack just left this rig — start (or restart) the overlay from its first frame. A
   *  re-trigger mid-clip restarts rather than blending, matching `AttackMotion.kick`: a weapon
   *  whose cadence outruns its own clip should look like it never finishes recovering. */
  attack(): void {
    if (this.attackClip) this.attackT = 0;
  }

  /** Advance the overlay clock by one render frame's `dt` (ms), and retire it once the clip has
   *  played out. The base clock is not advanced here — it is the caller's (`playBase`'s `tMs`). */
  advance(dtMs: number): void {
    if (this.attackT === null) return;
    this.attackT += dtMs / 1000;
    if (this.attackT >= (this.attackClip?.duration ?? 0)) this.attackT = null;
  }

  /** True while the attack overlay is contributing. Exposed for tests and for callers that
   *  want to know whether an attack is still reading on screen. */
  get attacking(): boolean {
    return this.attackT !== null;
  }

  /** This frame's combined pose: the base clip's sample with the attack overlay folded on top.
   *  Empty when no base clip is selected and no attack is running. */
  sample(): Map<string, ResolvedBoneTransform> {
    const pose = this.base ? sampleClip(this.base, this.baseT) : new Map<string, ResolvedBoneTransform>();
    if (this.attackT === null || !this.attackClip) return pose;
    return layerAdditive(pose, sampleClip(this.attackClip, this.attackT));
  }
}
