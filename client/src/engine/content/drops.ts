/**
 * Drop tables (design/05/09) — what a dead enemy leaves behind, rolled from the
 * injected dropPrng so every client / headless re-judge produces the same drops
 * from seed + input stream (design/06). This is the content that turns kills into
 * the roguelite power ramp: coins (score), health, and weapons (design/05).
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
  | { kind: 'buff'; buffId: string };

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
];

/** Buff ids a drop can roll (must exist in RUN_BUFFS). Fixed order = deterministic. */
export const BUFF_DROP_POOL: readonly string[] = ['dmg_up', 'rof_up', 'vit_up'];

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
