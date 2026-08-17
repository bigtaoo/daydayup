/**
 * Enemy blueprints (design/09 actor content). The basic mob plus a set of elemental
 * variants that carry a resist/weakness profile, so damage types matter tactically:
 * match the enemy's weakness to melt it, hit its resistance and it shrugs the hit
 * toward the min-1 floor (design/07). SpawnSystem reads a blueprint by `type` (the
 * optional third field of a wave spawn entry; missing = 'basic').
 *
 * HP / footprint / radius / loadout are in human/px units re-anchored to grid via
 * pxToFp (÷32); the weapon is the shared enemy-gun sim spec (content/weapons.ts).
 * `resist` and `tint` are the variant knobs — `resist` is read by the sim (per-type
 * multiplier), `tint` is render-only (Scene colours the body by it; the sim never
 * reads it, like Actor.z). Adding a new variant here + a new `type` id in a wave is
 * a forward-compatible content add (design/09) — no ENGINE_VERSION bump.
 */
import { toFp, type Fp } from '../math/fixed';
import { ENEMY_TEAM_ID, type EnemyActor, type EnrageSim, type RangedSimSpec } from '../state/entities';
import type { GameState } from '../state/GameState';
import type { ResistMap } from './damage';
import { freshStatus } from './damage';
import { pxToFp } from './convert';
import { ENEMY_GUN_SIM, makeWeapon } from './weapons';
import { curveAt } from '../world/dungeon';

export interface EnemyBlueprint {
  type: string; // registry key + the id a wave spawn entry references
  maxHp: number;
  radius: Fp;
  footprintRadius: Fp; // feet circle for solid push-out (< radius); see Actor.footprintRadius
  weapon: RangedSimSpec;
  // Per-type damage multiplier (per-mille; 1000 = normal, 2000 = weak/×2, 500 = resist/×½).
  // Missing type = neutral. The knob that makes damage types matter per mob (design/07).
  resist?: ResistMap;
  tint?: number; // render-only body colour (design/01); the sim never reads it
  // Render-only body rig atlas key (design/13 "roster variety beyond the base body: a
  // heavy brute, a floating ranged form") — like `tint`, the sim never reads it.
  // Undefined = the shared 'critter-core' body (Actor.ts's existing default).
  bodyRig?: string;
  boss?: boolean; // render-only (like tint): the view draws a health bar for a boss
  // Boss AI depth (design/09 aspirational `traits`/`onDeathSpawn`, ENGINE_VERSION 27).
  // See EnemyActor's matching fields for the full account; undefined = neither trait.
  enrage?: EnrageSim;
  onDeathSpawn?: { type: string; count: number };
  // Movement AI (ENGINE_VERSION 37, see EnemyActor's matching fields) — per-type
  // override; undefined = the shared DEFAULT_ENEMY_* constant below. No blueprint
  // sets these yet (first-pass numbers, tune per mob once there's real playtesting);
  // the knob exists so a future rush/melee variant can go faster with a near-zero
  // range, or a sniper variant can hang back at a much longer one.
  moveSpeedPerTick?: Fp;
  engageRangeFp?: Fp;
  // Perception radius (ENGINE_VERSION 42) — how close the player has to get before this
  // mob reacts at all. Undefined = DEFAULT_ENEMY_AGGRO_RANGE_FP below.
  aggroRangeFp?: Fp;
}

// ── Movement AI defaults (ENGINE_VERSION 37) ─────────────────────────────────────
// Every enemy used to be rooted at its spawn point (AIDecideSystem's old header:
// "Enemies are stationary in the slice") — it faced and shot at the nearest player
// but never closed distance, which read as "the AI doesn't move" (exactly the
// reported bug). These are first-pass numbers: slower than the player so committing
// to running away always opens the gap, and a stop-distance short enough that a mob
// actually has to cross most of a room's width to reach it (design/09's authored
// room sizes run ~12-24 grid / 384-768px — deriving the range from the gun's own
// max travel (bulletSpeed × lifespan, ~30 grid for ENEMY_GUN_SIM) would put the
// mob's standoff distance beyond most rooms' diagonal, so it would rarely be
// observed moving at all).
// Exported so AIDecideSystem can fall back to the SAME numbers for a hand-built
// EnemyActor that bypasses this factory (most unit tests) — one source of truth,
// not two constants that could drift apart.
// Retuned 2026-08-17 (ENGINE_VERSION 42, live play report: "怪物的感知范围弄小一些，移动
// 速度调低"). Was 4 px/tick, i.e. ~63% of the player's — close enough that a garrison that
// had noticed you stayed glued to you, and backing off never actually opened a gap the way
// the v37 note claimed it would (the player also has to aim and dodge, so the effective
// gap-opening rate is far below the raw speed ratio). 2.6 px/tick ≈ 78 px/s is ~41% of
// PLAYER_BASE.speedPerTick: retreating now visibly outruns them, and a mob crossing a room
// to reach you reads as a threat approaching rather than a rush.
export const DEFAULT_ENEMY_MOVE_SPEED_PER_TICK = pxToFp(2.6); // ≈78 px/s, ~41% of PLAYER_BASE.speedPerTick
export const DEFAULT_ENEMY_ENGAGE_RANGE_FP = pxToFp(180); // ~5.6 grid — stop and shoot once this close
// Perception radius (ENGINE_VERSION 42): the INNER aggro gate, inside design/05's
// room-as-the-aggro-unit outer one. Room activation still wakes the room; this decides
// which of its mobs have actually noticed you. 320 px = 10 grid, wider than
// DEFAULT_ENEMY_ENGAGE_RANGE_FP (so a mob that notices you still has ~4 grid to close
// before it may shoot — the reaction window is preserved) but well under the 12-24 grid
// span of level 1's authored rooms (`world/dungeons/ember/`), so walking into a room no
// longer sets its whole garrison marching at you at once. Latched via `EnemyActor.aggroed`
// — once a mob has noticed you it stays awake, so this is a wake-up trigger, not a leash.
export const DEFAULT_ENEMY_AGGRO_RANGE_FP = pxToFp(320); // 10 grid

// ── Basic (neutral) ─────────────────────────────────────────────────────────────
export const BASIC_ENEMY: EnemyBlueprint = {
  type: 'basic',
  maxHp: 3,
  radius: pxToFp(15), // demo 15px
  footprintRadius: pxToFp(7),
  weapon: ENEMY_GUN_SIM,
  // Neutral to every type; status effects still apply. tint omitted → default palette.
};

// ── Elemental variants ──────────────────────────────────────────────────────────
// Each resists its own element (shrug it off) and is weak to a counter, so all four
// elemental weapons have a target they excel against. Slightly higher HP than basic
// so the resist/weakness actually reads before the mob dies. First-pass numbers.

/** Fire mob: shrugs off fire, melts to ice. */
export const EMBERLING: EnemyBlueprint = {
  type: 'emberling',
  maxHp: 4,
  radius: pxToFp(15),
  footprintRadius: pxToFp(7),
  weapon: ENEMY_GUN_SIM,
  resist: { fire: 400, ice: 1800 }, // ×0.4 fire, ×1.8 ice
  tint: 0xff7043, // ember orange
};

/** Ice mob: shrugs off ice, melts to fire. */
export const FROSTLING: EnemyBlueprint = {
  type: 'frostling',
  maxHp: 4,
  radius: pxToFp(15),
  footprintRadius: pxToFp(7),
  weapon: ENEMY_GUN_SIM,
  resist: { ice: 400, fire: 1800 },
  tint: 0x81d4fa, // frost blue — matches design/13's locked ice element hue (ELEMENT_COLORS.ice)
};

/** Charged mob: shrugs off lightning, rots to poison. */
export const GALVANIST: EnemyBlueprint = {
  type: 'galvanist',
  maxHp: 4,
  radius: pxToFp(15),
  footprintRadius: pxToFp(7),
  weapon: ENEMY_GUN_SIM,
  resist: { lightning: 400, poison: 1800 },
  tint: 0xfff176, // charged yellow — matches design/13's locked lightning element hue (ELEMENT_COLORS.lightning)
};

/** Armoured mob: shrugs off bullets (physical) and fire, but conducts lightning.
 *  Tougher — the "bring the right tool" wall. */
export const IRONCLAD: EnemyBlueprint = {
  type: 'ironclad',
  maxHp: 6,
  radius: pxToFp(17),
  footprintRadius: pxToFp(8),
  weapon: ENEMY_GUN_SIM,
  resist: { physical: 500, fire: 700, lightning: 1900 }, // armour vs bullets/fire, weak to shock
  tint: 0x90a4ae, // steel grey
};

// ── Body-form variety (design/13 "roster variety beyond the base body") ──────────
// Both reuse the generic enemy AI/gun (no ranged/melee AI split exists yet, same as
// every variant above) — the differentiation here is silhouette + stats, not
// behavior, exactly like the elemental re-tints. `bodyRig` picks the distinct art
// (render/skinRegistry.ts's 'brute-core'/'floater-core', sharing critter-core's rig);
// `tint` is design/13's locked neutral/physical hex so it doesn't get discoloured by
// the enemy body's own default red tint (Actor.ts's `resolvedTint = tint ?? body`).

/** Heavy bruiser: armoured, tankier than ironclad's wall-of-bullets read but no
 *  elemental weakness/resist pair — a flat physical damage reduction instead. */
export const BRUTE: EnemyBlueprint = {
  type: 'brute',
  maxHp: 7,
  radius: pxToFp(20),
  footprintRadius: pxToFp(9),
  weapon: ENEMY_GUN_SIM,
  resist: { physical: 700 }, // ×0.7 bullets — armoured, not immune
  tint: 0xe2e8f0, // design/13's locked neutral/physical hex
  bodyRig: 'brute-core',
};

/** Fragile floating form: lower HP than basic, no resist — the "glass" read to pair
 *  with the brute's "tank" read. Movement/targeting AI is the same shared chase-and-
 *  shoot as every other mob (no distinct kiting behavior exists yet). */
export const FLOATER: EnemyBlueprint = {
  type: 'floater',
  maxHp: 2,
  radius: pxToFp(13),
  footprintRadius: pxToFp(6),
  weapon: ENEMY_GUN_SIM,
  tint: 0xe2e8f0,
  bodyRig: 'floater-core',
};

// ── Boss ────────────────────────────────────────────────────────────────────────
// The durable finale — a big, tanky mob that survives long enough to *show* the
// combat systems working (design/03/07): its huge HP pool lets poison stacks ramp
// to full and lingering burn/chill/poison auras persist visibly, while its broad
// resist profile forces the player to find the right damage type. It shrugs bullets
// (physical, floored to min-1) and partially resists fire/ice/lightning, but is
// doubly WEAK to poison — so the intended kill is to stack venom and let the DoT
// melt it, the clearest showcase of independent poison stacks on a target that
// doesn't die first. Neutral-ish elements still land, so their auras read too.
export const BLIGHTLORD: EnemyBlueprint = {
  type: 'blightlord',
  maxHp: 40, // ~a dozen full-poison DoT ticks; bullets alone take forever (min-1)
  radius: pxToFp(30), // twice a basic mob — reads as a boss; auras/bar scale with it
  footprintRadius: pxToFp(14),
  weapon: ENEMY_GUN_SIM,
  resist: { physical: 400, fire: 800, ice: 800, lightning: 800, poison: 2000 },
  tint: 0x8e24aa, // toxic purple
  boss: true,
  bodyRig: 'boss-core', // design/13's "giant failed core" — its own rig, not a scaled critter-core
  // Boss AI depth (design/09 aspirational `traits`/`onDeathSpawn`, ENGINE_VERSION 27,
  // first-pass numbers — tune against real play like every other constant here).
  // Below 30% HP (the "poison is really biting now" moment): +50% damage, +50% fire
  // rate — a real, felt escalation rather than a slow HP-bar melt with no counterplay
  // change. On death, two basic adds spawn around its body — the fight doesn't just
  // end the instant the bar hits 0.
  enrage: { hpThresholdPermille: 300, bonusDamagePermille: 500, bonusFireratePermille: 500 },
  onDeathSpawn: { type: 'basic', count: 2 },
};

/** Blueprint registry, keyed by `type` (design/09 "content is plain data keyed by
 *  type"). SpawnSystem resolves a wave entry's type through this; unknown → basic. */
export const ENEMY_BLUEPRINTS: Record<string, EnemyBlueprint> = {
  basic: BASIC_ENEMY,
  emberling: EMBERLING,
  frostling: FROSTLING,
  galvanist: GALVANIST,
  ironclad: IRONCLAD,
  brute: BRUTE,
  floater: FLOATER,
  blightlord: BLIGHTLORD,
};

/**
 * The single EnemyActor factory (design/09 "content is plain data"; ENGINE_VERSION
 * 27's own reason to exist — a spawned onDeathSpawn minion needs EXACTLY the same
 * construction as a wave spawn, and hand-duplicating the full Actor field list a
 * second time is exactly how knockVx/knockVy got missed from a couple of test
 * fixtures earlier in this same version's own work). Shared by SpawnSystem (wave/
 * dungeon/arena spawns) and DeathDropsSystem (a dying boss's onDeathSpawn adds).
 * Resolves the blueprint by `type` (missing/unknown → basic, forward-compat); the
 * aiPrng draw stays one-per-spawn regardless of variant or caller, so fire-phase
 * jitter is unaffected by which system spawned the mob.
 */
export function buildEnemyActor(state: GameState, gx: Fp, gy: Fp, type?: string): EnemyActor {
  const bp = ENEMY_BLUEPRINTS[type ?? 'basic'] ?? BASIC_ENEMY;
  const weapon = makeWeapon(bp.weapon);
  weapon.cooldownTicks = state.aiPrng.nextInt(bp.weapon.fireRateTicks); // fire-phase jitter
  // Floor-to-floor difficulty escalation (design/05's own "to design" item — how enemy
  // tier scales with depth). `DungeonConfig.difficultyCurve` was authored on EMBER_DUNGEON
  // back at ROADMAP 1.3 but nothing ever read it — this is that wiring. Only maxHp scales
  // (weapon damage stays flat): deeper floors read as tougher, not as sudden one-shots.
  // floorIndex 0 always resolves to `curve.base` (EMBER_DUNGEON: 1) and every non-dungeon
  // config has no `dungeonConfig` at all (scale 1), so this is byte-identical to before
  // for a fresh dungeon's floor 0 and for every PvE/PvP config without floors.
  const scale = state.dungeonConfig ? curveAt(state.dungeonConfig.difficultyCurve, state.floorIndex) : 1;
  const maxHp = Math.max(1, Math.round(bp.maxHp * scale));
  return {
    id: state.nextId(),
    faction: 'enemy',
    teamId: ENEMY_TEAM_ID, // hostile to every player team (design/15), never to other AI
    gx,
    gy,
    z: toFp(0),
    vx: toFp(0),
    vy: toFp(0),
    knockVx: toFp(0),
    knockVy: toFp(0),
    facing: 0 as EnemyActor['facing'],
    hp: maxHp,
    maxHp,
    shield: 0, // enemies have no shield pool (design/07 — shields are a character trait)
    maxShield: 0,
    ticksSinceHit: 0,
    radius: bp.radius,
    footprintRadius: bp.footprintRadius,
    alive: true,
    weapon,
    firing: false,
    status: freshStatus(),
    resist: bp.resist,
    tint: bp.tint,
    bodyRig: bp.bodyRig,
    boss: bp.boss,
    enrage: bp.enrage,
    enraged: false,
    aggroed: false,
    onDeathSpawn: bp.onDeathSpawn,
    moveSpeedPerTick: bp.moveSpeedPerTick ?? DEFAULT_ENEMY_MOVE_SPEED_PER_TICK,
    engageRangeFp: bp.engageRangeFp ?? DEFAULT_ENEMY_ENGAGE_RANGE_FP,
    aggroRangeFp: bp.aggroRangeFp ?? DEFAULT_ENEMY_AGGRO_RANGE_FP,
  };
}
