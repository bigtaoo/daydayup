/**
 * Weapon blueprints + crafting recipes (design/14 forging). A BLUEPRINT is a permanent
 * account-level unlock — the *right* to make a weapon; a CRAFT spends materials to turn
 * an unlocked blueprint into one instance that enters exactly one run (like every weapon,
 * wiped at run end, design/05). This module fixes the catalog DATA only (design/14 says
 * "blueprints, recipes and character stats are concrete @dd/engine content"); the
 * persistent forge STATE + craft/unlock transactions + material bank live in the meta
 * layer (client/src/meta), which is between-run and NOT part of the deterministic sim.
 *
 * Crafting currency is the five elemental materials (content/materials.ts) — the run's
 * only carry-out (design/05/14), the sole crafting currency (no soft currency). A recipe
 * names element × qty, optionally at a minimum rolled tier. `minTier` IS enforced now: the
 * material bank keys by (element, tier) via `bankKey`, and the meta forge's canAfford/craft
 * only count materials rolled at ≥ the recipe's minTier (deeper floors roll higher tiers,
 * ROADMAP 1.5) — so a premium recipe genuinely demands materials from deeper runs.
 */
import type { DamageType } from './damage';
import { DAMAGE_TYPES } from './damage';
import { WEAPON_SPECS } from './weapons';

/** How blueprints are obtained (design/14). 'drop' = falls from runs (2–3 common,
 * permanent the moment obtained); 'purchase' = RMB store; 'event' = time-limited. */
export type BlueprintSource = 'drop' | 'purchase' | 'event';

/** One material requirement of a recipe: how much of which elemental material. */
export interface MaterialCost {
  element: DamageType;
  qty: number;
  minTier?: number; // design/14. ENFORCED — the module doc above has the mechanism (the bank
  // keys by (element, rolled tier), so only deep-enough materials count). This said "not yet
  // enforced" until 2026-09-03, contradicting that doc eleven lines up.
}

export interface WeaponBlueprint {
  weaponId: string; // key into WEAPON_SPECS — the weapon this blueprint crafts
  // i18n key (design/09 — no display strings in engine data). Currently vestigial: the
  // client displays a blueprint row under the WEAPON's own nameKey (WEAPON_SPECS[weaponId]
  // .nameKey) rather than this one, since weaponId ≡ this record's own key for every
  // entry today — translating this field too would mean authoring the identical string
  // twice per locale. Kept (not removed) so a future blueprint that names a DIFFERENT
  // display name than its underlying weapon (e.g. a themed variant) has somewhere to put it.
  nameKey: string;
  cost: readonly MaterialCost[];
  source: BlueprintSource;
}

/** The craftable-weapon catalog (design/14, first-pass — recipes/costs are to-tune).
 * Costs lean on the weapon's own element so the elemental economy reads intuitively. */
export const BLUEPRINT_CATALOG: Record<string, WeaponBlueprint> = {
  // Common run drops — unlocked early, cheap physical/fire staples.
  repeater: { weaponId: 'repeater', nameKey: 'blueprint.repeater', source: 'drop', cost: [{ element: 'physical', qty: 3 }] },
  flamer: { weaponId: 'flamer', nameKey: 'blueprint.flamer', source: 'drop', cost: [{ element: 'fire', qty: 3 }] },
  // Purchasable / event elemental blueprints.
  cryobolt: { weaponId: 'cryobolt', nameKey: 'blueprint.cryobolt', source: 'purchase', cost: [{ element: 'ice', qty: 3 }] },
  teslagun: { weaponId: 'teslagun', nameKey: 'blueprint.teslagun', source: 'purchase', cost: [{ element: 'lightning', qty: 3 }] },
  venomspit: { weaponId: 'venomspit', nameKey: 'blueprint.venomspit', source: 'purchase', cost: [{ element: 'poison', qty: 3 }] },
  cannon: { weaponId: 'cannon', nameKey: 'blueprint.cannon', source: 'purchase', cost: [{ element: 'physical', qty: 5 }] },
  // Premium recipes gate on rolled tier (design/14): the emberblade demands REFINED fire
  // (tier ≥ 1, from deeper floors) plus raw physical — a reason to descend past floor 0.
  emberblade: { weaponId: 'emberblade', nameKey: 'blueprint.emberblade', source: 'event', cost: [{ element: 'fire', qty: 2, minTier: 1 }, { element: 'physical', qty: 2 }] },

  // ── Frame-library recipes (design/03/14 follow-up) — the Phase 1.1 showcase weapons
  // had zero blueprints, so deep-floor material tiers had almost nothing to gate besides
  // emberblade. Sourced/tiered by the same rarity → source ladder the original catalog
  // already used (common/fine → drop, epic → purchase, legend/legendary → event + minTier).
  scattergun: { weaponId: 'scattergun', nameKey: 'blueprint.scattergun', source: 'drop', cost: [{ element: 'physical', qty: 3 }] },
  hammer: { weaponId: 'hammer', nameKey: 'blueprint.hammer', source: 'drop', cost: [{ element: 'physical', qty: 3 }] },
  spear: { weaponId: 'spear', nameKey: 'blueprint.spear', source: 'drop', cost: [{ element: 'physical', qty: 3 }] },
  seeker: { weaponId: 'seeker', nameKey: 'blueprint.seeker', source: 'purchase', cost: [{ element: 'physical', qty: 4 }] },
  mortar: { weaponId: 'mortar', nameKey: 'blueprint.mortar', source: 'purchase', cost: [{ element: 'physical', qty: 4 }] },
  novaburst: { weaponId: 'novaburst', nameKey: 'blueprint.novaburst', source: 'purchase', cost: [{ element: 'physical', qty: 4 }] },
  carom: { weaponId: 'carom', nameKey: 'blueprint.carom', source: 'purchase', cost: [{ element: 'physical', qty: 4 }] },
  leech: { weaponId: 'leech', nameKey: 'blueprint.leech', source: 'purchase', cost: [{ element: 'physical', qty: 4 }] },
  lasercutter: { weaponId: 'lasercutter', nameKey: 'blueprint.lasercutter', source: 'event', cost: [{ element: 'physical', qty: 3, minTier: 1 }] },
  tomahawk: { weaponId: 'tomahawk', nameKey: 'blueprint.tomahawk', source: 'event', cost: [{ element: 'physical', qty: 3, minTier: 1 }] },
  gyre: { weaponId: 'gyre', nameKey: 'blueprint.gyre', source: 'event', cost: [{ element: 'physical', qty: 3, minTier: 1 }] },

  // ── Remaining elemental melee + the new elemental frame siblings — same
  // REFINED-material gate as emberblade, one tier deeper for the legendary showcase.
  frostbrand: { weaponId: 'frostbrand', nameKey: 'blueprint.frostbrand', source: 'event', cost: [{ element: 'ice', qty: 2, minTier: 1 }, { element: 'physical', qty: 2 }] },
  stormglaive: { weaponId: 'stormglaive', nameKey: 'blueprint.stormglaive', source: 'event', cost: [{ element: 'lightning', qty: 2, minTier: 2 }, { element: 'physical', qty: 2 }] },
  cinderscatter: { weaponId: 'cinderscatter', nameKey: 'blueprint.cinderscatter', source: 'purchase', cost: [{ element: 'fire', qty: 3 }] },
  frostseeker: { weaponId: 'frostseeker', nameKey: 'blueprint.frostseeker', source: 'event', cost: [{ element: 'ice', qty: 2, minTier: 1 }, { element: 'physical', qty: 2 }] },
};

/** Blueprints unlocked from the start (the 'drop' commons, design/14 "2–3 common
 * blueprints drop from runs"). The demo hands these over so the forge has something to
 * craft immediately; a full build would grant them on the actual in-run drop. */
export const STARTER_BLUEPRINTS: readonly string[] = Object.values(BLUEPRINT_CATALOG)
  .filter((b) => b.source === 'drop')
  .map((b) => b.weaponId);

/** Validate the catalog at load (design/09 "fail loud, never at use"): every blueprint
 * must name a real weapon and real elemental materials. Called by the catalog test; also
 * safe to call at boot. Returns the catalog so it can wrap a const initializer. */
export function validateBlueprints(catalog: Record<string, WeaponBlueprint> = BLUEPRINT_CATALOG): void {
  for (const [id, bp] of Object.entries(catalog)) {
    if (!WEAPON_SPECS[bp.weaponId]) throw new Error(`Blueprint '${id}': unknown weaponId '${bp.weaponId}'`);
    for (const c of bp.cost) {
      if (!DAMAGE_TYPES.includes(c.element)) throw new Error(`Blueprint '${id}': unknown material element '${c.element}'`);
      if (c.qty <= 0) throw new Error(`Blueprint '${id}': non-positive cost qty for '${c.element}'`);
      if (c.minTier !== undefined && (c.minTier < 0 || !Number.isInteger(c.minTier)))
        throw new Error(`Blueprint '${id}': minTier must be a non-negative integer for '${c.element}'`);
    }
  }
}
