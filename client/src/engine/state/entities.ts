/**
 * Plain-data entity types for the deterministic sim (design/08 "GameState is
 * plain data, no Pixi, no methods that decide outcomes"). All positional/velocity
 * state is Fp (fixed-point, design/06) and all angles are Brad (binary-radian).
 * Systems are the only code that mutates these; render/server only read.
 *
 * These are the sim-facing (already-converted) weapon shapes. The human-unit
 * WEAPON_SPECS catalog + converter that produce them live in content/weapons.ts
 * (Stage C); systems only ever see these fp/brad/tick specs.
 */
import type { Fp } from '../math/fixed';
import type { Brad } from '../math/trig';

export type Faction = 'player' | 'enemy';

/** Match outcome (design/08). Player ids are indices into state.players. */
export type Winner = number | 'enemies' | null;

// ── Weapon specs (sim-facing, already converted to ticks / Fp / Brad) ─────────

export interface RangedSimSpec {
  kind: 'ranged';
  name: string;
  fireRateTicks: number; // cooldown between shots, whole ticks
  bulletSpeed: Fp; // fp displacement per tick
  bulletLifeTicks: number;
  bulletRadius: Fp;
  muzzleOffset: Fp; // spawn distance from actor centre along facing
  bulletZ: Fp; // muzzle height band (design/07 z-gating; cosmetic until then)
  damage: number; // integer
}

export interface MeleeSimSpec {
  kind: 'melee';
  name: string;
  swingCooldownTicks: number; // recovery between swings
  damage: number; // integer, per enemy in arc, once per swing
  arcHalf: number; // swing sector half-angle, brad
  range: Fp; // reach from actor centre
  blockHalf: number; // block arc half-angle, brad
  blockRange: Fp;
  deflectSpeed: Fp; // fp per tick for a redirected bullet
}

export type WeaponSimSpec = RangedSimSpec | MeleeSimSpec;

/** Per-actor weapon runtime. cooldown/blocking counted in whole ticks (design/08). */
export interface WeaponState {
  spec: WeaponSimSpec;
  cooldownTicks: number; // counts down each tick, 0 = ready
  blocking: boolean; // melee: block arc up this tick
  justSwung: boolean; // melee: swing started THIS tick → HitResolve applies arc damage once
}

// ── Actors ────────────────────────────────────────────────────────────────────

export interface Actor {
  id: number;
  faction: Faction;
  gx: Fp;
  gy: Fp;
  z: Fp;
  vx: Fp;
  vy: Fp;
  vz: Fp;
  facing: Brad;
  hp: number;
  maxHp: number;
  radius: Fp;
  alive: boolean;
  weapon: WeaponState | null;
  firing: boolean; // intent this tick (ApplyInput / AIDecide → WeaponFire)
}

export interface PlayerActor extends Actor {
  faction: 'player';
  prevButtons: number; // last tick's button bitfield, for rising-edge detection
}

export interface EnemyActor extends Actor {
  faction: 'enemy';
}

// ── Projectiles / pickups ──────────────────────────────────────────────────────

export interface Projectile {
  id: number;
  faction: Faction;
  gx: Fp;
  gy: Fp;
  z: Fp;
  vx: Fp; // fp per tick
  vy: Fp;
  radius: Fp;
  damage: number;
  lifeTicks: number;
  alive: boolean;
}

export type PickupKind = 'health' | 'coin';

export interface PickupItem {
  id: number;
  kind: PickupKind;
  gx: Fp;
  gy: Fp;
  spawnTick: number; // tick it was dropped; not collectable until a later tick (design/08 step 8→9)
  alive: boolean;
}
