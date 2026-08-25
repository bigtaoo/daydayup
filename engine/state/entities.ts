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
import type { BallisticId, EmissionPattern } from '../content/ballistics';

export type Faction = 'player' | 'enemy';

/** `takeDamage`'s attacker-identity parameter (design/07) is normally a `Faction` —
 * but zone/hazard-tile damage (design/15, ROADMAP 4.2d) has no attacker on the other
 * side at all (unlike a DoT, whose `src` is always "the opposite faction", 07's
 * existing precedent), so it needs its own literal instead of a fake team. */
export type DamageSrc = Faction | 'environment';

/** Match outcome (design/08). Player ids are indices into state.players. */
export type Winner = number | 'enemies' | null;

// ── Team / hostility model (design/15, ROADMAP 4.2a) ───────────────────────────
// `Faction` says "player-controlled vs AI-controlled" — a rendering/event-label
// axis that never had more than two members and still doesn't. It is NOT the
// same question as "who can I damage": PvE never needed a second axis because
// every player was implicitly one team fighting AI, but PvP needs players
// hostile to OTHER players while staying allied with squadmates. `teamId` is
// that second, independent axis.
//
// `teamId` is deliberately NOT derived from seat `owner` (state/commands.ts) —
// existing co-op defaults every seat to a SHARED team (GameState.buildSeat:
// `seat.teamId ?? 0`), so allies never damage each other, exactly as today. A
// PvP arena build (ROADMAP 4.2c, not yet built) assigns each seat its own
// distinct teamId instead; a future squad build assigns the same teamId to
// several seats. Neither needs another schema change — only what a config
// passes in.

/** Anything carrying a team identity — every `Actor` and every `Projectile`
 * (frozen from its owner at fire time, WeaponFireSystem). */
export type Teamed = { teamId: number };

/** Reserved teamId for every enemy (AI never picks a config-supplied team) —
 * guaranteed to never equal a player's teamId (always >= 0), so AI is hostile
 * to every player team by construction and never hostile to other AI. */
export const ENEMY_TEAM_ID = -1;

/**
 * The single predicate that replaces every `faction === 'player' ? enemies :
 * players`-shaped ternary in combat/targeting code (HitResolveSystem,
 * DeflectSystem, ProjectileStepSystem, combat.ts — design/15 called these out
 * by name). Two actors/projectiles are hostile iff their teams differ; same
 * team (squadmates, or two AI) never damage/target each other.
 */
export function isHostile(a: Teamed, b: Teamed): boolean {
  return a.teamId !== b.teamId;
}

// ── Weapon specs (sim-facing, already converted to ticks / Fp / Brad) ─────────

export interface RangedSimSpec {
  kind: 'ranged';
  name: string; // render/asset id (weaponSkins.ts texture key) — NOT display text
  nameKey: string; // i18n KEY for the player-facing name (design/09); client resolves via tName()
  rarity: RarityTier; // intrinsic tier (design/14); render reads it for the compare-card colour, the sim never does
  fireRateTicks: number; // cooldown between shots, whole ticks
  // Emission (design/03 "orthogonal to ballistic") — pellets per trigger + the cone
  // half-angle each pellet jitters within (0 = pinpoint, single bullet, no PRNG draw).
  // `pattern` picks the LAYOUT: 'spread' = the jittered cone (default, baseline weapons);
  // 'radial' = an even PRNG-free ring (WeaponFireSystem). See content/ballistics.ts.
  bullets: number;
  spreadHalf: Brad;
  pattern: EmissionPattern;
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
  orbitRadius?: Fp; // orbit: circling distance from the owner's centre
  orbitAngularVelBrad?: number; // orbit: brad the angle advances per tick (revolution speed)
  // Authored on WeaponSpec since Stage C but never converted/read until now (ENGINE_VERSION
  // 28 — found while wiring ricochet, the exact same "bullet fate after a hit" branch
  // point): design/07 "continues and may hit further actors" instead of expiring on
  // its first hit. Omitted/false = every existing weapon's behavior, unchanged.
  piercing?: boolean;
  // k_* on-hit procs (design/03/09, ENGINE_VERSION 28 — the first concrete batch;
  // "never specified beyond a placeholder id prefix" until now). Both omitted =
  // every existing weapon, byte-identical. Frozen onto the Projectile at fire time,
  // like damageType above — HitResolveSystem reads them from there, never the spec.
  lifestealPermille?: number; // heal the FIRING player by this ‰ of damage dealt on hit
  ricochetCount?: number; // bullet retargets to the nearest OTHER hostile instead of expiring, this many times
}

export interface MeleeSimSpec {
  kind: 'melee';
  name: string; // render/asset id (weaponSkins.ts texture key) — NOT display text
  nameKey: string; // i18n KEY for the player-facing name (design/09); client resolves via tName()
  rarity: RarityTier; // intrinsic tier (design/14); render reads it for the compare-card colour, the sim never does
  swingCooldownTicks: number; // recovery between swings
  damage: number; // integer, per enemy in arc, once per swing
  arcHalf: number; // swing sector half-angle, brad — used for BOTH damage and deflect
  range: Fp; // swing sector radius (reach from actor centre)
  deflect: boolean; // does the swing deflect bullets caught in its arc (design/03/05 parry)
  deflectSpeed: Fp; // fp per tick for a redirected bullet
  damageType: DamageType; // physical or an element (on-hit status, design/03/07)
  // Impulse magnitude (fp/tick, converted from the authored grid/s — design/07 "lands
  // once z/knockback lands"): HitResolveSystem's meleeArc adds this outward, along the
  // attacker→target direction, into the target's knockVx/knockVy on every connecting hit.
  knockback: Fp;
  // k_* on-hit proc (design/03/09, ENGINE_VERSION 28) — see RangedSimSpec's matching
  // field. Melee has no ricochet (it doesn't travel), only lifesteal.
  lifestealPermille?: number;
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
  // Team identity for combat targeting (design/15, ROADMAP 4.2a) — see the note
  // above. Independent of `faction`: two PlayerActors can be mutually hostile
  // (different teamId) while remaining the same `faction` ('player').
  teamId: number;
  gx: Fp;
  gy: Fp;
  z: Fp; // ground height — always 0 for actors (jump removed); a render offset only
  vx: Fp;
  vy: Fp;
  // Knockback velocity (design/07 "persistent-knockback friction"), kept SEPARATE from
  // vx/vy: a player's vx/vy is fully overwritten every tick from input (ApplyInputSystem)
  // and an enemy's is never set by AI at all, so a shove written into vx/vy would either
  // be erased before Movement ever integrates it (player) or drift forever with no decay
  // (enemy, nothing else touches its vx/vy). knockVx/knockVy is an independent external-
  // force channel: MovementSystem adds it into this tick's displacement alongside vx/vy,
  // then decays it by a fixed friction factor every tick (never touched by chill slow —
  // that's a movement-speed modifier, not a force). Zero for an actor that has never been
  // knocked; starts and ends every knock at (0,0).
  knockVx: Fp;
  knockVy: Fp;
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
  // Ground-plane collision footprint (feet), used for actor↔ACTOR push-out
  // (MovementSystem). Smaller than `radius` so two bodies may visually overlap
  // where their feet don't — the fake-3D depth trick (design/01/07). Bullets/melee
  // still use `radius`, so being shot still targets the whole visible body.
  footprintRadius: Fp;
  // Ground-plane radius used against STATIC solids only — walls and pillars
  // (MovementSystem.resolveWalls/resolveObstacles). Separate from `footprintRadius`
  // because the two overlaps read differently on screen: a body overlapping another
  // body is a crowd, while a body overlapping a wall is a body sunk INTO the wall.
  // See PLAYER_BASE.solidRadius (content/players.ts) for the full account.
  solidRadius: Fp;
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
  // Arena room-membership cache (design/15, ROADMAP 4.2d) — which ArenaRoom (by id)
  // this actor's position currently falls inside; maintained by EnvironmentSystem,
  // which re-checks it only when the actor leaves its cached room's rect (amortized
  // O(1), not a full room scan every tick). Always undefined outside arena mode.
  // Also undefined while standing in a doorway gap no room's rect covers — treated
  // as "not confirmed safe" by the zone check, never as automatically safe.
  roomId?: string;
}

export interface PlayerActor extends Actor {
  faction: 'player';
  // Render-only character atlas ref (design/02/12/13), set once at spawn from the
  // resolved SkinDef.atlasKey (content/skins.ts) — the sim never reads it, like
  // EnemyActor's `tint`. Lets the view pick which of the 3-character roster's rig
  // skins to draw. Undefined = the Graphics placeholder (or resolveSkin's default).
  atlasKey?: string;
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
  // This tick's INTERACT hold state (mirrors `firing`'s FIRE mirror), set by
  // ApplyInputSystem. Read by ReviveSystem (sustained channel) — no longer by
  // PickupSystem (weapon collection is click-driven now, see `pickupTargetId` below)
  // or ExtractionSystem, see below.
  interacting: boolean;
  // This tick's portal-popup choice (mirrors `firing`, set by ApplyInputSystem from
  // Button.CONFIRM_EXTRACT/CONFIRM_DESCEND). Already a one-tick pulse by construction
  // (CommandBuilder latches then clears the bit, same as SWAP_WEAPON), so
  // ExtractionSystem (design/05, ROADMAP 1.4) reads these directly — no edge detection
  // needed, unlike INTERACT's continuous hold.
  confirmExtract: boolean;
  confirmDescend: boolean;
  // The PickupItem.id this tick's command asked to collect (design/03, ENGINE_VERSION
  // 32 — replaces the old "tap INTERACT while overlapping" ground-weapon gesture with
  // an explicit click on a HUD panel row). 0 = none. Set by ApplyInputSystem straight
  // from PlayerCommand.pickupTargetId — already a one-tick pulse (CommandBuilder
  // latches then clears it, same convention as confirmExtract/confirmDescend above),
  // so PickupSystem reads it directly with no edge detection of its own.
  pickupTargetId: number;
  // Co-op downed/revive (design/05/07, ROADMAP 3.2). A lethal hit sends a player
  // `downed` (frozen, 0 HP, `alive` stays true) instead of dead; a teammate revives
  // it via a sustained INTERACT channel. `alive` becomes false only on a permanent
  // death (bleedout expiry). "Up" = `alive && !downed` (see isDowned / WinCondition).
  downed: boolean;
  bleedoutTicks: number; // counts down while downed & not being revived; 0 → dead
  reviveProgressTicks: number; // channel progress (0..REVIVE_CHANNEL_TICKS); resets if interrupted
  // PvP squad revive (design/05/15's squad follow-up) — reviving a downed SQUADMATE
  // (never a rival, see ReviveSystem's teamId check) consumes one of these, unlike
  // PvE's free channel. Picked up from the arena's `{kind:'bandage'}` drop (PvP-only,
  // content/drops.ts). Always 0 in PvE — nothing grants or reads it there.
  bandages: number;
}

/** A player who is downed (incapacitated, revivable) — not a valid target and cannot act.
 * Safe on any Actor: enemies never carry the field, so it reads false for them. */
export function isDowned(a: Actor): boolean {
  return (a as PlayerActor).downed === true;
}

export interface EnemyActor extends Actor {
  faction: 'enemy';
  // Render-only body tint from the blueprint (design/01); the sim never reads it,
  // like `z`. Lets the view distinguish elemental variants. Undefined = default palette.
  tint?: number;
  // Which of design/13's five elements this variant IS — render-only, copied from the
  // blueprint like `tint`; the sim never reads it. The COLOUR half of that doc's locked
  // dual-channel element law is `tint` right above; this is what lets the view draw the
  // ICON half (`game/elementIcons.ts`). Undefined = not one of the four locked elemental
  // variants, and the view draws no badge at all.
  element?: DamageType;
  // Render-only body rig atlas key (design/13 "roster variety beyond the base body"),
  // copied from the blueprint like `tint`/`boss`; the sim never reads it. Undefined =
  // the shared 'critter-core' body (Actor.ts's existing fallback).
  bodyRig?: string;
  // Render-only boss marker (design/01); the sim never reads it. The view draws a
  // health bar so a durable boss's HP ramp-down (poison melt) is legible.
  boss?: boolean;
  // Boss AI depth (design/09 aspirational `traits`, ENGINE_VERSION 27). Config, copied
  // from the blueprint at spawn (SpawnSystem/DeathDropsSystem, same convention as
  // tint/boss/resist above); undefined = no enrage trait. `enraged` is the RUNTIME
  // flag WeaponFireSystem sets the tick hp first crosses the threshold — one-way,
  // never clears (enemies have no self-heal today), required (not optional) on every
  // enemy so the field always has a stable false default.
  enrage?: EnrageSim;
  enraged: boolean;
  // Boss AI depth (design/09 aspirational `onDeathSpawn`). Config, copied from the
  // blueprint at spawn; DeathDropsSystem reads it the tick this enemy dies to spawn
  // `count` minions of `type` around its death position. undefined = no adds.
  onDeathSpawn?: { type: string; count: number };
  // Movement AI (design/09, ENGINE_VERSION 37 — enemies used to stand rooted at spawn,
  // only ever turning to fire; see AIDecideSystem's module doc). Copied from the
  // blueprint at spawn like tint/resist above; undefined (any hand-built EnemyActor
  // that bypasses `buildEnemyActor`, e.g. most unit tests) falls back to
  // AIDecideSystem's own default constants, same convention as `resist` defaulting
  // to a neutral multiplier.
  moveSpeedPerTick?: Fp; // fp displacement per tick while closing distance to its target
  engageRangeFp?: Fp; // stop closing once within this fp distance of the target
  // Perception radius (ENGINE_VERSION 42): how close the target has to get before this
  // mob reacts AT ALL. Room activation (design/05's room-as-the-aggro-unit) is still the
  // outer gate — this is the inner one, so an activated room's far side stays idle until
  // the player actually comes near instead of the whole garrison marching at once.
  // Undefined falls back to DEFAULT_ENEMY_AGGRO_RANGE_FP, same convention as the two above.
  aggroRangeFp?: Fp;
  // Latched the tick the target first enters `aggroRangeFp` — one-way, like `enraged`.
  // Without the latch a mob sitting exactly at the boundary would flip between chasing
  // and idling every tick as its own movement carried it back and forth across it.
  // Required (not optional) so the field always has a stable false default.
  aggroed: boolean;
}

/** A boss's enrage trait (design/09 `traits`, ENGINE_VERSION 27): below `hpThresholdPermille`
 * of maxHp (‰, e.g. 300 = 30%), the bonuses below apply — same per-mille "bonus amount"
 * shape as a RunBuffDef's `value` (composed through the identical BuffSums/buffedDamage/
 * buffedCooldown machinery in WeaponFireSystem, not a separate damage-scaling path). */
export interface EnrageSim {
  hpThresholdPermille: number;
  bonusDamagePermille: number;
  bonusFireratePermille: number;
}

// ── Projectiles / pickups ──────────────────────────────────────────────────────

export interface Projectile {
  id: number;
  faction: Faction;
  // Frozen from the firing actor at spawn (WeaponFireSystem), like `faction`
  // above — design/15's targeting predicate reads this, not faction, to decide
  // what a bullet can hit. Deflect (DeflectSystem) reassigns it to the
  // deflector's own team, same as it already reassigns `faction`.
  teamId: number;
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
  // orbit: unlike every ballistic above, this one TRACKS its owner — position is set from
  // the owner's live centre each tick, so the bullet needs to find that actor by id.
  // ALSO used by k_lifesteal below (ENGINE_VERSION 28) — WeaponFireSystem now sets this
  // on EVERY bullet, not just orbit's, so HitResolveSystem can find who to heal; every
  // other read site still only branches on `ballistic === 'orbit'`, never on ownerId's
  // mere presence, so this is additive (no behavior change for any non-orbit ballistic).
  ownerId?: number; // orbit: the actor this bullet circles (dies if the owner is gone)
  orbitRadius?: Fp; // orbit: circling distance from the owner
  orbitAngleBrad?: Brad; // orbit: current angle around the owner (advances each tick)
  orbitAngularVelBrad?: number; // orbit: brad the angle advances per tick
  // Frozen from RangedSimSpec.piercing (ENGINE_VERSION 28) — see that field's doc
  // comment. Undefined/false = every existing bullet's behavior, unchanged.
  piercing?: boolean;
  // k_* on-hit procs (design/03/09, ENGINE_VERSION 28), frozen from the firing spec at
  // fire time like damageType. lifestealPermille heals `ownerId`'s player on this
  // bullet's next hit; ricochetsLeft counts down each successful retarget (HitResolveSystem).
  lifestealPermille?: number;
  ricochetsLeft?: number;
  // A piercing bullet stays alive after a hit (design/07) instead of expiring — this
  // is its own cross-tick memory of who it's already hit, so a slow pierce shot that's
  // still overlapping a body it just hit doesn't hit it again every subsequent tick
  // (mirrors why a melee swing tracks "hit ids on the swing", same root cause).
  hitIds?: number[];
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
// 'crate' is arena-only (design/15): an unresolved lootMarker spawn — no payload
// fields set — that PickupSystem rolls into a real kind once a player is within
// SIM.lootRevealRadius. Keeps the roll (and its weaponId) out of shared GameState
// until a player could plausibly see it, so a map-wide state-reading/free-camera
// cheat can't read every floor's loot identity from across the whole arena.
export type PickupKind = 'heal' | 'material' | 'weapon' | 'buff' | 'crate' | 'bandage';

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
  // kind 'material' → the ROLLED instance tier (design/09 materialTierByDepth,
  // ROADMAP 1.5), distinct from MaterialDef.tier (the catalog's static base — always
  // 0, since there's one id per element regardless of depth). Rises with dungeon
  // depth (DeathDropsSystem passes state.floorIndex as the depth signal); always 0
  // for a config without floors (identical to no field at all).
  tier?: number;
}
