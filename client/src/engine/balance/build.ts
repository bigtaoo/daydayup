/**
 * The build layer — the fairness wall (design/05/06/09). Two builders resolve
 * authored loadouts into the WeaponState[] a PlayerActor spawns with, and the
 * TYPES themselves enforce the PvP fairness guarantee:
 *
 *   buildRunSpecs(baseLoadout, runAffixes)  — PvE: persistent meta (horizontal) +
 *                                             in-run affixes (the power axis).
 *   buildArenaSpecs(presetId)               — PvP: a preset id and NOTHING else.
 *
 * buildArenaSpecs physically cannot receive meta/affixes — there is no parameter
 * for it (design/09 "compile-time impossible to leak persistent gear into PvP",
 * unit-tested by arity). PvP power comes only from the preset + on-map pickups
 * (design/05). This is design/05's hybrid-gear table made executable.
 *
 * Stage F wires buildRunSpecs into GameState construction and PickupSystem's
 * in-run weapon/affix drops. buildArenaSpecs is a minimal stub — the arena preset
 * catalog (balance/presets.ts) and PvP mode are post-MVP (design/05) — but the
 * wall is real and load-bearing now so it can never regress.
 */
import type { Affix } from './affixes';
import { applyAffixes } from './affixes';
import type { WeaponSimSpec, WeaponState } from '../state/entities';
import { makeWeapon } from '../content/weapons';

/** The resolved run build carried on the PlayerActor (design/05 "in-run build"). */
export interface RunBuild {
  /** Every affix picked up this run, in acquisition order (design/09 stack). */
  affixes: Affix[];
}

/**
 * Resolve one weapon: a fresh runtime whose active spec is the base with the
 * current affix stack applied. `base` is retained so a later pickup can re-resolve
 * without re-reading config (see PickupSystem). Cooldown starts ready.
 */
export function resolveWeapon(base: WeaponSimSpec, affixes: readonly Affix[]): WeaponState {
  const w = makeWeapon(base);
  w.spec = applyAffixes(base, affixes);
  return w;
}

/**
 * PvE run builder (design/09). `baseLoadout` is the persistent-meta loadout carried
 * in at match start (horizontal — build breadth, not raw power); `runAffixes` is the
 * in-run stack (the real power axis). Both reach the run, never PvP.
 */
export function buildRunSpecs(
  baseLoadout: readonly WeaponSimSpec[],
  runAffixes: readonly Affix[],
): WeaponState[] {
  return baseLoadout.map((base) => resolveWeapon(base, runAffixes));
}

// ── PvP arena (the wall) ────────────────────────────────────────────────────────
//
// Minimal preset table so buildArenaSpecs is honest today; the full ARENA_PRESETS
// catalog + win conditions + pickup table are design/05 open work (post-MVP). The
// LOAD-BEARING part is the signature: no affix/meta parameter exists.

export type ArenaPresetId = string;

const ARENA_PRESETS: Record<ArenaPresetId, { loadout: WeaponSimSpec[] }> = {};

/**
 * PvP arena builder. Takes a preset id and NOTHING else — there is deliberately no
 * meta/affix parameter, so persistent gear is compile-time impossible to leak into
 * PvP (design/05/06/09 fairness wall). Guarded by an arity test (build.test.ts).
 */
export function buildArenaSpecs(presetId: ArenaPresetId): WeaponState[] {
  const preset = ARENA_PRESETS[presetId];
  if (!preset) throw new Error(`Unknown arena preset '${presetId}' (design/09 validate-at-load).`);
  return preset.loadout.map((base) => makeWeapon(base)); // no affixes — ever
}
