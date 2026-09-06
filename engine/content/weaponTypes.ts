/**
 * Authored weapon schema (design/09), split out of weapons.ts 2026-07-28 so the ~500-line
 * WEAPON_SPECS catalog (weaponSpecs.ts) and the conversion logic (weapons.ts) don't have to
 * share one 700-line file. Authored in HUMAN UNITS — see weapons.ts's own doc comment for
 * the conversion formulas applied once by `toSimSpec`.
 */
import type { DamageType } from './damage';
import type { RarityTier } from '../balance/rarity';
import type { BallisticId, EmissionPattern } from './ballistics';

// ── World scale (the anchor for every conversion) ────────────────────────────
//   1 grid unit = 32 px.  Demo playerRadius 16px = 0.5 grid (diameter 1 grid),
//   matching funny's 0.5-cell footprint. Demo runs @60fps; the sim runs @30Hz
//   (06 TICK_RATE). So: grid/s = (px/frame · 60) / 32.

export interface WeaponBase {
  id: string;
  nameKey: string; // i18n KEY only — never display text (09)
  skinRef: string; // SkinDef id (02) — the view swaps by this, not by weapon logic
  // Intrinsic rarity (design/03/14) — a fixed property of the weapon, not a roll and
  // not an upgrade. Grants the small `qualityMult` edge at convert time + drives the
  // render tier colour. Placeholder assignments below (design/09: final tuning TBD).
  rarity: RarityTier;
  /** Seconds before the weapon can be used again. For ranged this IS the fire rate. */
  cooldownSec: number;
  // k_* on-hit proc (design/03/09, ENGINE_VERSION 28 — the first concrete batch):
  // heals the firing player by this ‰ of the damage a hit deals. Shared by both kinds
  // since applyHit is the one funnel both go through. Omitted = 0, no healing.
  lifestealPermille?: number;
}

export interface RangedSpec extends WeaponBase {
  kind: 'ranged';
  bullets: number; // pellets per shot
  spreadDeg: number; // total cone; per-pellet jitter drawn from combatPrng (07). 0 = pinpoint
  pattern?: EmissionPattern; // emission layout (03); omitted = 'spread' (the jittered cone)
  bulletSpeed: number; // grid/s
  damage: number; // integer; flat-armor subtract at hit (07)
  damageType?: DamageType; // element → on-hit status (07); omitted = 'physical'
  ballistic: BallisticId;
  /**
   * Energy one TRIGGER PULL costs from the player's shared pool (design/03/05,
   * `balance/energy.ts`) — the price of the MECHANIC, not of the damage. Charged per
   * pull and never per pellet, so a spread frame pays once for the decision it is.
   *
   * Required rather than optional on purpose: an omitted price silently means "free",
   * and design/03 already records three fields this schema implies are live and are
   * not (`piercing`, `skinRef`, the sparse Frame x Element grid). A required field
   * makes a new weapon's price a compile error instead of a balance hole nobody sees.
   * `enemygun` carries 0 because enemies are structurally never charged — see
   * `WeaponFireSystem`.
   */
  energyCost: number;
  lifespanSec: number; // bullet self-expires after this
  bulletRadius: number; // grid (07 swept-circle collision)
  muzzleGrid: number; // spawn distance from actor centre along facing, grid (Stage C)
  bulletZ: number; // muzzle height band, grid (07 z-gating: shoot over low cover)
  piercing?: boolean;
  // Ballistic params (design/03/09) — each shape reads only its own; human units,
  // converted once by toSimSpec. Unset = the shape's param is unused.
  turnRateDegPerSec?: number; // homing: max turn rate toward the nearest foe
  blastRadiusGrid?: number; // lob: AoE radius on landing
  returnAfterSec?: number; // boomerang: time since fire at which velocity reverses
  beamSec?: number; // beam: total damage-window length
  beamTickIntervalSec?: number; // beam: time between damage applications
  beamRangeGrid?: number; // beam: max reach along the frozen facing
  orbitRadiusGrid?: number; // orbit: circling distance from the owner
  orbitPeriodSec?: number; // orbit: seconds for one full revolution (→ angular velocity)
  // k_* on-hit proc (design/03/09, ENGINE_VERSION 28): on a hit, retarget to the
  // nearest OTHER hostile actor instead of expiring, up to this many times. Omitted/0
  // = every existing weapon's behavior, unchanged. Melee has no equivalent (it doesn't travel).
  ricochetCount?: number;
}

export interface MeleeSpec extends WeaponBase {
  kind: 'melee';
  damage: number; // integer; per-target once per swing (07)
  damageType?: DamageType; // element → on-hit status (07); omitted = 'physical'
  arcDeg: number; // full swing sector; hit test uses half of this each side — deflect uses the SAME arc
  rangeGrid: number; // reach from actor centre, grid — the swing sector radius (also the deflect radius)
  swingSec: number; // ACTIVE hit-window (subset of cooldownSec), 07 step 7
  knockback: number; // impulse grid/s applied to target vx/vy in swing dir (07)
  deflect: boolean; // does the swing deflect enemy bullets caught in its arc — the ranged-vs-melee trade-off (03/05)
  deflectSpeed: number; // grid/s of a redirected bullet (Stage C; demo 5.5px/f·1.4)
}

export type WeaponSpec = RangedSpec | MeleeSpec;
