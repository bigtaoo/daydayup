// Split out of RigSkin.ts (2026-09-02, 500-line convention) as form ① — pure clip
// bookkeeping and pure math over `sampleClip`'s output, no Pixi and no rig knowledge, same
// category as `interpolate.ts` / `rigAttackMotion.ts`. It owns the whole answer to "which
// clips are playing and what pose do they add up to", which is the piece `RigSkin` used to
// hold as a bare `clip`/`clipT` pair.
//
// ## The three kinds of clip, and why the shipped DATA forces exactly this split
//
// The bundles ship a six-clip vocabulary — idle / move / attack / hurt / death / spawn — and it
// is not one homogeneous list. Which layer a clip can live on is decided by whether its own
// first and last pose sit at identity, because that is what the additive fold below requires:
//
//   | clip           | layer         | why it cannot be the other kind                        |
//   |----------------|---------------|--------------------------------------------------------|
//   | idle, move     | BASE (ground) | looping, held; the caller picks by gameplay state      |
//   | attack, hurt   | OVERLAY       | both ends at identity, so it can ride anything         |
//   | spawn, death   | BASE (life)   | spawn STARTS at scale 0.2/alpha 0, death ENDS at        |
//   |                |               | scale 0.4x0.3 / translateY 18 / alpha 0                |
//
// The last row is the whole reason the base layer is a small state machine rather than the bare
// idle/move pick it was until 2026-09-02. Checked against all three shipped rig families
// (orb-core, critter-core, boss-core) and asserted per bundle in `rigComposition.test.ts`, so
// this is a measured property of the art, not a guess: an additive overlay contributes its own
// first pose on the frame it starts and its own last pose on the frame it expires, so a clip
// whose ends are away from identity STEPS the character twice if layered — a spawning body would
// pop to 20% on trigger, a corpse would pop back to full size the instant its collapse finished.
// Those two must therefore REPLACE the ground clip for their duration, which is what `lifecycle`
// below does.
//
// `hurt` goes the other way for the same reason, and it is the layer it wants anyway: being hit
// must not interrupt walking, and the flinch belongs ON TOP of whatever the body was doing.
//
// ## The additive contract (overlays)
//
// An overlay is sampled independently of the base clip and combined with it PER CHANNEL, at
// each channel's own identity:
//
//   rotation, translateX, translateY   ADD      (identity 0)
//   scaleX, scaleY, alpha              MULTIPLY (identity 1)
//
// Two consequences, and they are the whole reason this is additive rather than an override:
//
//   - A bone the overlay does not name is untouched. `socket_l` keeps its idle bob through a
//     shot; a `move` cycle keeps running under an attack instead of freezing.
//   - A bone it DOES name keeps its base motion and gains the overlay on top, so the body's
//     hover and the attack's jolt coexist instead of one replacing the other.
//
// Both operations are commutative, so two live overlays (a hit landing mid-shot) compose to the
// same pose in either order and nothing here has to define a priority between them.
//
// Before this file `RigSkin.playClip` swapped `this.clip` outright, so playing `attack` dropped
// every bone that clip does not name back to rest for its entire duration. The hero's `attack`
// touches the sockets and the body; `idle` also bobs `socket_l` — so a shot snapped that socket's
// hover to 0 and snapped it back 350 ms later. At the starter gun's 6-tick cooldown (200 ms) the
// clip also re-triggers before it ends, so held fire pinned the body at bob 0 and release popped
// it. That is why the 2026-08-30 pass shipped a procedural envelope INSTEAD of the authored
// clips, and left a note saying they were "still the right place for a real per-character firing
// pose once every rig has one and there is a blend to play it through". This file is that blend.
import type { AnimationClip, ResolvedBoneTransform } from './types';
import { sampleClip } from './interpolate';

/** The one-shot OVERLAY clips: both are authored to start and end at identity, so either can be
 *  folded onto whatever the body is already doing. Part of the shared six-clip vocabulary all
 *  seven bundles carry. */
export const ATTACK_CLIP = 'attack';
export const HURT_CLIP = 'hurt';

/** The one-shot BASE clips — the two lifecycle ends. Neither can be an overlay: see the table in
 *  this file's header for the measured reason (spawn's first pose and death's last pose are both
 *  far from identity). `SPAWN_CLIP` releases back to idle/move when it finishes; `DEATH_CLIP`
 *  HOLDS its last pose, because there is nothing for a corpse to return to. */
export const SPAWN_CLIP = 'spawn';
export const DEATH_CLIP = 'death';

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

/** A one-shot base clip in flight — `spawn` or `death`. `hold` is what separates them: a spawn
 *  hands the base layer back to idle/move when it ends, a death keeps its last frame forever. */
interface Lifecycle {
  name: string;
  clip: AnimationClip;
  /** Seconds since this clip was triggered, clamped to `clip.duration` once a held one ends. */
  t: number;
  hold: boolean;
}

/**
 * The clips one rig is playing: a BASE layer, plus any number of live one-shot OVERLAYS.
 *
 * The base layer is a two-state machine rather than a single clip. Normally it is the
 * looping/held GROUND clip the caller picked from gameplay state (idle or move, via `playBase`);
 * while a LIFECYCLE clip is in flight (`spawn`/`die`) that one outranks it and the caller's pick
 * is remembered but not sampled. The caller therefore never has to know about spawning or dying
 * — `Actor` keeps asking for 'idle'/'move' exactly as it did before this layer existed.
 *
 * The clocks are deliberately different in kind. The ground clock is the caller's own monotonic
 * render clock, handed in on every `playBase` — a looping clip has to stay phase-continuous
 * across clip swaps and across the frames where nothing calls it. Every one-shot clock (both
 * lifecycle and overlay) counts UP from its own trigger, because a one-shot's only meaningful
 * time origin is the event that started it.
 *
 * Death is absorbing: it refuses every later trigger and clears whatever overlays were live.
 * A corpse does not flinch.
 *
 * That rule is stated HERE, at the layer that owns it, and it is deliberately not the only thing
 * standing between a splash hit and a jolting corpse — it is currently not even reachable from the
 * one live caller. `GameLoop` reconciles the scene BEFORE it consumes the tick's events, so on the
 * tick an actor dies its view has already left `Scene.views`, and `Scene.actorAt` (the only way an
 * event reaction finds an actor) searches nothing else. A killing blow's `hit` therefore reaches no
 * view at all. Both halves of that are asserted in their own suites; if either changes — a widened
 * `actorAt`, a reordered tick — this becomes the live guard, which is why it is written and tested
 * as a property of this class rather than left to the pipeline that happens to make it moot.
 */
export class ClipLayers {
  private base: AnimationClip | null = null;
  private baseT = 0;
  private lifecycle: Lifecycle | null = null;
  /** Live overlays as `clip name -> seconds since trigger`. Insertion-ordered, which only
   *  matters for reading a test's output: the fold is commutative (see the header). */
  private readonly overlays = new Map<string, number>();

  constructor(private readonly clips: ReadonlyMap<string, AnimationClip>) {}

  /** True when this bundle actually ships an attack clip. A bundle without one still attacks —
   *  it just contributes nothing from this layer, and `rigAttackMotion`'s aim-relative half
   *  carries the whole read. Every shipped bundle has one since 2026-09-02; this stays because
   *  a bundle is DATA and the render layer must not assume what an artist shipped. */
  get hasAttackClip(): boolean {
    return this.clips.has(ATTACK_CLIP);
  }

  /** Select which GROUND clip plays and at what local time (ms — converted to the seconds
   *  clip.duration/keyframe.time are authored in, tools/animator's AnimationController).
   *  An unknown name selects nothing, which is what a bundle missing that clip should do.
   *  Recorded even while a lifecycle clip outranks it, so a spawn releases into the right one. */
  playBase(name: string, tMs: number): void {
    this.base = this.clips.get(name) ?? null;
    const tSec = tMs / 1000;
    this.baseT = this.base?.loop && this.base.duration > 0 ? tSec % this.base.duration : tSec;
  }

  /** An attack just left this rig — start (or restart) the overlay from its first frame. A
   *  re-trigger mid-clip restarts rather than blending, matching `AttackMotion.kick`: a weapon
   *  whose cadence outruns its own clip should look like it never finishes recovering. */
  attack(): void {
    this.startOverlay(ATTACK_CLIP);
  }

  /** This rig just took a hit (`Actor.onHurt`, off the engine's `hit` event). An overlay, not a
   *  base clip, for two independent reasons: the shipped `hurt` starts and ends at identity so it
   *  CAN be one, and being hit must not interrupt walking or firing so it SHOULD be one. */
  hurt(): void {
    this.startOverlay(HURT_CLIP);
  }

  /** This rig just appeared (`Actor.onSpawn`, off a new engine id reaching `Scene`). Takes over
   *  the base layer for its duration and then releases it back to the caller's idle/move. */
  spawn(): void {
    this.startLifecycle(SPAWN_CLIP, false);
  }

  /**
   * This rig just died (`Actor.onDeath`, off its id dropping out of the engine's alive list).
   * Takes over the base layer and never gives it back, and cancels every live overlay.
   *
   * This layer owns the body's own collapse — squash, sink, fade, per body plan. It does NOT own
   * how long the view survives: that is `ActorFilters`' dissolve clock (`isDissolved`), which is
   * what `Scene` destroys the view on. Art must not get a vote on view lifetime, so a death clip
   * that outlives the dissolve is simply cut off mid-collapse, and one that finishes early holds
   * its last frame instead of releasing.
   */
  die(): void {
    // One guard, in `startLifecycle`: it already refuses while `dying`, so a second `die()` never
    // restarts the collapse and the overlays are only cleared on the call that actually starts it.
    if (this.startLifecycle(DEATH_CLIP, true)) this.overlays.clear();
  }

  /** Advance every one-shot clock by one render frame's `dt` (ms), retiring whatever played out.
   *  The ground clock is not advanced here — it is the caller's (`playBase`'s `tMs`). */
  advance(dtMs: number): void {
    const dt = dtMs / 1000;
    const life = this.lifecycle;
    if (life) {
      life.t += dt;
      if (life.t >= life.clip.duration) {
        if (life.hold) life.t = life.clip.duration;
        else this.lifecycle = null;
      }
    }
    // Deleting the current key and re-setting an existing one are both safe mid-iteration.
    for (const [name, t] of this.overlays) {
      const next = t + dt;
      if (next >= (this.clips.get(name)?.duration ?? 0)) this.overlays.delete(name);
      else this.overlays.set(name, next);
    }
  }

  /** True while the attack overlay is contributing. Exposed for tests and for callers that
   *  want to know whether an attack is still reading on screen. */
  get attacking(): boolean {
    return this.overlays.has(ATTACK_CLIP);
  }

  /** True while the hurt overlay is contributing — the flinch's sibling of `attacking`. */
  get hurting(): boolean {
    return this.overlays.has(HURT_CLIP);
  }

  /** True while the spawn clip owns the base layer. False again the moment it releases. */
  get spawning(): boolean {
    return this.lifecycle?.name === SPAWN_CLIP;
  }

  /** True from the frame `die()` lands onward — it never clears, by design (see `die`). */
  get dying(): boolean {
    return this.lifecycle?.name === DEATH_CLIP;
  }

  /** This frame's combined pose: the base layer's sample with every live overlay folded on top.
   *  Empty when no clip is selected at all and nothing is in flight. */
  sample(): Map<string, ResolvedBoneTransform> {
    const life = this.lifecycle;
    const pose = life ? sampleClip(life.clip, life.t)
      : this.base ? sampleClip(this.base, this.baseT)
        : new Map<string, ResolvedBoneTransform>();
    this.overlays.forEach((t, name) => {
      const clip = this.clips.get(name);
      if (clip) layerAdditive(pose, sampleClip(clip, t));
    });
    return pose;
  }

  /** Start (or restart) a one-shot overlay from its own first frame. A bundle that ships no such
   *  clip is a silent no-op, and a dead rig refuses outright. */
  private startOverlay(name: string): void {
    if (this.dying || !this.clips.has(name)) return;
    this.overlays.set(name, 0);
  }

  /** Take over the base layer with a one-shot. Returns whether it actually started, so `die` can
   *  tell "the collapse is running" from "this bundle ships no death clip". */
  private startLifecycle(name: string, hold: boolean): boolean {
    if (this.dying) return false; // death outranks everything, including a same-id respawn
    const clip = this.clips.get(name);
    if (!clip) return false;
    this.lifecycle = { name, clip, t: 0, hold };
    return true;
  }
}
