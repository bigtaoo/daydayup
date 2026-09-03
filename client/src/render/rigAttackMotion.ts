// Renamed from `rigRecoil.ts` (2026-09-02) when the melee half arrived: this is no longer
// "the recoil", it is the render-only, AIM-RELATIVE half of one attack. Split out of
// RigSkin.ts originally (2026-08-30, 500-line convention) as form (1) — a tiny independent
// state machine with no Pixi and no rig knowledge, same category as `facing.ts`/`interpolate.ts`.
//
// Since the second 2026-09-02 pass this file is the ASSEMBLY SHELL of a three-file module: the
// per-weapon derivation of each kind lives in a sibling (`attack/swingShape.ts`,
// `attack/shotShape.ts`, both pure and both stateless) and is re-exported from here, so every
// existing `from './rigAttackMotion'` import is unaffected by the split. What is left HERE is
// the one thing neither sibling can own: the CLOCK, and the kind currently on it.
//
// ## The unified rule, and which half lives here
//
// Every attack in the game — a shot (`bullet_fired`) or a swing (`melee_swing`) — drives the
// SAME two layers, and the split between them is not stylistic:
//
//   - The AUTHORED `attack` clip (`rigClipLayer.ts`) owns everything expressible in the rig's
//     own bone space: squash/stretch, a body jolt, a boss's shard rings flaring. Every one of
//     the seven shipped bundles carries one, so this layer covers the whole roster.
//
//   - THIS module owns everything that has to point along the aim ray. A clip cannot express it,
//     for two independent reasons. First, a clip's `translateX` is applied in RIG space
//     (`RigSkin.update`: `sprite.x = pose.ex + transform.translateX`), so an authored -10 slides
//     the gun left, not backwards along its own barrel — which is what the hero's original
//     `attack` clip did, and why this envelope replaced that part of it. Second, the weapon
//     sockets are AIM-TRACKING bones (`rigWeaponMount.AIM_TRACKING_BONES`): `RigSkin` OVERWRITES
//     their rotation with the aim angle every frame, so an authored swing arc would be silently
//     discarded. A sword can only be swung, and a muzzle can only be made to climb, from here.
//
// The ranged and melee envelopes differ in shape because the two motions are opposites — a gun
// pushes the character BACK, a swing carries them FORWARD through the arc — but they share one
// trigger (`kick`), one clock, and one set of read sites in `RigSkin.update()`.
//
// ## Why the whole thing is procedural rather than more authored data
//
// It is a function of the aim angle and of the equipped weapon's own numbers, both per-frame
// runtime values; there is nothing to author. It also costs nothing per rig: all seven bundles
// get a correct, direction-aware, weapon-aware attack from one code path, including the four
// enemy ones whose entire body is a single bone.
export type { SwingShape, SwingSchedule } from './attack/swingShape';
export type { ShotShape, RecoilSchedule } from './attack/shotShape';
export {
  DEFAULT_SWING, swingSchedule, heftOf,
  SWING_ARC_DEG, SWING_WINDUP_DEG, SWING_LUNGE_PX, SWING_THRUST_PX, SWING_STRIKE,
} from './attack/swingShape';
export {
  DEFAULT_SHOT, recoilSchedule, kickOf,
  RECOIL_MS, RECOIL_MODULE_PX, RECOIL_BODY_PX, RECOIL_CLIMB_DEG,
} from './attack/shotShape';

import {
  swingSchedule, swingRotationDeg, swingTravel, type SwingShape, type SwingSchedule,
} from './attack/swingShape';
import {
  recoilSchedule, recoilAmount, type ShotShape, type RecoilSchedule,
} from './attack/shotShape';

/** Which of the two attacks is in flight. Mirrors the engine's own weapon `kind`, and the two
 *  events that trigger it (`bullet_fired` / `melee_swing`) map one-to-one onto it. */
export type AttackKind = 'ranged' | 'melee';

/**
 * "This rig just attacked", as one overloaded call. Declared as a named type because it is
 * implemented four times down one chain (`Actor.onAttack` -> `Skin.attack` -> `RigSkin.attack`
 * -> `AttackMotion.kick`) plus once as a duck-typed host interface member
 * (`EventReactorHost.actorAt`), and the pairing between the kind and the shape is the whole
 * point of it: a `ShotShape` handed to a swing derives nothing and silently falls back.
 */
export interface AttackTrigger {
  (kind: 'ranged', shot?: ShotShape): void;
  (kind: 'melee', swing?: SwingShape): void;
}

/**
 * A one-shot envelope, restarted by every `kick()`. Sampling is pure — every value is a
 * function of the elapsed time, the kind, and the schedule that kick derived — so nothing here
 * can drift with frame rate, and an attack that lands while the previous one is still settling
 * simply restarts it (which is what a fast weapon should look like: the gun never gets back to
 * rest). Since the weapon now sizes the envelope, that restart is no longer the NORMAL case for
 * the fastest guns the way it was: every weapon's envelope is derived to fit its own cadence.
 *
 * A `kick('melee')` mid-recoil switches the whole envelope to the swing, rather than blending:
 * the only way to reach that is a weapon swap between two attacks a few frames apart, and the
 * two motions are opposites, so there is no meaningful blend of them to compute.
 */
export class AttackMotion {
  /** Time REMAINING in the active envelope, ms. Counts down; 0 = settled or never kicked. */
  private ms = 0;
  private kind: AttackKind = 'ranged';
  /** The attack currently in flight, re-derived by each `kick`. Held rather than recomputed per
   *  getter so all four read sites of one frame agree even if a weapon swap lands between them,
   *  and so a retune of the derivation costs one call per attack rather than four per frame. */
  private swing: SwingSchedule = swingSchedule();
  private shot: RecoilSchedule = recoilSchedule();

  /** An attack just left this rig — start (or restart) the envelope for that kind. The shape is
   *  the WEAPON that attacked; omitted (a caller that could not resolve a spec — the Graphics
   *  placeholder, an actor already gone from the state) it falls back to that kind's starter
   *  weapon, `DEFAULT_SWING` or `DEFAULT_SHOT`. */
  kick(kind: 'ranged', shot?: ShotShape): void;
  kick(kind: 'melee', swing?: SwingShape): void;
  kick(kind: AttackKind, shape?: ShotShape | SwingShape): void {
    this.kind = kind;
    if (kind === 'melee') {
      this.swing = swingSchedule(shape as SwingShape | undefined);
      this.ms = this.swing.totalMs;
    } else {
      this.shot = recoilSchedule(shape as ShotShape | undefined);
      this.ms = this.shot.totalMs;
    }
  }

  /** Advance by one render frame's `dt` (ms). Safe to call with 0. */
  advance(dtMs: number): void {
    this.ms = Math.max(0, this.ms - dtMs);
  }

  /** ms since the active attack was triggered, or -1 when nothing is in flight — so callers can
   *  tell "settled" from "not running" without a second flag (every public getter below already
   *  returns a resting value in that case). */
  private get elapsed(): number {
    if (this.ms <= 0) return -1;
    return (this.kind === 'melee' ? this.swing.totalMs : this.shot.totalMs) - this.ms;
  }

  /** The RANGED recoil envelope: 0 at rest, 1 at the peak of the kick. Zero for a swing, which
   *  has its own three-phase shape rather than a single scalar magnitude. */
  get amount(): number {
    const t = this.elapsed;
    if (t < 0 || this.kind !== 'ranged') return 0;
    return recoilAmount(t, this.shot);
  }

  /**
   * How far the weapon module sits off its rest point ALONG ITS OWN BARREL this frame, authoring
   * px. Positive slides it back (a gun's recoil), negative drives it forward (a narrow melee
   * weapon's thrust — see `attack/swingShape.ts`'s sweep/thrust trade). One signed number for
   * both kinds so `RigSkin` and `rigWeaponMount.activeModuleMount` keep one formula.
   *
   * Zero for a swing WIDE enough that its rotation says everything (every weapon at or above
   * 150 degrees, which is most of the roster and all of the reference tuning) — a blade that
   * sweeps does not also lunge out of its own housing.
   */
  get modulePx(): number {
    const t = this.elapsed;
    if (t < 0) return 0;
    if (this.kind === 'ranged') return recoilAmount(t, this.shot) * this.shot.modulePx;
    // `|| 0` normalises the NEGATIVE ZERO a rest-pose sample produces here (`-0 * px`). It is
    // numerically identical to +0 and no read site could see the difference, but `Object.is`
    // can, and the suite asserts settled values with `toBe(0)` on purpose — a getter that
    // settles anywhere but exactly rest leaves the weapon permanently displaced, and that claim
    // is worth keeping strict rather than loosening to a tolerance to accommodate a sign bit.
    return -swingTravel(t, this.swing) * this.swing.thrustPx || 0;
  }

  /**
   * How far the whole body sits off its centre this frame, authoring px, SIGNED along the aim:
   * POSITIVE is away from the aim (a shot shoving the shooter back), NEGATIVE is into it (a
   * swing carrying the body forward). One number for both kinds so `RigSkin` keeps one formula.
   */
  get bodyPx(): number {
    const t = this.elapsed;
    if (t < 0) return 0;
    if (this.kind === 'ranged') return recoilAmount(t, this.shot) * this.shot.bodyPx;
    return -swingTravel(t, this.swing) * this.swing.lungePx || 0; // see `modulePx` on the `|| 0`
  }

  /**
   * Extra rotation added to the weapon socket's aim angle this frame, DEGREES in canonical
   * (pre-mirror) space. Both kinds now use it, and they use it for opposite-sized motions: a
   * swing sweeps tens of degrees through its own sector, a shot tips the muzzle up a handful and
   * settles. Negative is back/above the aim line for both.
   *
   * Renamed from `swingDeg` when the ranged half arrived — the read site
   * (`RigSkin.canonicalWeaponAngleRad`) never cared which kind produced the number, and a getter
   * called `swingDeg` returning a gun's muzzle climb would have been the wrong name in the one
   * place it is actually read.
   */
  get weaponDeg(): number {
    const t = this.elapsed;
    if (t < 0) return 0;
    // `climbDeg` is negative, so this is the ranged half of `modulePx`'s signed-zero case.
    if (this.kind === 'ranged') return recoilAmount(t, this.shot) * this.shot.climbDeg || 0;
    return swingRotationDeg(t, this.swing);
  }
}
