/**
 * Stage B sim tuning — the deterministic port of client/src/game/config.ts and
 * client/src/game/weapons/*.ts, expressed in Fp / Brad / ticks.
 *
 * SPATIAL UNIT (Stage B decision): 1 fp unit == 1 px, i.e. toFp(px). The real
 * grid conversion (÷32 per design/09) and the human-unit WEAPON_SPECS catalog +
 * converter land in Stage C and supersede this file. Speeds are pre-multiplied
 * from px/frame @60fps into fp-displacement-per-tick @30Hz (× 60/30 = ×2), so the
 * MovementSystem integrator is a plain addFp with no per-tick dt multiply.
 *
 * These constants are the ONE place Stage B numbers live; systems never inline a
 * magic number. Any change here that alters outcomes bumps ENGINE_VERSION.
 */
import { toFp } from './math/fixed';
import type {
  MeleeSimSpec,
  RangedSimSpec,
  WeaponSimSpec,
  WeaponState,
} from './state/entities';

// ── Actors / world (px @60fps → fp/tick @30Hz) ────────────────────────────────

export const SIM = {
  player: {
    radius: toFp(16),
    maxHp: 6,
    speedPerTick: toFp(6.4), // 3.2 px/frame × 2
    margin: toFp(20), // clamp inset from world edge
    jumpV: toFp(26), // 13 px/frame × 2
    gravity: toFp(3.6), // 0.9 px/frame² × 4 (dt doubled → dt² ×4)
  },
  enemy: {
    radius: toFp(15),
    maxHp: 3,
  },
  bullet: {
    oobMargin: toFp(50), // despawn once this far outside the world
  },
  waveBreakTicks: 24, // 48 frames pause between cleared wave and next spawn
  drop: {
    healPerMille: 340, // dropPrng.nextInt(1000) < this → health, else coin (was healChance 0.34)
    healAmount: 1,
  },
  pickupRadius: toFp(15), // collect padding beyond player radius
} as const;

// ── Weapons (see client/src/game/weapons/*.ts for the pre-port floats) ────────

/** Player pistol. Demo: fireRate 12f, speed 5.5px/f, lifetime 180f, hit dmg 2. */
export const PLAYER_BLASTER: RangedSimSpec = {
  kind: 'ranged',
  name: 'Blaster',
  fireRateTicks: 6, // 12 frames ÷ 2
  bulletSpeed: toFp(11), // 5.5 px/frame × 2
  bulletLifeTicks: 90, // 180 frames ÷ 2
  bulletRadius: toFp(5),
  muzzleOffset: toFp(30),
  damage: 2, // matches the demo's hardcoded player-bullet hit
};

/** Enemy shooter. Demo: fireInterval 90f, bullet dmg 1, muzzle 20px. */
export const ENEMY_BLASTER: RangedSimSpec = {
  kind: 'ranged',
  name: 'EnemyGun',
  fireRateTicks: 45, // 90 frames ÷ 2
  bulletSpeed: toFp(11),
  bulletLifeTicks: 90,
  bulletRadius: toFp(5),
  muzzleOffset: toFp(20),
  damage: 1,
};

/**
 * Player saber. Demo: swingRate 22f, dmg 2, arc 0.9π, range 46px,
 * blockHalf 0.42π, blockRange 54px, deflect speed ×1.4.
 * Brad: half-arc = round(0.45π / 2π × 65536) = 14746; blockHalf = round(0.21 × 65536) = 13763.
 */
export const PLAYER_SABER: MeleeSimSpec = {
  kind: 'melee',
  name: 'Saber',
  swingCooldownTicks: 11, // 22 frames ÷ 2
  damage: 2,
  arcHalf: 14746,
  range: toFp(46),
  blockHalf: 13763,
  blockRange: toFp(54),
  deflectSpeed: toFp(15.4), // 5.5 px/frame × 2 × 1.4
};

/** Fresh weapon runtime for a spec (design/08: cooldown in whole ticks). */
export function makeWeapon(spec: WeaponSimSpec): WeaponState {
  return { spec, cooldownTicks: 0, blocking: false, justSwung: false };
}
