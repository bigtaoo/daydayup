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

/** Total time one swing takes, ms, FOR THE STARTER SABER — the reference shape every constant
 *  in this section was tuned against, and the fallback for a caller with no weapon to hand
 *  (see `DEFAULT_SWING`). Sits inside the saber's own recovery
 *  (`SABER_SIM.swingCooldownTicks` = 11 ticks = ~367 ms), so a held trigger reads as
 *  discrete swings with a beat between them rather than a continuous blur. Any other weapon
 *  scales off its own recovery in `swingSchedule`. */
export const SWING_MS = 260;
/** Fraction of `SWING_MS` spent winding UP (rotating back past the aim), and the fraction by
 *  which the strike itself has landed. The rest is the recovery back to the aim line. */
const SWING_WINDUP = 0.3;
/** Exported because it is the ANCHOR between the render envelope and the sim: the strike ends at
 *  this fraction, and `swingSchedule` sizes the envelope so that moment coincides with the close
 *  of the weapon's active hit window (design/07 step 7). */
export const SWING_STRIKE = 0.55;
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

// ── Melee: the weapon the swing belongs to ────────────────────────────────────
//
// Why the swing is data-driven at all (2026-09-02, asked directly: is the melee attack
// animation's amplitude tied to the weapon's own attack sector? — it was not). The authored sectors
// from the spear's 60° to the hammer's 220°, a 3.7x spread, against ONE hardcoded 68° sweep: the
// spear's animation was WIDER than the sector it can actually hit in, and the hammer drew 31% of
// its own. That is not a missing flourish — the same `arcHalf` also decides which bullets a swing
// deflects (`DeflectSystem` reads the identical field), so a fixed sweep actively misinformed the
// player about their own parry. The weapon now sets the SIZE and the SPEED of the motion; the
// motion keeps its own shape (the phase split, the wind-up share, the lunge), which is a property
// of how a body swings, not of what it is holding.

/** The weapon-side inputs the swing's shape is derived from — the two `MeleeSimSpec` fields that
 *  say how wide and how slow the attack is, restated in render units so this file needs no
 *  engine import (brad/tick conversion belongs at the read site, `game/coords.ts`). */
export interface SwingShape {
  /** The weapon's FULL hit sector, degrees — `MeleeSimSpec.arcHalf` × 2. */
  arcDeg: number;
  /**
   * The weapon's ACTIVE HIT WINDOW, ms — `MeleeSimSpec.swingTicks` at the sim's tick rate
   * (design/07 step 7). The ticks during which `HitResolveSystem` is really re-testing this
   * swing's arc, so it is the honest length for the visible stroke to cover.
   *
   * This replaced `recoveryMs` as the timing source in `ENGINE_VERSION` 53. It is not a
   * refinement of the old number, it is a different quantity: the recovery is how long until
   * you may swing AGAIN (11 ticks on the saber), the window is how long this swing can hit
   * (4). Timing off the recovery was the only option when this file was written, because
   * `swingSec` was authored-but-unconverted and the sim had no window at all — the arc
   * resolved instantly on the swing tick. The two are not even proportional across the
   * roster: the spear's window is 33% of its recovery and the hammer's 30%, but the
   * frostbrand's is 36%, so no constant could have stood in for it.
   */
  windowMs: number;
}

/** The starter saber (`weaponSpecs/starter.ts`: 162°, a 4-tick window @ 30 Hz). The sweep scale
 *  below is defined AS the ratio between this shape and the tuned constants above, so
 *  `swingSchedule(DEFAULT_SWING)` — and therefore every caller with no spec to hand, i.e. the
 *  Graphics placeholder and any enemy, none of which carry a melee weapon — reproduces the
 *  saber's own sweep exactly rather than approximately. */
export const DEFAULT_SWING: SwingShape = { arcDeg: 162, windowMs: (4 * 1000) / 30 };

const SWEEP_DEG = SWING_ARC_DEG - SWING_WINDUP_DEG; // 68° — the saber's full travel
const SWEEP_PER_ARC_DEG = SWEEP_DEG / DEFAULT_SWING.arcDeg;
const WINDUP_SHARE = -SWING_WINDUP_DEG / SWEEP_DEG;
/** Bounds on the DERIVED travel, degrees. The blade is drawn from an aim-tracking socket, so a
 *  sweep much past ~100° swings it through the body rather than around it; and a sector narrow
 *  enough to derive under ~26° stops reading as a swing at the ~13-20 px an actor occupies. The
 *  sector FX (`game/fx/slashArc.ts`) shows the weapon's TRUE arc, unclamped — these two bounds
 *  are about the body's motion staying legible, not about hiding the sector's real size. */
const SWEEP_MIN_DEG = 26;
const SWEEP_MAX_DEG = 104;
/** Bounds on the derived envelope length, ms. Kept from the `recoveryMs` era and still doing the
 *  same job, but nothing in the shipped roster binds on either now: the windows run 3-6 ticks, so
 *  the derived envelopes span 182-364 ms and sit comfortably inside. They are the guard for a
 *  future weapon authored at an extreme `swingSec`, not tuning applied to a current one. */
const SWING_MIN_MS = 130;
const SWING_MAX_MS = 400;

/** One swing's fully-derived timing and travel. Shared with the sector FX, which schedules
 *  itself off `strikeStartMs`/`strikeEndMs` so the arc on the ground and the blade in the air
 *  are the same event rather than two effects that happen to overlap. */
export interface SwingSchedule {
  /** Total envelope length, ms. */
  totalMs: number;
  /** Degrees BEHIND the aim line the module cocks to (negative). */
  windupDeg: number;
  /** Degrees PAST the aim line the strike carries to (positive). */
  strikeDeg: number;
  /** ms into the envelope at which the blade leaves the cock and starts crossing the aim line. */
  strikeStartMs: number;
  /** ms into the envelope at which it reaches `strikeDeg` — the sector is fully swept by here. */
  strikeEndMs: number;
}

/**
 * Derive one swing's schedule. Pure, and cheap enough to call per swing (two clamps and four
 * multiplies) — nothing caches it, so a weapon retune needs no invalidation anywhere.
 *
 * The envelope is anchored so that **`strikeEndMs` lands on the close of the sim's hit window**:
 * the sim opens the window on the tick the swing starts, so the visible stroke then covers
 * exactly the ticks that can damage something, and the recovery tail plays out over what is
 * genuinely recovery in the sim too. The wind-up necessarily plays INSIDE the live window — the
 * render layer learns about a swing on the tick it starts and cannot anticipate it — which is the
 * one part of the shape that cannot be honest, and is unchanged from before.
 *
 * Worked: the saber's 4-tick window is ~133 ms, so the envelope is 133/0.55 ≈ 242 ms; the
 * hammer's 6 ticks give ~364 ms and the spear's 3 give ~182 ms. Three weapons, three swings —
 * and the sector fx inherits all of it, since it schedules off `strikeStartMs`/`strikeEndMs`.
 */
export function swingSchedule(shape: SwingShape = DEFAULT_SWING): SwingSchedule {
  const sweep = clamp(shape.arcDeg * SWEEP_PER_ARC_DEG, SWEEP_MIN_DEG, SWEEP_MAX_DEG);
  const totalMs = clamp(windowToTotalMs(shape.windowMs), SWING_MIN_MS, SWING_MAX_MS);
  return {
    totalMs,
    windupDeg: -sweep * WINDUP_SHARE,
    strikeDeg: sweep * (1 - WINDUP_SHARE),
    strikeStartMs: totalMs * SWING_WINDUP,
    strikeEndMs: totalMs * SWING_STRIKE,
  };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Envelope length whose strike ENDS as the sim's `windowMs`-long hit window closes. A
 *  non-positive or NaN window (a caller with no spec, a malformed one) falls back to the saber's
 *  own rather than dividing — an `Infinity` here would freeze the blade mid-air forever. */
function windowToTotalMs(windowMs: number): number {
  if (!(windowMs > 0)) return SWING_MS;
  return windowMs / SWING_STRIKE;
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
  /** The swing currently in flight, re-derived by each melee `kick`. Held rather than
   *  recomputed per getter so all four read sites of one frame agree even if a weapon swap
   *  lands between them. */
  private swing: SwingSchedule = swingSchedule();

  /** An attack just left this rig — start (or restart) the envelope for that kind. `shape` is
   *  the melee weapon that swung; omitted (a shot, or a caller with no melee spec) it falls
   *  back to `DEFAULT_SWING`, the starter saber's own shape. */
  kick(kind: AttackKind, shape?: SwingShape): void {
    this.kind = kind;
    if (kind === 'melee') this.swing = swingSchedule(shape);
    this.ms = kind === 'melee' ? this.swing.totalMs : RECOIL_MS;
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
    return 1 - this.ms / (this.kind === 'melee' ? this.swing.totalMs : RECOIL_MS);
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
   *  (pre-mirror) space. Melee only — a gun does not sweep. Travel comes from the swinging
   *  WEAPON (`swingSchedule`); the three phases and their split are the motion's own. */
  get swingDeg(): number {
    const u = this.progress;
    if (u < 0 || this.kind !== 'melee') return 0;
    const { windupDeg, strikeDeg } = this.swing;
    if (u < SWING_WINDUP) return lerp(0, windupDeg, u / SWING_WINDUP);
    if (u < SWING_STRIKE) return lerp(windupDeg, strikeDeg, (u - SWING_WINDUP) / (SWING_STRIKE - SWING_WINDUP));
    return lerp(strikeDeg, 0, (u - SWING_STRIKE) / (1 - SWING_STRIKE));
  }

  /** The swing's body-travel profile, same three phases as `swingDeg`: drift back through the
   *  wind-up, drive forward to a peak at the strike, recover to rest. 1 = a full lunge. */
  private lunge(u: number): number {
    if (u < SWING_WINDUP) return lerp(0, -SWING_WINDUP_LUNGE, u / SWING_WINDUP);
    if (u < SWING_STRIKE) return lerp(-SWING_WINDUP_LUNGE, 1, (u - SWING_WINDUP) / (SWING_STRIKE - SWING_WINDUP));
    return lerp(1, 0, (u - SWING_STRIKE) / (1 - SWING_STRIKE));
  }
}
