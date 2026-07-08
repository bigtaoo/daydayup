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
import { toTicks, toFpGrid, toFpPerTick } from './convert';

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
  /** Seconds before the weapon can be used again. For ranged this IS the fire rate. */
  cooldownSec: number;
}

export interface RangedSpec extends WeaponBase {
  kind: 'ranged';
  bullets: number; // pellets per shot
  spreadDeg: number; // total cone; per-pellet jitter drawn from combatPrng (07). 0 = pinpoint
  bulletSpeed: number; // grid/s
  damage: number; // integer; flat-armor subtract at hit (07)
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
  arcDeg: number; // full swing sector; hit test uses half of this each side
  rangeGrid: number; // reach from actor centre, grid
  swingSec: number; // ACTIVE hit-window (subset of cooldownSec), 07 step 7
  knockback: number; // impulse grid/s applied to target vx/vy in swing dir (07)
  deflect: boolean; // can block/deflect bullets — the ranged-vs-melee trade-off gate (03/05)
  deflectSpeed: number; // grid/s of a redirected bullet (Stage C; demo 5.5px/f·1.4)
  blockHalfDeg: number; // blockArc() half-angle (07 step 6)
  blockRangeGrid: number; // blockArc() radius, grid
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
  // Demo: swingRate 22f, damage 2, arc 0.9π, range 46px, blockHalf 0.42π, blockRange 54px.
  //   cooldownSec 0.37 → 11 ticks      damage 2 → 2 swings to drop a 3-HP enemy (hits ALL in arc)
  //   arcDeg 162 → half 81° = 14746 brad   rangeGrid 1.44 (46px)
  //   deflect true → the whole point; deflectSpeed 14.4 grid/s (demo 5.5px/f·1.4)
  //   blockHalfDeg 76 → 13836 brad     blockRangeGrid 1.69 (54px)
  saber: {
    id: 'saber',
    kind: 'melee',
    nameKey: 'weapon.saber.name',
    skinRef: 'sword_default',
    cooldownSec: 0.37, // recovery between swings
    damage: 2,
    arcDeg: 162, // 0.9π (demo)
    rangeGrid: 1.44, // demo 46px
    swingSec: 0.13, // active hit window ⊂ cooldown
    knockback: 6, // grid/s impulse (applied by HitResolve once z/knockback lands, 07)
    deflect: true, // ranged loadouts have no parry (03/05)
    deflectSpeed: 14.4, // grid/s of a redirected bullet (demo 5.5px/f · 1.4 · 60/32)
    blockHalfDeg: 76, // 0.42π (demo)
    blockRangeGrid: 1.69, // demo 54px
  },

  // ── Enemy gun (basic mob loadout — not player-selectable) ───────────────────
  // Demo Game.ts enemy: fireInterval 90f, bullet dmg 1, muzzle 20px, same ballistic.
  //   cooldownSec 1.5 → 45 ticks    muzzleGrid 0.625 (20px)
  enemygun: {
    id: 'enemygun',
    kind: 'ranged',
    nameKey: 'weapon.enemygun.name',
    skinRef: 'gun_default',
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
};

// ── Conversion: authored WeaponSpec → sim-facing WeaponSimSpec (once) ──────────

/** Convert one authored weapon into the fp/brad/tick shape systems consume. */
export function toSimSpec(spec: WeaponSpec): WeaponSimSpec {
  if (spec.kind === 'ranged') {
    const sim: RangedSimSpec = {
      kind: 'ranged',
      name: spec.id,
      fireRateTicks: toTicks(spec.cooldownSec),
      bulletSpeed: toFpPerTick(spec.bulletSpeed),
      bulletLifeTicks: toTicks(spec.lifespanSec),
      bulletRadius: toFpGrid(spec.bulletRadius),
      muzzleOffset: toFpGrid(spec.muzzleGrid),
      bulletZ: toFpGrid(spec.bulletZ),
      damage: spec.damage,
    };
    return sim;
  }
  const sim: MeleeSimSpec = {
    kind: 'melee',
    name: spec.id,
    swingCooldownTicks: toTicks(spec.cooldownSec),
    damage: spec.damage,
    arcHalf: degToBrad(spec.arcDeg / 2),
    range: toFpGrid(spec.rangeGrid),
    blockHalf: degToBrad(spec.blockHalfDeg),
    blockRange: toFpGrid(spec.blockRangeGrid),
    deflectSpeed: toFpPerTick(spec.deflectSpeed),
  };
  return sim;
}

// Pre-converted sim specs — the constants systems / blueprints reference.
export const BLASTER_SIM = toSimSpec(WEAPON_SPECS.blaster!) as RangedSimSpec;
export const SABER_SIM = toSimSpec(WEAPON_SPECS.saber!) as MeleeSimSpec;
export const ENEMY_GUN_SIM = toSimSpec(WEAPON_SPECS.enemygun!) as RangedSimSpec;

/** Fresh weapon runtime for a spec (design/08: cooldown in whole ticks). */
export function makeWeapon(spec: WeaponSimSpec): WeaponState {
  return { spec, cooldownTicks: 0, blocking: false, justSwung: false };
}
