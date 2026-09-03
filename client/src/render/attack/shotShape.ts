// The RANGED half of one attack's derivation — the sibling of `swingShape.ts`, split out of
// rigAttackMotion.ts on the same 2026-09-02 pass and for the same reason (500-line convention,
// form (1) — pure functions, no state, no clock, no Pixi).
//
// ## What was wrong with one hardcoded recoil
//
// Until this pass every gun in the game kicked identically: 150 ms, 10 authoring px of slide,
// 3 px of body lean, tuned against the starter blaster and applied to all eighteen ranged
// weapons. Two things that costs, and the first one is a defect rather than a missing flourish:
//
//   - THE ENVELOPE DID NOT FIT THE CADENCE. The repeater and the flamer fire every 3 ticks
//     (100 ms) against a 150 ms recoil, so the next shot restarted the envelope halfway out and
//     the gun never came back — it sat permanently displaced for the whole of a held trigger and
//     snapped home on release. `AttackMotion`'s "an attack that lands while the previous one is
//     still settling simply restarts it" is the right rule; what was wrong is that for the
//     fastest third of the roster the settle could never happen at all.
//   - EVERY GUN FELT THE SAME. A 0.9 s mortar and a 0.1 s flamer shoved the shooter by the same
//     three pixels, which is the ranged half of exactly what was asked about melee
//     (2026-09-02): heavy and light should not read alike.
//
// ## The two inputs
//
//   intervalMs  the weapon's own fire cadence (`RangedSimSpec.fireRateTicks`). Sizes the
//               envelope, so the kick always has room to return before the next shot.
//   punch       damage per trigger pull (`damage * bullets`). Scales the three magnitudes.
//
// `punch` is the honest per-shot heft available in the sim: there is no ranged `knockback` field
// the way melee has one, and the recoil impulse of a real shot goes with what leaves the barrel.
// It is taken per TRIGGER PULL, not per bullet, because that is what the shooter's arm absorbs —
// which is why the scattergun's five 1-damage pellets kick like the cannon's single 3-damage
// shell rather than like the blaster. Both ends are bounded (see `KICK_MIN`/`KICK_MAX`): the
// novaburst's ten-bullet ring would otherwise derive a 3.2x kick, and it is a radial volley with
// no single direction to be shoved away from in the first place.
//
// ## And the third channel: the muzzle climbs
//
// The old recoil only slid the gun straight back down its own barrel, which is the component a
// player is least able to see — it is foreshortened to nothing when firing toward or away from
// the camera, i.e. half of all aim angles. A real recoil also ROTATES the muzzle up, and that
// component is fully visible at every aim angle. The channel for it already exists and is
// already read every frame (`RigSkin.canonicalWeaponAngleRad` adds the melee swing's arc to the
// socket's aim); it was simply always 0 for a gun. Asked for directly on the same pass:
// *"the firing motion could use some optimisation too"*.

/** The weapon-side inputs the fire recoil is derived from, in render units so this file needs no
 *  engine import (the tick conversion belongs at the read site,
 *  `game/controllers/EventReactor.shotShapeOf`). */
export interface ShotShape {
  /** Ticks between shots as ms — `RangedSimSpec.fireRateTicks` at the sim's tick rate. The
   *  roster spans 3 ticks (repeater/flamer, 100 ms) to 45 (enemygun, 1500 ms). */
  intervalMs: number;
  /** Damage one trigger pull puts out — `damage * bullets`. 1 on the blaster, 3 on the cannon,
   *  5 on the scattergun's pellet spread, 10 on the novaburst ring. */
  punch: number;
}

/** Total time the STARTER BLASTER's recoil takes to kick out and settle back, ms — the reference
 *  every constant here was tuned against, and (with `DEFAULT_SHOT`) the definition of
 *  `RECOIL_SHARE`. Any other weapon scales off its own cadence. */
export const RECOIL_MS = 150;
/** How far the weapon module slides back along its own barrel at the blaster's peak, in rig
 *  AUTHORING px (the space `rigWeaponMount` works in — a rig's own scale to world px is
 *  `radius / referenceRadius`, ~0.35 for orb-core, and the room camera then zooms ~4x, so this
 *  lands around a dozen screen px). Sized against the authored `attack` clip's own
 *  `translateX: -10` on the same bone, which is the look this replaced — and which has since
 *  been REMOVED from that clip, so the two can no longer double up. */
export const RECOIL_MODULE_PX = 10;
/** How far the whole body shoves back with the blaster's shot, same units. Deliberately a small
 *  fraction of the module's kick: the gun recoils, the character only leans. */
export const RECOIL_BODY_PX = 3;
/** How far the blaster's muzzle RISES at the peak, degrees of socket rotation. Small on purpose:
 *  the socket is the whole weapon assembly, so this tips the gun rather than breaking the
 *  shooter's wrist, and it has to stay well inside the melee sweep's range (the two share one
 *  read site) so a shot never reads as a stroke. */
export const RECOIL_CLIMB_DEG = 6;
/** Fraction of the envelope spent kicking OUT. The rest is the return. A fast punch and a
 *  slow-ish settle is what reads as weight; a symmetric triangle reads as a wobble. */
const RECOIL_ATTACK = 0.22;

/** The starter blaster (`weaponSpecs/starter.ts`: a 6-tick cooldown @ 30 Hz, 1 damage, 1
 *  bullet). Like `DEFAULT_SWING`, this is the shape the constants above ARE, so a caller with no
 *  spec to hand — the Graphics placeholder, and any rig whose owner could not be resolved —
 *  reproduces the hand-tuned blaster recoil exactly rather than approximately. */
export const DEFAULT_SHOT: ShotShape = { intervalMs: (6 * 1000) / 30, punch: 1 };

/** Share of a weapon's fire interval the recoil envelope occupies. Defined as the ratio that
 *  makes the blaster's 200 ms cadence derive its own tuned 150 ms, so it is one number rather
 *  than two that have to be kept consistent. Under 1, which is what guarantees the envelope
 *  finishes before the next shot for every weapon the min clamp does not catch. */
const RECOIL_SHARE = RECOIL_MS / DEFAULT_SHOT.intervalMs;
/** Floor on the envelope, ms. The three-tick weapons (repeater, flamer) derive 75 ms, so this
 *  does not bind on the roster; it stops a hypothetical one-tick weapon from deriving a recoil
 *  shorter than two render frames, which would flicker rather than kick. It is also the ONE
 *  clamp that can push the envelope past the cadence, and by at most 37 ms. */
const RECOIL_MIN_MS = 70;
/** Ceiling on the envelope, ms. A 1.5 s enemygun would otherwise take 1.1 s to settle, during
 *  which the mob is visibly leaning away from a shot that left a second ago. Past a certain point
 *  a slower weapon should not keep getting a slower recoil, it should just keep the heaviest one.
 *
 *  Chosen by measuring how much of the roster it swallows, because a ceiling set too low is the
 *  same "every gun feels the same" defect this file exists to fix, moved rather than removed. At
 *  260 ms (the first cut) every weapon past ~10 ticks pinned — thirteen of the eighteen. At 380
 *  the derivation stays live out to 15 ticks, which is where the roster's own fast half ends: the
 *  eight weapons at 0.5 s and under span 75-375 ms in six distinct lengths, and the nine at
 *  0.55 s and up share the ceiling. Those nine still differ from each other in MAGNITUDE — that
 *  is `punch`'s axis, and it is independent of this one — so the cap costs the pacing difference
 *  between two already-slow weapons, not the difference between a mortar and a flamer. */
const RECOIL_MAX_MS = 380;
/** Bounds on the derived magnitude multiplier. A square root for the same reason `heftOf` uses
 *  one — `punch` spans 10x across the roster and these are body/module offsets in authoring px,
 *  so a linear map would put the novaburst's gun 32 px off its own mount. The upper bound then
 *  catches the two volley weapons (scattergun/cinderscatter derive 2.24, novaburst 3.16); the
 *  lower one is inert today (nothing is authored under 1 damage) and exists so a future
 *  fractional-damage weapon still visibly kicks. */
const KICK_MIN = 0.7;
const KICK_MAX = 2.2;

/** One shot's fully-derived envelope. The three magnitudes are PEAK values — `AttackMotion`
 *  multiplies each by the shared `amount` curve, so they rise and fall as one motion. */
export interface RecoilSchedule {
  /** Total envelope length, ms — out and back. */
  totalMs: number;
  /** Peak slide back down the barrel, authoring px, > 0. */
  modulePx: number;
  /** Peak body lean AWAY from the aim, authoring px, > 0. */
  bodyPx: number;
  /** Peak muzzle rise, DEGREES in canonical (pre-mirror) space. NEGATIVE = up, matching the
   *  sign convention `SwingSchedule.windupDeg` uses for "back and above the aim line". */
  climbDeg: number;
}

/**
 * Derive one shot's recoil envelope. Pure and allocation-light, called once per `bullet_fired`.
 *
 * Worked, across the roster's spread:
 *
 *   weapon        interval  punch  ->  envelope   module   body   climb
 *   flamer           100ms    1        75ms        10.0px  3.0px   -6.0deg
 *   blaster          200ms    1       150ms        10.0px  3.0px   -6.0deg
 *   teslagun         367ms    2       275ms        14.1px  4.2px   -8.5deg
 *   scattergun       567ms    5       380ms        22.0px  6.6px  -13.2deg
 *   mortar           900ms    2       380ms        14.1px  4.2px   -8.5deg
 */
export function recoilSchedule(shape: ShotShape = DEFAULT_SHOT): RecoilSchedule {
  const intervalMs = positive(shape.intervalMs, DEFAULT_SHOT.intervalMs);
  const kick = kickOf(shape.punch);
  return {
    totalMs: clamp(intervalMs * RECOIL_SHARE, RECOIL_MIN_MS, RECOIL_MAX_MS),
    modulePx: RECOIL_MODULE_PX * kick,
    bodyPx: RECOIL_BODY_PX * kick,
    climbDeg: -RECOIL_CLIMB_DEG * kick,
  };
}

/** The magnitude multiplier for a shot that puts out this much damage per trigger pull, 1 at the
 *  blaster's own 1. Its own function for the same reason `heftOf` is. */
export function kickOf(punch: number): number {
  const p = positive(punch, DEFAULT_SHOT.punch);
  return clamp(Math.sqrt(p / DEFAULT_SHOT.punch), KICK_MIN, KICK_MAX);
}

/**
 * The recoil's envelope `elapsedMs` into the shot: 0 at rest, 1 at the peak of the kick. One
 * curve shared by all three magnitudes, so a heavier gun kicks further along the same shape
 * rather than along a different one.
 */
export function recoilAmount(elapsedMs: number, s: RecoilSchedule): number {
  if (elapsedMs <= 0 || elapsedMs >= s.totalMs) return 0;
  const u = elapsedMs / s.totalMs;
  return u < RECOIL_ATTACK ? u / RECOIL_ATTACK : (1 - u) / (1 - RECOIL_ATTACK);
}

/** `v` when it is a usable positive number, else `fallback` — the same guard `swingShape`'s own
 *  `positive` is, and here for the same reason: a malformed spec must degrade to the reference
 *  weapon rather than to an `Infinity` that would pin the gun off its mount forever. */
function positive(v: number, fallback: number): number {
  return v > 0 ? v : fallback;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
