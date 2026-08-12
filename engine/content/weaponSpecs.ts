/**
 * The demo weapon catalog (design/09), assembled from ./weaponSpecs/*.ts (CLAUDE.md
 * "500-line file convention", form ① — independent function/data modules: WEAPON_SPECS
 * is a content table with zero shared state between entries, so it splits cleanly by
 * the catalog's own pre-existing section groupings: starter / drop-only / elemental /
 * frame-library / frame-elemental). This file is purely data; conversion into the
 * sim-facing shape (`toSimSpec`) lives in weapons.ts. Kept as the single import path
 * (`from './weaponSpecs'`) so every existing call site is unaffected by the split.
 */
import { STARTER_WEAPON_SPECS } from './weaponSpecs/starter';
import { DROP_ONLY_WEAPON_SPECS } from './weaponSpecs/dropOnly';
import { ELEMENTAL_WEAPON_SPECS } from './weaponSpecs/elemental';
import { FRAME_LIBRARY_WEAPON_SPECS } from './weaponSpecs/frameLibrary';
import { FRAME_ELEMENTAL_WEAPON_SPECS } from './weaponSpecs/frameElemental';
import type { WeaponSpec } from './weaponTypes';

export const WEAPON_SPECS: Record<string, WeaponSpec> = {
  ...STARTER_WEAPON_SPECS,
  ...DROP_ONLY_WEAPON_SPECS,
  ...ELEMENTAL_WEAPON_SPECS,
  ...FRAME_LIBRARY_WEAPON_SPECS,
  ...FRAME_ELEMENTAL_WEAPON_SPECS,
};
