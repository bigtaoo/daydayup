/**
 * Weapon content (design/09) — the human-unit catalog and its one-time conversion
 * into the sim-facing WeaponSimSpec that systems consume. This is the single place
 * weapon numbers live; edit constants here, never the mechanics.
 *
 * Moved into @dd/engine in Stage C (was client/src/game/content/weapons.ts). The
 * hand-tuned WeaponSimSpec constants that lived in sim.config.ts during Stage B are
 * superseded by `toSimSpec()` applied to these authored specs — the numbers now
 * flow human-units → converter → sim once, at construction.
 *
 * Authored in HUMAN UNITS: seconds, grid-units/second, degrees, integer damage,
 * grid distances. Conversion (design/09):
 *   toTicks(sec)      = round(sec · 30)
 *   toFpGrid(grid)    = round(grid · 1000)
 *   toFpPerTick(g/s)  = ⌊round(g/s · 1000) · 33 / 1000⌋   // fp displacement / tick
 *   degToBrad(deg)    = round(deg / 360 · 65536)
 */
import type {
  MeleeSimSpec,
  RangedSimSpec,
  WeaponSimSpec,
  WeaponState,
} from '../state/entities';
import { degToBrad } from '../math/trig';
import type { DamageType } from './damage';
import { toTicks, toFpGrid, toFpPerTick } from './convert';
import { applyQuality, type RarityTier } from '../balance/rarity';

// ── World scale (the anchor for every conversion) ────────────────────────────
//   1 grid unit = 32 px.  Demo playerRadius 16px = 0.5 grid (diameter 1 grid),
//   matching funny's 0.5-cell footprint. Demo runs @60fps; the sim runs @30Hz
//   (06 TICK_RATE). So: grid/s = (px/frame · 60) / 32.

// ── Authored schema (subset of 09's WeaponSpec; grows with the ballistic library) ──

export type BallisticId = 'straight'; // 03/07 shape library extends this later

interface WeaponBase {
  id: string;
  nameKey: string; // i18n KEY only — never display text (09)
  skinRef: string; // SkinDef id (02) — the view swaps by this, not by weapon logic
  // Intrinsic rarity (design/03/14) — a fixed property of the weapon, not a roll and
  // not an upgrade. Grants the small `qualityMult` edge at convert time + drives the
  // render tier colour. Placeholder assignments below (design/09: final tuning TBD).
  rarity: RarityTier;
  /** Seconds before the weapon can be used again. For ranged this IS the fire rate. */
  cooldownSec: number;
}

export interface RangedSpec extends WeaponBase {
  kind: 'ranged';
  bullets: number; // pellets per shot
  spreadDeg: number; // total cone; per-pellet jitter drawn from combatPrng (07). 0 = pinpoint
  bulletSpeed: number; // grid/s
  damage: number; // integer; flat-armor subtract at hit (07)
  damageType?: DamageType; // element → on-hit status (07); omitted = 'physical'
  ballistic: BallisticId;
  lifespanSec: number; // bullet self-expires after this
  bulletRadius: number; // grid (07 swept-circle collision)
  muzzleGrid: number; // spawn distance from actor centre along facing, grid (Stage C)
  bulletZ: number; // muzzle height band, grid (07 z-gating: shoot over low cover)
  piercing?: boolean;
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

// ── The demo weapons ──────────────────────────────────────────────────────────
//
// Economy this is balanced against (first pass, matches the demo):
//   player HP 6 · basic enemy HP 3 · player move 6 grid/s (demo 3.2px/frame).
// Design intent (03/05): the GUN is safe ranged chip damage; the SABER trades
// reach for higher burst + AoE arc + the deflect mechanic. Picking the gun means
// giving up parry — a genuine trade-off, not a strictly-worse choice.

export const WEAPON_SPECS: Record<string, WeaponSpec> = {
  // ── Blaster (starter pistol) ────────────────────────────────────────────────
  // Demo: fireRate 12f, bulletSpeed 5.5px/f, lifetime 180f, damage 1, muzzle 30px.
  //   cooldownSec 0.20  → 6 ticks   (5 shots/s)        bulletSpeed 10 → 330 fp/tick
  //   lifespanSec 3.0   → 90 ticks                     damage 1 → 3 shots to drop a 3-HP enemy
  //   muzzleGrid 0.9375 (30px)   bulletRadius 0.15 (5px)   spreadDeg 0 → pinpoint (03)
  blaster: {
    id: 'blaster',
    kind: 'ranged',
    nameKey: 'weapon.blaster.name',
    skinRef: 'gun_default',
    rarity: 'common', // 白 — the baseline starter pistol

    cooldownSec: 0.2, // = fire rate; 5 shots/s
    bullets: 1,
    spreadDeg: 0,
    bulletSpeed: 10, // grid/s  (demo 5.5px/f·60/32 = 10.3, rounded)
    damage: 1, // chip damage — the gun's identity vs the saber's burst (03/05)
    ballistic: 'straight',
    lifespanSec: 3.0,
    bulletRadius: 0.15, // grid (demo 5px/32 = 0.156)
    muzzleGrid: 0.9375, // grid (demo 30px/32)
    bulletZ: 0.5, // fired at chest height → clears ground-hug hazards, blocked by tall cover (07)
  },

  // ── Saber (starter melee) ─────────────────────────────────────────────────────
  // Demo: swingRate 22f, damage 2, arc 0.9π, range 46px.
  //   cooldownSec 0.37 → 11 ticks      damage 2 → 2 swings to drop a 3-HP enemy (hits ALL in arc)
  //   arcDeg 162 → half 81° = 14746 brad   rangeGrid 1.44 (46px)
  //   deflect true → the whole point; a swing parries any enemy bullet in the SAME arc.
  //   deflectSpeed 14.4 grid/s (demo 5.5px/f·1.4)
  saber: {
    id: 'saber',
    kind: 'melee',
    nameKey: 'weapon.saber.name',
    skinRef: 'sword_default',
    rarity: 'common', // 白 — the baseline starter melee

    cooldownSec: 0.37, // recovery between swings
    damage: 2,
    arcDeg: 162, // 0.9π (demo) — the swing sector; enemies hit + bullets deflected inside it
    rangeGrid: 1.44, // demo 46px
    swingSec: 0.13, // active hit window ⊂ cooldown
    knockback: 6, // grid/s impulse (applied by HitResolve once z/knockback lands, 07)
    deflect: true, // ranged loadouts have no parry (03/05)
    deflectSpeed: 14.4, // grid/s of a redirected bullet (demo 5.5px/f · 1.4 · 60/32)
  },

  // ── Repeater (drop-only: fast, weak) ─────────────────────────────────────────
  // The "spray" gun — a weapon drop that trades punch for uptime, a wall of chip damage.
  repeater: {
    id: 'repeater',
    kind: 'ranged',
    nameKey: 'weapon.repeater.name',
    skinRef: 'gun_default',
    rarity: 'fine', // 蓝 — a slightly nicer floor drop

    cooldownSec: 0.1, // 3 ticks — 10 shots/s
    bullets: 1,
    spreadDeg: 0,
    bulletSpeed: 12, // grid/s
    damage: 1,
    ballistic: 'straight',
    lifespanSec: 2.0,
    bulletRadius: 0.12,
    muzzleGrid: 0.9375,
    bulletZ: 0.5,
  },

  // ── Cannon (drop-only: slow, heavy) ──────────────────────────────────────────
  // The opposite pole — big single hits that two-shot a basic enemy raw. Slow
  // enough that positioning matters.
  cannon: {
    id: 'cannon',
    kind: 'ranged',
    nameKey: 'weapon.cannon.name',
    skinRef: 'gun_default',
    rarity: 'epic', // 紫 — a standout heavy-hitter drop

    cooldownSec: 0.6, // 18 ticks
    bullets: 1,
    spreadDeg: 0,
    bulletSpeed: 8, // grid/s
    damage: 3,
    ballistic: 'straight',
    lifespanSec: 3.0,
    bulletRadius: 0.28,
    muzzleGrid: 1.0,
    bulletZ: 0.5,
  },

  // ── Enemy gun (basic mob loadout — not player-selectable) ───────────────────
  // Demo Game.ts enemy: fireInterval 90f, bullet dmg 1, muzzle 20px, same ballistic.
  //   cooldownSec 1.5 → 45 ticks    muzzleGrid 0.625 (20px)
  enemygun: {
    id: 'enemygun',
    kind: 'ranged',
    nameKey: 'weapon.enemygun.name',
    skinRef: 'gun_default',
    rarity: 'common', // 白 — mob loadout, never player-facing

    cooldownSec: 1.5, // 90 frames @60fps
    bullets: 1,
    spreadDeg: 0,
    bulletSpeed: 10, // grid/s
    damage: 1,
    ballistic: 'straight',
    lifespanSec: 3.0,
    bulletRadius: 0.15,
    muzzleGrid: 0.625, // grid (demo 20px/32)
    bulletZ: 0.5,
  },

  // ── Elemental weapons (design/03 "distinct behavior" — each layers an on-hit
  //    status the combat systems interpret; see content/damage.ts). ─────────────

  // Flamer (fire): short-range sprayer. Fast, weak per shot, but burn refreshes on
  // every hit → continuous DoT while you keep the stream on target. Short lifespan
  // = you must close in — the fire trade-off (range for damage-over-time).
  flamer: {
    id: 'flamer',
    kind: 'ranged',
    nameKey: 'weapon.flamer.name',
    skinRef: 'gun_default',
    rarity: 'fine', // 蓝

    cooldownSec: 0.1, // 3 ticks — 10 shots/s, keeps burn topped up
    bullets: 1,
    spreadDeg: 0,
    bulletSpeed: 9,
    damage: 1,
    damageType: 'fire',
    ballistic: 'straight',
    lifespanSec: 0.55, // short reach — the flamethrower band
    bulletRadius: 0.22,
    muzzleGrid: 0.9375,
    bulletZ: 0.5,
  },

  // Cryobolt (ice): slow, deliberate shot that chills — the target crawls while you
  // reposition or line up the next hit. Higher single-hit than the flamer; the value
  // is control, not raw dps.
  cryobolt: {
    id: 'cryobolt',
    kind: 'ranged',
    nameKey: 'weapon.cryobolt.name',
    skinRef: 'gun_default',
    rarity: 'epic', // 紫

    cooldownSec: 0.5, // 15 ticks
    bullets: 1,
    spreadDeg: 0,
    bulletSpeed: 11,
    damage: 2,
    damageType: 'ice',
    ballistic: 'straight',
    lifespanSec: 3.0,
    bulletRadius: 0.18,
    muzzleGrid: 0.9375,
    bulletZ: 0.5,
  },

  // Teslagun (lightning): every hit arcs to a second nearby enemy for half damage —
  // the crowd-clear gun. Middling on a lone target, excellent into a pack.
  teslagun: {
    id: 'teslagun',
    kind: 'ranged',
    nameKey: 'weapon.teslagun.name',
    skinRef: 'gun_default',
    rarity: 'epic', // 紫

    cooldownSec: 0.35, // ~11 ticks
    bullets: 1,
    spreadDeg: 0,
    bulletSpeed: 13, // fast, snappy
    damage: 2,
    damageType: 'lightning',
    ballistic: 'straight',
    lifespanSec: 2.0,
    bulletRadius: 0.15,
    muzzleGrid: 0.9375,
    bulletZ: 0.5,
  },

  // Venomspit (poison): each hit adds an independent stack; sustained fire ramps a
  // target toward heavy DoT that keeps ticking after you break off. The patient-DPS
  // gun — kill things that are already walking away.
  venomspit: {
    id: 'venomspit',
    kind: 'ranged',
    nameKey: 'weapon.venomspit.name',
    skinRef: 'gun_default',
    rarity: 'fine', // 蓝

    cooldownSec: 0.22, // ~7 ticks — stacks build with uptime
    bullets: 1,
    spreadDeg: 0,
    bulletSpeed: 9,
    damage: 1,
    damageType: 'poison',
    ballistic: 'straight',
    lifespanSec: 2.5,
    bulletRadius: 0.16,
    muzzleGrid: 0.9375,
    bulletZ: 0.5,
  },

  // Emberblade (fire melee): the saber's burst + a burn on everything the arc
  // touches. Swing, back off, let the fire finish the wave. Parries like the saber.
  emberblade: {
    id: 'emberblade',
    kind: 'melee',
    nameKey: 'weapon.emberblade.name',
    skinRef: 'sword_default',
    rarity: 'legend', // 橙

    cooldownSec: 0.37,
    damage: 2,
    damageType: 'fire',
    arcDeg: 162,
    rangeGrid: 1.44,
    swingSec: 0.13,
    knockback: 6,
    deflect: true,
    deflectSpeed: 14.4,
  },

  // Frostbrand (ice melee): a wider, slower crowd-control swing that chills the
  // whole arc — everything it hits crawls, so a swarm can't collapse on you. Parries.
  frostbrand: {
    id: 'frostbrand',
    kind: 'melee',
    nameKey: 'weapon.frostbrand.name',
    skinRef: 'sword_default',
    rarity: 'legend', // 橙

    cooldownSec: 0.45, // slower recovery — control weapon
    damage: 2,
    damageType: 'ice',
    arcDeg: 200, // sweeping arc
    rangeGrid: 1.5,
    swingSec: 0.15,
    knockback: 5,
    deflect: true,
    deflectSpeed: 14.4,
  },

  // Stormglaive (lightning melee): long reach; each enemy the arc hits also arcs to
  // a neighbour. Reach + chain makes one swing clear a line. Parries.
  stormglaive: {
    id: 'stormglaive',
    kind: 'melee',
    nameKey: 'weapon.stormglaive.name',
    skinRef: 'sword_default',
    rarity: 'legendary', // 金 — the top-tier showcase drop

    cooldownSec: 0.4,
    damage: 2,
    damageType: 'lightning',
    arcDeg: 150,
    rangeGrid: 1.9, // longest melee reach
    swingSec: 0.14,
    knockback: 6,
    deflect: true,
    deflectSpeed: 14.4,
  },
};

// ── Conversion: authored WeaponSpec → sim-facing WeaponSimSpec (once) ──────────

/**
 * Convert one authored weapon into the fp/brad/tick shape systems consume. The
 * intrinsic rarity's quality multiplier is applied HERE, once (design/09 convert-
 * once): `damage` is scaled by the tier's small per-mille edge (`common` = ×1.0 =
 * identity, so a baseline weapon is byte-for-byte unchanged). The `rarity` field is
 * carried through for the render layer; no system reads it.
 */
export function toSimSpec(spec: WeaponSpec): WeaponSimSpec {
  if (spec.kind === 'ranged') {
    const sim: RangedSimSpec = {
      kind: 'ranged',
      name: spec.id,
      rarity: spec.rarity,
      fireRateTicks: toTicks(spec.cooldownSec),
      bulletSpeed: toFpPerTick(spec.bulletSpeed),
      bulletLifeTicks: toTicks(spec.lifespanSec),
      bulletRadius: toFpGrid(spec.bulletRadius),
      muzzleOffset: toFpGrid(spec.muzzleGrid),
      bulletZ: toFpGrid(spec.bulletZ),
      damage: applyQuality(spec.damage, spec.rarity),
      damageType: spec.damageType ?? 'physical',
    };
    return sim;
  }
  const sim: MeleeSimSpec = {
    kind: 'melee',
    name: spec.id,
    rarity: spec.rarity,
    swingCooldownTicks: toTicks(spec.cooldownSec),
    damage: applyQuality(spec.damage, spec.rarity),
    arcHalf: degToBrad(spec.arcDeg / 2),
    range: toFpGrid(spec.rangeGrid),
    deflect: spec.deflect,
    deflectSpeed: toFpPerTick(spec.deflectSpeed),
    damageType: spec.damageType ?? 'physical',
  };
  return sim;
}

// Pre-converted sim specs — the constants systems / blueprints reference.
export const BLASTER_SIM = toSimSpec(WEAPON_SPECS.blaster!) as RangedSimSpec;
export const SABER_SIM = toSimSpec(WEAPON_SPECS.saber!) as MeleeSimSpec;
export const ENEMY_GUN_SIM = toSimSpec(WEAPON_SPECS.enemygun!) as RangedSimSpec;
export const REPEATER_SIM = toSimSpec(WEAPON_SPECS.repeater!) as RangedSimSpec;
export const CANNON_SIM = toSimSpec(WEAPON_SPECS.cannon!) as RangedSimSpec;
export const FLAMER_SIM = toSimSpec(WEAPON_SPECS.flamer!) as RangedSimSpec;
export const CRYOBOLT_SIM = toSimSpec(WEAPON_SPECS.cryobolt!) as RangedSimSpec;
export const TESLAGUN_SIM = toSimSpec(WEAPON_SPECS.teslagun!) as RangedSimSpec;
export const VENOMSPIT_SIM = toSimSpec(WEAPON_SPECS.venomspit!) as RangedSimSpec;
export const EMBERBLADE_SIM = toSimSpec(WEAPON_SPECS.emberblade!) as MeleeSimSpec;
export const FROSTBRAND_SIM = toSimSpec(WEAPON_SPECS.frostbrand!) as MeleeSimSpec;
export const STORMGLAIVE_SIM = toSimSpec(WEAPON_SPECS.stormglaive!) as MeleeSimSpec;

/**
 * Sim-spec lookup by weapon id — the resolution a weapon drop uses (content/drops.ts
 * WEAPON_DROP_POOL holds ids; PickupSystem resolves through this). Converted once at
 * module load (design/09 load-once). enemygun is excluded — not player-facing.
 */
export const WEAPON_SIM_BY_ID: Record<string, WeaponSimSpec> = {
  blaster: BLASTER_SIM,
  saber: SABER_SIM,
  repeater: REPEATER_SIM,
  cannon: CANNON_SIM,
  flamer: FLAMER_SIM,
  cryobolt: CRYOBOLT_SIM,
  teslagun: TESLAGUN_SIM,
  venomspit: VENOMSPIT_SIM,
  emberblade: EMBERBLADE_SIM,
  frostbrand: FROSTBRAND_SIM,
  stormglaive: STORMGLAIVE_SIM,
};

/** Fresh weapon runtime for a spec (design/08: cooldown in whole ticks). */
export function makeWeapon(spec: WeaponSimSpec): WeaponState {
  return { spec, cooldownTicks: 0, justSwung: false };
}
