/**
 * Forge transactions (design/14) — pure functions over MetaState. Each returns a NEW
 * state (no mutation), so callers can preview/undo and tests stay trivial. Two layers,
 * per design/14: UNLOCK a blueprint (permanent account right) and CRAFT an instance from
 * an unlocked blueprint by spending banked materials, staging it into the next run's
 * loadout (≤ WEAPON_SLOTS; each crafted weapon lasts exactly one run, design/05).
 *
 * Crafting currency is the five elemental materials (content/materials.ts) keyed
 * `mat_<element>` in the bank. `minTier` in a recipe is authored but NOT yet enforced —
 * the bank aggregates qty per element and does not preserve the rolled tier, so tier-
 * gating waits on the bank tracking per-(element,tier) (a follow-up; see blueprints.ts).
 */
import { BLUEPRINT_CATALOG, PLAYER_BASE, type WeaponBlueprint } from '@dd/engine';
import type { MetaState } from './MetaState';

/** Fold a finished run's carry-out bag (GameState.bankedMaterials) into the account bank.
 * Called on a successful extraction — a death banks nothing (design/05, handled upstream). */
export function bankMaterials(m: MetaState, banked: Partial<Record<string, number>>): MetaState {
  const materialBank = { ...m.materialBank };
  for (const [id, qty] of Object.entries(banked)) {
    materialBank[id] = (materialBank[id] ?? 0) + (qty ?? 0);
  }
  return { ...m, materialBank };
}

export function isUnlocked(m: MetaState, weaponId: string): boolean {
  return m.unlockedBlueprints.includes(weaponId);
}

/** Grant a blueprint (from a drop / purchase / event). Idempotent; ignores unknown ids. */
export function unlockBlueprint(m: MetaState, weaponId: string): MetaState {
  if (!BLUEPRINT_CATALOG[weaponId] || isUnlocked(m, weaponId)) return m;
  return { ...m, unlockedBlueprints: [...m.unlockedBlueprints, weaponId] };
}

/** Does the bank hold enough of every material a recipe demands? */
export function canAfford(m: MetaState, bp: WeaponBlueprint): boolean {
  return bp.cost.every((c) => (m.materialBank[`mat_${c.element}`] ?? 0) >= c.qty);
}

export type CraftFailure = 'unknown' | 'locked' | 'loadout-full' | 'unaffordable';
export type CraftResult = { ok: true; meta: MetaState } | { ok: false; reason: CraftFailure };

/** Craft one instance of `weaponId` into the staged loadout: requires the blueprint to
 * exist, be unlocked, a free loadout slot, and enough materials — spends them on success. */
export function craft(m: MetaState, weaponId: string): CraftResult {
  const bp = BLUEPRINT_CATALOG[weaponId];
  if (!bp) return { ok: false, reason: 'unknown' };
  if (!isUnlocked(m, weaponId)) return { ok: false, reason: 'locked' };
  if (m.loadout.length >= PLAYER_BASE.weaponSlots) return { ok: false, reason: 'loadout-full' };
  if (!canAfford(m, bp)) return { ok: false, reason: 'unaffordable' };

  const materialBank = { ...m.materialBank };
  for (const c of bp.cost) materialBank[`mat_${c.element}`] = (materialBank[`mat_${c.element}`] ?? 0) - c.qty;
  return { ok: true, meta: { ...m, materialBank, loadout: [...m.loadout, weaponId] } };
}

/** Clear the staged loadout (e.g. after a run consumes it, or the player reconsiders).
 * The crafted weapons are gone either way — they were spent when crafted (design/05). */
export function clearLoadout(m: MetaState): MetaState {
  return { ...m, loadout: [] };
}

/** Choose the character for the next run; ignored if the account doesn't own it. */
export function selectCharacter(m: MetaState, skinId: string): MetaState {
  if (!m.ownedCharacters.includes(skinId)) return m;
  return { ...m, selectedSkin: skinId };
}
