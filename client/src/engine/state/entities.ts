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
import type { Affix } from '../balance/affixes';

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
  arcHalf: number; // swing sector half-angle, brad — used for BOTH damage and deflect
  range: Fp; // swing sector radius (reach from actor centre)
  deflect: boolean; // does the swing deflect bullets caught in its arc (design/03/05 parry)
  deflectSpeed: Fp; // fp per tick for a redirected bullet
}

export type WeaponSimSpec = RangedSimSpec | MeleeSimSpec;

/** Per-actor weapon runtime. cooldown counted in whole ticks (design/08). */
export interface WeaponState {
  // The unaffixed authored sim spec. Retained so an in-run affix pickup can
  // re-resolve `spec` = applyAffixes(base, player.affixes) without re-reading
  // config (design/09 load-once) — see PickupSystem / balance/build.ts.
  base: WeaponSimSpec;
  spec: WeaponSimSpec; // active spec systems read (base + current affix stack)
  cooldownTicks: number; // counts down each tick, 0 = ready
  justSwung: boolean; // melee: swing started THIS tick → HitResolve applies arc damage + DeflectSystem parries bullets in the arc, once
}

// ── Actors ────────────────────────────────────────────────────────────────────

export interface Actor {
  id: number;
  faction: Faction;
  gx: Fp;
  gy: Fp;
  z: Fp; // ground height — always 0 for actors (jump removed); a render offset only
  vx: Fp;
  vy: Fp;
  facing: Brad;
  hp: number;
  maxHp: number;
  radius: Fp; // body circle — bullet/melee hit target and sprite size
  // Ground-plane collision footprint (feet), used only for actor↔solid push-out
  // (MovementSystem). Smaller than `radius` so the tall sprite can overlap a solid
  // it stands against — the fake-3D depth trick (design/01/07). Bullets/melee still
  // use `radius`, so being shot still targets the whole visible body.
  footprintRadius: Fp;
  alive: boolean;
  weapon: WeaponState | null;
  firing: boolean; // intent this tick (ApplyInput / AIDecide → WeaponFire)
}

export interface PlayerActor extends Actor {
  faction: 'player';
  prevButtons: number; // last tick's button bitfield, for rising-edge detection
  // Loadout: up to two carried weapons (any mix of ranged/melee). SWAP toggles
  // the active slot; each slot keeps its own cooldown, so switching does NOT
  // refresh a weapon that is mid-cooldown. `weapon` (base Actor) mirrors
  // weapons[activeSlot] — systems only ever read the active pointer.
  weapons: WeaponState[];
  activeSlot: number;
  // The run's in-run power stack (design/05). Affix pickups append here; weapon-kind
  // affixes re-resolve every weapon slot, actor-kind (flat_maxhp) mutate the actor
  // on pickup. Wiped at run end (a fresh GameState starts empty).
  affixes: Affix[];
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

/**
 * A static round solid (design/07 "walls are static solids"). Pillars are drawn
 * round, so the launch collision geometry is a circle rather than an AABB tile —
 * actors are pushed out along the centre line (MovementSystem step 4). Positions
 * are grid-fp, converted once at construction from the EngineConfig px layout.
 */
export interface Obstacle {
  gx: Fp;
  gy: Fp;
  radius: Fp;
}

export type PickupKind = 'health' | 'coin' | 'affix' | 'weapon';

export interface PickupItem {
  id: number;
  kind: PickupKind;
  gx: Fp;
  gy: Fp;
  spawnTick: number; // tick it was dropped; not collectable until a later tick (design/08 step 8→9)
  alive: boolean;
  // Payload for the powered drops (design/05). Set on the matching kind only:
  weaponId?: string; // kind 'weapon' → id into WEAPON_SPECS
  affix?: Affix; //     kind 'affix'  → the rolled affix to append to the run stack
}
