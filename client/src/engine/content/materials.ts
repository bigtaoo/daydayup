/**
 * Materials (design/05/09/14) — the run's ONLY carry-out. Materials come in five
 * elemental kinds matching the five damage types (physical / fire / ice / lightning /
 * poison, design/14), each tiered by depth. They are the sole forge-crafting currency
 * (design/14); there is no separate soft currency.
 *
 * This file fixes the `MaterialDef` shape + the base (tier-0) catalog. Tier-by-depth
 * rolling (`materialTierByDepth`) and banking at extraction rooms are the dungeon /
 * extraction work (ROADMAP 1.4/1.5) — for now a material drop is a distinct, NOT-yet-
 * banked currency: it drops, is collected, and carries its element/tier payload.
 */
import type { DamageType } from './damage';
import { DAMAGE_TYPES } from './damage';

export type MaterialId = string;

export interface MaterialDef {
  id: MaterialId;
  nameKey: string; // i18n KEY only, never display text (design/09)
  element: DamageType; // one of the five kinds (design/14)
  tier: number; // base quality; deeper floors roll higher (design/09 materialTierByDepth, 1.5)
}

/** Base tier-0 material per element (design/14 five elemental kinds). */
export const MATERIAL_DEFS: Record<string, MaterialDef> = Object.fromEntries(
  DAMAGE_TYPES.map((element) => [
    `mat_${element}`,
    { id: `mat_${element}`, nameKey: `material.${element}.name`, element, tier: 0 },
  ]),
);

/** Material ids a drop can roll, fixed order = deterministic (design/06). */
export const MATERIAL_DROP_POOL: readonly MaterialId[] = DAMAGE_TYPES.map((e) => `mat_${e}`);

/**
 * Bank/buffer key for a material of a given ROLLED tier (design/14). The run's material
 * buffers (GameState.floorMaterials / bankedMaterials) and the meta account bank key by
 * this, so a recipe's `minTier` can be enforced — the qty of a `mat_<element>` is no
 * longer a single number but is split by the tier it was rolled at (deeper floors roll
 * higher, ROADMAP 1.5).
 *
 * Tier 0 is written WITHOUT a suffix, so it is byte-identical to the pre-tier flat key
 * `mat_<element>`. Only tier ≥ 1 carries the `#<tier>` tag. This is what keeps the change
 * ADDITIVE: every run that only rolls tier-0 materials (floorIndex 0 — i.e. every config
 * before deep floors existed) produces exactly the old keys, so no replay byte moves and
 * ENGINE_VERSION does not bump (same precedent as the 1.5 material `tier` param itself).
 */
export function bankKey(materialId: MaterialId, tier: number): string {
  return tier > 0 ? `${materialId}#${tier}` : materialId;
}

/** Inverse of bankKey. A key with no `#` (a legacy / tier-0 key) parses as tier 0. */
export function parseBankKey(key: string): { materialId: MaterialId; tier: number } {
  const hash = key.indexOf('#');
  if (hash < 0) return { materialId: key, tier: 0 };
  return { materialId: key.slice(0, hash), tier: Number(key.slice(hash + 1)) || 0 };
}
