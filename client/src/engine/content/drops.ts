/**
 * Drop tables (design/05/09) — what a dead enemy leaves behind, rolled from the
 * injected dropPrng so every client / headless re-judge produces the same drops
 * from seed + input stream (design/06). This is the content that turns kills into
 * the roguelite power ramp: coins (score), health, weapons, and the affix stack
 * that is the run's real power axis (design/05).
 *
 * Plain data + one roll function; no Pixi, no closures (design/09 "content is plain
 * data"). Rarity here = which affix id + which tier value it rolls (design/09
 * "rarity = how many/how strong the rolls"). All weights are integers → weightedIndex
 * is a single deterministic draw. Superseded sim.config.ts SIM.drop from Stage E;
 * changing any weight/pool changes the dropPrng draw sequence → bumps ENGINE_VERSION.
 */
import type { Prng } from '../math/prng';
import type { Affix } from '../balance/affixes';

/** What one enemy death yields. weapon/affix carry the picked payload. */
export type DropResult =
  | { kind: 'coin' }
  | { kind: 'health' }
  | { kind: 'weapon'; weaponId: string }
  | { kind: 'affix'; affix: Affix };

/** How much a health pickup heals (design/05 MVP loop; was SIM.drop.healAmount). */
export const HEALTH_PICKUP_HEAL = 1;

// ── The table ─────────────────────────────────────────────────────────────────
// Frequent coins keep the score ticking; affixes are the satisfying ~1-in-4 power
// hit; weapons are the rare "swap your gun" moment; health keeps a run survivable.
// Tuned for the demo economy (player 6 HP, enemy 3 HP) — first pass, tune vs play.

type DropTableEntry = { kind: DropResult['kind']; weight: number };

export const DROP_TABLE: readonly DropTableEntry[] = [
  { kind: 'coin', weight: 55 },
  { kind: 'affix', weight: 22 },
  { kind: 'health', weight: 18 },
  { kind: 'weapon', weight: 5 },
];

/** Weapon ids a drop can roll (must exist in WEAPON_SPECS). Player-facing only. */
export const WEAPON_DROP_POOL: readonly string[] = ['repeater', 'cannon', 'saber'];

/**
 * Affix roll pool: id + its tier values. A roll picks an id uniformly, then a tier
 * uniformly — so a "dmg" drop is +1 or +2, a "rof" drop +20% or +35%, etc. Ids map
 * to sim fields via AFFIX_FIELD_MAP; values are in that kind's unit (‰ for mult_*).
 */
export const AFFIX_DROP_POOL: readonly { id: string; tiers: readonly number[] }[] = [
  { id: 'dmg', tiers: [1, 2] }, //     +1 / +2 flat damage
  { id: 'rof', tiers: [200, 350] }, // +20% / +35% fire rate
  { id: 'vel', tiers: [250, 500] }, // +25% / +50% bullet speed
  { id: 'reach', tiers: [200, 400] }, // +20% / +40% melee reach
  { id: 'vit', tiers: [1, 2] }, //     +1 / +2 max hp (heals too)
];

/**
 * Roll one drop from the dropPrng (design/05/09). Draw count varies by branch
 * (table → 1, +1 for weapon, +2 for affix) — deterministic given the stream, but
 * it advances the cursor differently than the Stage-E health/coin coin-flip, which
 * is exactly why Stage F bumps ENGINE_VERSION.
 */
export function rollDrop(prng: Prng): DropResult {
  const entry = DROP_TABLE[prng.weightedIndex(DROP_TABLE.map((e) => e.weight))]!;
  switch (entry.kind) {
    case 'weapon':
      return { kind: 'weapon', weaponId: WEAPON_DROP_POOL[prng.nextInt(WEAPON_DROP_POOL.length)]! };
    case 'affix': {
      const pool = AFFIX_DROP_POOL[prng.nextInt(AFFIX_DROP_POOL.length)]!;
      const value = pool.tiers[prng.nextInt(pool.tiers.length)]!;
      return { kind: 'affix', affix: { id: pool.id, value } };
    }
    case 'health':
      return { kind: 'health' };
    default:
      return { kind: 'coin' };
  }
}
