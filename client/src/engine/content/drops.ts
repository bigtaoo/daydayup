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

/** What one enemy death yields. weapon carries the picked payload. */
export type DropResult =
  | { kind: 'coin' }
  | { kind: 'health' }
  | { kind: 'weapon'; weaponId: string };

/** How much a health pickup heals (design/05 MVP loop; was SIM.drop.healAmount). */
export const HEALTH_PICKUP_HEAL = 1;

// ── The table ─────────────────────────────────────────────────────────────────
// Frequent coins keep the score ticking; weapons are the rare "swap your gun"
// moment; health keeps a run survivable.
// Tuned for the demo economy (player 6 HP, enemy 3 HP) — first pass, tune vs play.

type DropTableEntry = { kind: DropResult['kind']; weight: number };

export const DROP_TABLE: readonly DropTableEntry[] = [
  { kind: 'coin', weight: 55 },
  { kind: 'health', weight: 18 },
  { kind: 'weapon', weight: 5 },
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
];

/**
 * Roll one drop from the dropPrng (design/05/09). Draw count varies by branch
 * (table → 1, +1 for weapon) — deterministic given the stream.
 */
export function rollDrop(prng: Prng): DropResult {
  const entry = DROP_TABLE[prng.weightedIndex(DROP_TABLE.map((e) => e.weight))]!;
  switch (entry.kind) {
    case 'weapon':
      return { kind: 'weapon', weaponId: WEAPON_DROP_POOL[prng.nextInt(WEAPON_DROP_POOL.length)]! };
    case 'health':
      return { kind: 'health' };
    default:
      return { kind: 'coin' };
  }
}
