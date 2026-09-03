/**
 * Drop tables (design/05/09) — what a dead enemy leaves behind, rolled from the
 * injected dropPrng so every client / headless re-judge produces the same drops
 * from seed + input stream (design/06). This is the content that turns kills into
 * the roguelite power ramp: materials, health, weapons and run buffs (design/05). (This line
 * said "coins (score)" until 2026-09-03 — the coin kind was replaced by `material` at ROADMAP
 * 0.6's pickup-vocabulary sync, and score comes off kills, not off a drop.)
 *
 * Plain data + one roll function; no Pixi, no closures (design/09 "content is plain
 * data"). All weights are integers → weightedIndex is a single deterministic draw.
 * Superseded sim.config.ts SIM.drop from Stage E; changing any weight/pool changes
 * the dropPrng draw sequence → bumps ENGINE_VERSION.
 */
import type { Prng } from '../math/prng';
import { MATERIAL_DROP_POOL } from './materials';

/** What one enemy death yields (design/09 vocabulary). weapon/buff/material carry payload.
 * `tier` (material only) is the ROLLED instance quality, distinct from the static
 * `MaterialDef.tier` catalog base — see rollDrop's `tier` param (ROADMAP 1.5). */
export type DropResult =
  | { kind: 'material'; materialId: string; qty: number; tier: number }
  | { kind: 'heal' }
  | { kind: 'weapon'; weaponId: string }
  | { kind: 'buff'; buffId: string }
  // PvP-only (design/05/15's squad follow-up) — spent by ReviveSystem to revive a
  // downed squadmate. Never rolled by PvE's `rollDrop`/`DROP_TABLE`.
  | { kind: 'bandage' };

/** How much a heal pickup restores (design/05 MVP loop, flat +1 HP). */
export const HEAL_PICKUP_AMOUNT = 1;

/** Material quantity per drop (design/09; depth-scaled amounts are 1.5 to-come). */
export const MATERIAL_DROP_QTY = 1;

// ── The table ─────────────────────────────────────────────────────────────────
// Frequent coins keep the score ticking; weapons are the rare "swap your gun"
// moment; health keeps a run survivable.
// Tuned for the demo economy (player 6 HP, enemy 3 HP) — first pass, tune vs play.

type DropTableEntry = { kind: DropResult['kind']; weight: number };

export const DROP_TABLE: readonly DropTableEntry[] = [
  { kind: 'material', weight: 55 }, // the run's carry-out currency (design/05/14)
  { kind: 'heal', weight: 18 },
  { kind: 'weapon', weight: 5 },
  { kind: 'buff', weight: 6 }, // run-scoped power buffs (design/14) — the affix replacement
];

/** Weapon ids a drop can roll (must exist in WEAPON_SPECS). Player-facing only. */
export const WEAPON_DROP_POOL: readonly string[] = [
  'repeater',
  'cannon',
  'saber',
  // Elemental drops — the "swap your gun AND your playstyle" moment (design/03/05).
  'flamer',
  'cryobolt',
  'teslagun',
  'venomspit',
  'emberblade',
  'frostbrand',
  'stormglaive',
  // Frame-library drops (design/03 landing order, ROADMAP 1.1) — one per new
  // ballistic/melee frame, physical so the frame's own behavior reads clearly.
  'scattergun',
  'seeker',
  'mortar',
  'lasercutter',
  'tomahawk',
  'hammer',
  'spear',
  // Orbit + radial-emission frames (design/03 tier 4, the last frame-library additions).
  'novaburst',
  'gyre',
  // k_* on-hit procs (design/03/09, ENGINE_VERSION 28 — the first concrete batch).
  'carom',
  'leech',
  // First frame-library elemental siblings (design/03 follow-up) — fire/ice variants
  // of the scattergun/seeker frames, closing a chunk of the "N frames × 5 elements"
  // combinatorial gap that Phase 1.1's physical-only showcase left open.
  'cinderscatter',
  'frostseeker',
];

/** Buff ids a drop can roll (must exist in RUN_BUFFS). Fixed order = deterministic. */
export const BUFF_DROP_POOL: readonly string[] = ['dmg_up', 'rof_up', 'vit_up', 'crit_up'];

/**
 * Roll one drop from the dropPrng (design/05/09). Draw count varies by branch
 * (table → 1, +1 for weapon / buff / material to pick the payload) — deterministic
 * given the stream. `tier` (default 0, ROADMAP 1.5 materialTierByDepth) is the
 * depth signal a material drop rolls at — DeathDropsSystem passes `state.floorIndex`
 * (0 for every config without floors, so the default keeps old callers identical).
 */
export function rollDrop(prng: Prng, tier = 0): DropResult {
  const entry = DROP_TABLE[prng.weightedIndex(DROP_TABLE.map((e) => e.weight))]!;
  switch (entry.kind) {
    case 'weapon':
      return { kind: 'weapon', weaponId: WEAPON_DROP_POOL[prng.nextInt(WEAPON_DROP_POOL.length)]! };
    case 'buff':
      return { kind: 'buff', buffId: BUFF_DROP_POOL[prng.nextInt(BUFF_DROP_POOL.length)]! };
    case 'material':
      return {
        kind: 'material',
        materialId: MATERIAL_DROP_POOL[prng.nextInt(MATERIAL_DROP_POOL.length)]!,
        qty: MATERIAL_DROP_QTY,
        tier,
      };
    default:
      return { kind: 'heal' };
  }
}

// ── PvP arena drop table (design/15, ROADMAP 4.3) ──────────────────────────────
//
// "Same drop MODEL as PvE — weapon/buff/heal — but the arena's own table, zero
// connection to a player's account/materials" (design/15). `material` is
// STRUCTURALLY absent, not just zero-weighted — an arena death can never bank
// toward `state.bankedMaterials` (PvP's fairness wall, same spirit as
// `buildArenaSpecs` taking no meta param). Weights are a first-pass placeholder
// (design/15's loot-marker/DropTable weighting is explicitly still "to design") —
// re-weight freely; this only needs to exercise the mechanism honestly today.

type ArenaDropTableEntry = { kind: Exclude<DropResult['kind'], 'material'>; weight: number };

export const ARENA_DROP_TABLE: readonly ArenaDropTableEntry[] = [
  { kind: 'heal', weight: 35 },
  { kind: 'weapon', weight: 40 },
  { kind: 'buff', weight: 20 },
  // Squad revive currency (design/05/15) — a first-pass weight, same "needs real
  // playtesting" caveat as every other number on this table; not so common a downed
  // teammate is trivially free, not so rare a squad realistically never revives.
  { kind: 'bandage', weight: 5 },
];

/** Roll one drop from the arena's own table (never a `material`) — same dropPrng
 * stream as PvE `rollDrop` (mode-exclusive: a match is never both dungeon and
 * arena, so there's no aliasing to guard against, same reasoning as `roomgenPrng`
 * being reused rather than duplicated per mode). */
export function rollArenaDrop(prng: Prng): DropResult {
  const entry = ARENA_DROP_TABLE[prng.weightedIndex(ARENA_DROP_TABLE.map((e) => e.weight))]!;
  switch (entry.kind) {
    case 'weapon':
      return { kind: 'weapon', weaponId: WEAPON_DROP_POOL[prng.nextInt(WEAPON_DROP_POOL.length)]! };
    case 'buff':
      return { kind: 'buff', buffId: BUFF_DROP_POOL[prng.nextInt(BUFF_DROP_POOL.length)]! };
    case 'bandage':
      return { kind: 'bandage' };
    default:
      return { kind: 'heal' };
  }
}
