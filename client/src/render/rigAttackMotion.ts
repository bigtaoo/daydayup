// Renamed from `rigRecoil.ts` (2026-09-02) when the melee half arrived: this is no longer
// "the recoil", it is the render-only, AIM-RELATIVE half of one attack. Split out of
// RigSkin.ts originally (2026-08-30, 500-line convention) as form ① — a tiny independent
// state machine with no Pixi and no rig knowledge, same category as `facing.ts`/`interpolate.ts`.
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
//   - THIS file owns everything that has to point along the aim ray. A clip cannot express it,
//     for two independent reasons. First, a clip's `translateX` is applied in RIG space
//     (`RigSkin.update`: `sprite.x = pose.ex + transform.translateX`), so an authored -10 slides
//     the gun left, not backwards along its own barrel — which is what the hero's original
//     `attack` clip did, and why this envelope replaced that part of it. Second, the weapon
//     sockets are AIM-TRACKING bones (`rigWeaponMount.AIM_TRACKING_BONES`): `RigSkin` OVERWRITES
//     their rotation with the aim angle every frame, so an authored swing arc would be silently
//     discarded. A sword can only be swung from here.
//
// The ranged and melee envelopes differ in shape because the two motions are opposites — a gun
// pushes the character BACK, a swing carries them FORWARD through the arc — but they share one
// trigger (`kick(kind)`), one clock, and one set of read sites in `RigSkin.update()`.
//
// ## Why the whole thing is procedural rather than more authored data
//
// It is a function of the aim angle, which is a per-frame runtime value; there is nothing to
// author. It also costs nothing per rig: all seven bundles get a correct, direction-aware attack
// from one code path, including the four enemy ones whose entire body is a single bone.

/** Which of the two attacks is in flight. Mirrors the engine's own weapon `kind`, and the two
 *  events that trigger it (`bullet_fired` / `melee_swing`) map one-to-one onto it. */
export type AttackKind = 'ranged' | 'melee';

// ── Ranged: the fire recoil ───────────────────────────────────────────────────

/** Total time one shot's recoil takes to kick out and settle back, ms. */
export const RECOIL_MS = 150;
/** Fraction of `RECOIL_MS` spent kicking OUT. The rest is the return. A fast punch and a
 *  slow-ish settle is what reads as weight; a symmetric triangle reads as a wobble. */
const RECOIL_ATTACK = 0.22;
/** How far the weapon module slides back along its own barrel at the peak, in rig
 *  AUTHORING px (the space `rigWeaponMount` works in — a rig's own scale to world px is
 *  `radius / referenceRadius`, ~0.35 for orb-core, and the room camera then zooms ~4x, so
 *  this lands around a dozen screen px). Sized against the authored `attack` clip's own
 *  `translateX: -10` on the same bone, which is the look this replaces — and which has since
 *  been REMOVED from that clip, so the two can no longer double up. */
export const RECOIL_MODULE_PX = 10;
/** How far the whole body shoves back with the shot, same units. Deliberately a small
 *  fraction of the module's kick: the gun recoils, the character only leans. */
export const RECOIL_BODY_PX = 3;

// ── Melee: the swing ──────────────────────────────────────────────────────────

/** Total time one swing takes, ms. Sits inside the starter saber's own recovery
 *  (`SABER_SIM.swingCooldownTicks` = 11 ticks = ~367 ms), so a held trigger reads as
 *  discrete swings with a beat between them rather than a continuous blur. */
export const SWING_MS = 260;
/** Fraction of `SWING_MS` spent winding UP (rotating back past the aim), and the fraction by
 *  which the strike itself has landed. The rest is the recovery back to the aim line. */
const SWING_WINDUP = 0.3;
const SWING_STRIKE = 0.55;
/** How far back past the aim line the module cocks before the strike, degrees. Negative =
 *  behind. Applied in the socket's CANONICAL (pre-mirror) space like every other socket
 *  offset, so the arc mirrors with the body instead of sweeping backwards when facing left. */
export const SWING_WINDUP_DEG = -22;
/** How far past the aim line the strike carries, degrees. The full sweep is
 *  `SWING_ARC_DEG - SWING_WINDUP_DEG` = 68°, comfortably readable at the ~13-20 px an actor
 *  occupies before the room camera's ~4x zoom. */
export const SWING_ARC_DEG = 46;
/** How far the whole body lunges FORWARD at the strike, rig authoring px — the mirror image of
 *  `RECOIL_BODY_PX`, and larger, because a swing is the character committing weight into the
 *  attack where a shot is the character absorbing it. */
export const SWING_LUNGE_PX = 5;
/** How far the body drifts BACK during the wind-up, as a fraction of `SWING_LUNGE_PX`. Small:
 *  without it the lunge starts from a dead stop and reads as a twitch rather than a swing. */
const SWING_WINDUP_LUNGE = 0.35;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * A one-shot envelope, restarted by every `kick()`. Sampling is pure — every value is a
 * function of the remaining time and the kind alone — so nothing here can drift with frame
 * rate, and an attack that lands while the previous one is still settling simply restarts it
 * (which is what a fast weapon should look like: the gun never gets back to rest).
 *
 * A `kick('melee')` mid-recoil switches the whole envelope to the swing, rather than blending:
 * the only way to reach that is a weapon swap between two attacks a few frames apart, and the
 * two motions are opposites, so there is no meaningful blend of them to compute.
 */
export class AttackMotion {
  private ms = 0;
  private kind: AttackKind = 'ranged';

  /** An attack just left this rig — start (or restart) the envelope for that kind. */
  kick(kind: AttackKind): void {
    this.kind = kind;
    this.ms = kind === 'melee' ? SWING_MS : RECOIL_MS;
  }

  /** Advance by one render frame's `dt` (ms). Safe to call with 0. */
  advance(dtMs: number): void {
    this.ms = Math.max(0, this.ms - dtMs);
  }

  /** Progress through the active envelope: 0 the instant of the attack, 1 when fully settled.
   *  -1 when nothing is in flight, so callers can tell "settled" from "not running" without a
   *  second flag (every public getter below already returns a resting value in that case). */
  private get progress(): number {
    if (this.ms <= 0) return -1;
    return 1 - this.ms / (this.kind === 'melee' ? SWING_MS : RECOIL_MS);
  }

  /** The RANGED recoil envelope: 0 at rest, 1 at the peak of the kick. Zero for a swing, which
   *  has its own shape (`swingDeg`) rather than a scalar magnitude. */
  get amount(): number {
    const u = this.progress;
    if (u < 0 || this.kind !== 'ranged') return 0;
    return u < RECOIL_ATTACK ? u / RECOIL_ATTACK : (1 - u) / (1 - RECOIL_ATTACK);
  }

  /** How far the weapon module sits back along its barrel this frame, authoring px. Ranged
   *  only: a swing moves the module by ROTATING it (`swingDeg`), not by sliding it. */
  get modulePx(): number {
    return this.amount * RECOIL_MODULE_PX;
  }

  /**
   * How far the whole body sits off its centre this frame, authoring px, SIGNED along the aim:
   * POSITIVE is away from the aim (a shot shoving the shooter back), NEGATIVE is into it (a
   * swing carrying the body forward). One number for both kinds so `RigSkin` keeps one formula.
   */
  get bodyPx(): number {
    if (this.kind === 'ranged') return this.amount * RECOIL_BODY_PX;
    const u = this.progress;
    if (u < 0) return 0;
    return -this.lunge(u) * SWING_LUNGE_PX;
  }

  /** Extra rotation added to the weapon socket's aim angle this frame, DEGREES in canonical
   *  (pre-mirror) space. Melee only — a gun does not sweep. */
  get swingDeg(): number {
    const u = this.progress;
    if (u < 0 || this.kind !== 'melee') return 0;
    if (u < SWING_WINDUP) return lerp(0, SWING_WINDUP_DEG, u / SWING_WINDUP);
    if (u < SWING_STRIKE) return lerp(SWING_WINDUP_DEG, SWING_ARC_DEG, (u - SWING_WINDUP) / (SWING_STRIKE - SWING_WINDUP));
    return lerp(SWING_ARC_DEG, 0, (u - SWING_STRIKE) / (1 - SWING_STRIKE));
  }

  /** The swing's body-travel profile, same three phases as `swingDeg`: drift back through the
   *  wind-up, drive forward to a peak at the strike, recover to rest. 1 = a full lunge. */
  private lunge(u: number): number {
    if (u < SWING_WINDUP) return lerp(0, -SWING_WINDUP_LUNGE, u / SWING_WINDUP);
    if (u < SWING_STRIKE) return lerp(-SWING_WINDUP_LUNGE, 1, (u - SWING_WINDUP) / (SWING_STRIKE - SWING_WINDUP));
    return lerp(1, 0, (u - SWING_STRIKE) / (1 - SWING_STRIKE));
  }
}
