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
import type { DamageType, ResistMap, StatusState } from '../content/damage';
import type { RarityTier } from '../balance/rarity';
import type { RunBuffId } from '../balance/runbuffs';
import type { BallisticId } from '../content/ballistics';

export type Faction = 'player' | 'enemy';

/** Match outcome (design/08). Player ids are indices into state.players. */
export type Winner = number | 'enemies' | null;

// ── Weapon specs (sim-facing, already converted to ticks / Fp / Brad) ─────────

export interface RangedSimSpec {
  kind: 'ranged';
  name: string;
  rarity: RarityTier; // intrinsic tier (design/14); render reads it for the compare-card colour, the sim never does
  fireRateTicks: number; // cooldown between shots, whole ticks
  // Emission (design/03 "orthogonal to ballistic") — pellets per trigger + the cone
  // half-angle each pellet jitters within (0 = pinpoint, single bullet, no PRNG draw).
  bullets: number;
  spreadHalf: Brad;
  bulletSpeed: Fp; // fp displacement per tick
  bulletLifeTicks: number;
  bulletRadius: Fp;
  muzzleOffset: Fp; // spawn distance from actor centre along facing
  bulletZ: Fp; // muzzle height band (design/07 z-gating; cosmetic until then)
  damage: number; // integer
  damageType: DamageType; // physical or an element (on-hit status, design/03/07)
  // Ballistic (design/03/09 Frame axis, ROADMAP 1.1) — the per-tick motion rule;
  // 'straight' reads none of the params below. Frozen onto the Projectile at fire
  // time (WeaponFireSystem), read by ProjectileStepSystem (motion) / HitResolveSystem
  // (beam's damage-over-window).
  ballistic: BallisticId;
  turnRateBrad?: number; // homing: max turn toward the nearest foe, per tick
  blastRadius?: Fp; // lob: AoE radius on landing (lifespan-end detonation)
  returnAfterTicks?: number; // boomerang: tick (since fire) velocity reverses
  beamTicks?: number; // beam: total damage-window length, whole ticks
  beamTickInterval?: number; // beam: ticks between damage applications
  beamRange?: Fp; // beam: max reach along the frozen facing (does not use bulletSpeed)
}

export interface MeleeSimSpec {
  kind: 'melee';
  name: string;
  rarity: RarityTier; // intrinsic tier (design/14); render reads it for the compare-card colour, the sim never does
  swingCooldownTicks: number; // recovery between swings
  damage: number; // integer, per enemy in arc, once per swing
  arcHalf: number; // swing sector half-angle, brad — used for BOTH damage and deflect
  range: Fp; // swing sector radius (reach from actor centre)
  deflect: boolean; // does the swing deflect bullets caught in its arc (design/03/05 parry)
  deflectSpeed: Fp; // fp per tick for a redirected bullet
  damageType: DamageType; // physical or an element (on-hit status, design/03/07)
}

export type WeaponSimSpec = RangedSimSpec | MeleeSimSpec;

// ── Shield-break passive (sim-facing, converted; design/02/07/14) ─────────────
// A character's `shield_break` reaction, fired by combat when its shield empties.
// Tagged data: 'aoe' bursts damage to foes in radius; 'knock' shoves them out. The
// authored (human-unit) form lives in content/skins.ts; this is the fp shape.
export type ShieldBreakSim =
  | { kind: 'aoe'; radius: Fp; damage: number }
  | { kind: 'knock'; radius: Fp; impulse: Fp }; // impulse = fp displacement per tick

/** Per-actor weapon runtime. cooldown counted in whole ticks (design/08). */
export interface WeaponState {
  spec: WeaponSimSpec; // the sim spec systems read
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
  // Two-pool health (design/02/05/07). Damage absorbs shield-first, overflow to hp;
  // an idle shield regens (StatusEffectSystem step 8). maxShield 0 = no shield pool
  // (the current enemies + the 0-shield starter), so the absorb is a no-op and this
  // stays additive for shieldless actors. Characters (0.5) set these from a SkinDef.
  shield: number;
  maxShield: number;
  // Ticks since this actor last took ANY damage (direct hit or DoT), reset to 0 by
  // takeDamage. Gates shield regen: refill only after SHIELD_REGEN_DELAY idle ticks.
  ticksSinceHit: number;
  radius: Fp; // body circle — bullet/melee hit target and sprite size
  // Ground-plane collision footprint (feet), used only for actor↔solid push-out
  // (MovementSystem). Smaller than `radius` so the tall sprite can overlap a solid
  // it stands against — the fake-3D depth trick (design/01/07). Bullets/melee still
  // use `radius`, so being shot still targets the whole visible body.
  footprintRadius: Fp;
  alive: boolean;
  weapon: WeaponState | null;
  firing: boolean; // intent this tick (ApplyInput / AIDecide → WeaponFire)
  // Elemental status runtime (design/03/07). Burn/poison DoT + chill slow live here;
  // StatusEffectSystem is the only mutator after HitResolve applies a hit's status.
  status: StatusState;
  // Per-type damage multiplier (per-mille; missing type = 1000 = normal). Lets an
  // enemy be weak/resistant to an element (design/07). Players carry none.
  resist?: ResistMap;
  // Shield-break reaction (design/02/14): fired by takeDamage when a non-empty shield
  // empties. Set from the character's SkinDef (players); enemies carry none. Kept on
  // the base Actor so the shared takeDamage can read it without narrowing.
  shieldBreak?: ShieldBreakSim;
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
  // Run-scoped buff stack (design/05/14) — the in-run power layer that replaced the
  // deleted `affixes` slot. Player-level, applies to the player + all held weapons,
  // summed-then-clamped (balance/runbuffs.ts), wiped at run end (never carries out).
  // Stores buff ids; magnitude/kind live in the RUN_BUFFS catalogue.
  buffs: RunBuffId[];
}

export interface EnemyActor extends Actor {
  faction: 'enemy';
  // Render-only body tint from the blueprint (design/01); the sim never reads it,
  // like `z`. Lets the view distinguish elemental variants. Undefined = default palette.
  tint?: number;
  // Render-only boss marker (design/01); the sim never reads it. The view draws a
  // health bar so a durable boss's HP ramp-down (poison melt) is legible.
  boss?: boolean;
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
  damageType: DamageType; // frozen from the firing weapon's spec (design/07 payload)
  lifeTicks: number;
  alive: boolean;
  // Ballistic runtime (design/03/09 Frame axis, ROADMAP 1.1). Frozen from the firing
  // spec at fire time (WeaponFireSystem), like damageType above. Undefined/'straight'
  // = the original plain `pos += vel` path — every existing bullet is unaffected.
  ballistic?: BallisticId;
  turnRateBrad?: number; // homing
  speed?: Fp; // homing: magnitude to preserve while turning toward a target
  returnAfterTicks?: number; // boomerang: tick (since fire) velocity reverses
  ticksAlive?: number; // boomerang: ticks elapsed since fire (this system's own counter)
  blastRadius?: Fp; // lob: AoE radius applied once, on landing (lifespan end)
  landed?: boolean; // lob: set by ProjectileStepSystem when lifespan ends; HitResolveSystem
  // (step 7) resolves the AoE blast through the normal resist/status path, then kills it
  beamTicksLeft?: number; // beam: remaining duration ticks (independent of lifeTicks)
  beamTickInterval?: number; // beam: ticks between damage applications
  beamDir?: Brad; // beam: frozen facing at fire time (beam does not move or track the shooter)
  beamRange?: Fp; // beam: max reach along beamDir
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

/**
 * A static rectangular solid — the AABB tile/wall geometry design/07 deferred
 * (ROADMAP 1.2), complementing the round pillars above. `x,y` is the top-left
 * corner; `w,h` the extents. All Fp, converted once at construction/room-placement
 * from human grid units (`content/rooms.ts roomGeometry`). Actor push-out is
 * circle-vs-AABB (MovementSystem); bullets stop/expire on overlap
 * (ProjectileStepSystem) — same treatment as a round pillar, different shape test.
 */
export interface AABB {
  x: Fp;
  y: Fp;
  w: Fp;
  h: Fp;
}

// design/09 vocabulary: heal (flat +1 HP) · material (carry-out currency) · weapon ·
// buff (run-scoped power). Materials are the only carry-out; banking is 1.4/1.5.
export type PickupKind = 'heal' | 'material' | 'weapon' | 'buff';

export interface PickupItem {
  id: number;
  kind: PickupKind;
  gx: Fp;
  gy: Fp;
  spawnTick: number; // tick it was dropped; not collectable until a later tick (design/08 step 8→9)
  alive: boolean;
  // Payload for the powered drops (design/05). Set on the matching kind only:
  weaponId?: string; // kind 'weapon' → id into WEAPON_SPECS
  buffId?: string; // kind 'buff' → id into RUN_BUFFS (design/14)
  materialId?: string; // kind 'material' → id into MATERIAL_DEFS (design/09)
  qty?: number; // kind 'material' → amount dropped
}
