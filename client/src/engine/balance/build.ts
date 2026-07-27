/**
 * The build layer — the fairness wall (design/05/06/09). Two builders resolve
 * authored loadouts into the WeaponState[] a PlayerActor spawns with, and the
 * TYPES themselves enforce the PvP fairness guarantee:
 *
 *   buildRunSpecs(baseLoadout)          — PvE: the persistent meta loadout (horizontal).
 *   buildArenaSpecs(presetId, skinId)   — PvP: a preset id + which character, NOTHING else.
 *
 * buildArenaSpecs physically cannot receive meta (weapon/material/blueprint) — there
 * is no parameter for it (design/09 "compile-time impossible to leak persistent gear
 * into PvP", unit-tested by arity). `skinId` is NOT a wall violation: design/14/15
 * name character choice as the fairness wall's one deliberate exception (a player's
 * chosen skin carries into PvP same as PvE) — it is what lets buildArenaSpecs apply
 * the PvP HP/weapon scale factor (design/15) to the RIGHT (maxHp, maxShield) pair.
 * PvP power beyond the landing kit + character choice comes only from on-map pickups
 * (design/05). This is design/05's hybrid-gear table made executable.
 *
 * buildRunSpecs is wired into GameState construction and (via makeWeapon) the
 * in-run weapon drops. buildArenaSpecs (ROADMAP 4.2c) is ALSO wired into GameState
 * construction (buildSeat branches on config.arena, ENGINE_VERSION 19->20) — PvP
 * mode is assembled end-to-end (Phase 4 closeout, ROADMAP.md).
 */
import type { WeaponSimSpec, WeaponState } from '../state/entities';
import { makeWeapon, BLASTER_SIM } from '../content/weapons';
import { resolveSkin, type SkinId } from '../content/skins';

/**
 * PvE run builder (design/09). `baseLoadout` is the persistent-meta loadout carried
 * in at match start (horizontal — build breadth, not raw power). It reaches the run,
 * never PvP.
 */
export function buildRunSpecs(baseLoadout: readonly WeaponSimSpec[]): WeaponState[] {
  return baseLoadout.map((base) => makeWeapon(base));
}

// ── PvP arena (the wall) ────────────────────────────────────────────────────────
//
// A "small landing-kit set, not a full loadout" (ROADMAP 4.2c) — real power comes
// from the map's own loot (design/05/15), so one modest starter preset is enough
// until the map editor's loot tables exist (4.3). The LOAD-BEARING part is the
// signature: no THIRD (meta) parameter exists, ever.

export type ArenaPresetId = string;

const ARENA_PRESETS: Record<ArenaPresetId, { loadout: WeaponSimSpec[] }> = {
  landing_basic: { loadout: [BLASTER_SIM] },
};

/**
 * PvP HP/weapon scale factor (design/15) — a single factor applied to both a
 * character's (maxHp, maxShield) and the landing-kit/arena-loot weapons' damage, so
 * relative time-to-kill matches PvE's feel at a bigger absolute number range (PvE's
 * 3-10ish HP pool leaves no room for a shrinking-zone DoT curve to matter). Design/15
 * is explicit that the EXACT value is content-tuning, not part of its locked shape
 * ("real play required") — this is a first-pass placeholder, not a tuned constant.
 */
export const PVP_SCALE_FACTOR = 5;

/** A weapon's PvP-scaled copy — only `damage` moves; the authored WEAPON_SIM_BY_ID
 * constants are never mutated (PvE reads the same objects). Fire rate/handling are
 * untouched: matching PvE's time-to-kill FEEL only requires damage-vs-HP to scale
 * together (design/15), not weapon pacing. */
function scaleWeaponDamage(spec: WeaponSimSpec, factor: number): WeaponSimSpec {
  return { ...spec, damage: Math.round(spec.damage * factor) };
}

export interface ArenaBuildResult {
  weapons: WeaponState[];
  maxHp: number;
  maxShield: number;
}

/**
 * PvP arena builder. Takes a preset id + which character — and NOTHING else. There
 * is deliberately no meta (weapon/material/blueprint) parameter, so persistent gear
 * is compile-time impossible to leak into PvP (design/05/06/09/15 fairness wall);
 * `skinId` is the wall's one named exception (design/14/15), needed here so the HP
 * scale factor applies to the right character. Guarded by an arity test
 * (build.test.ts: exactly 2 params, never 3).
 */
export function buildArenaSpecs(presetId: ArenaPresetId, skinId?: SkinId): ArenaBuildResult {
  const preset = ARENA_PRESETS[presetId];
  if (!preset) throw new Error(`Unknown arena preset '${presetId}' (design/09 validate-at-load).`);
  const skin = resolveSkin(skinId); // unknown/absent → default (forward-compat, same as PvE)
  return {
    weapons: preset.loadout.map((base) => makeWeapon(scaleWeaponDamage(base, PVP_SCALE_FACTOR))),
    maxHp: Math.round(skin.maxHp * PVP_SCALE_FACTOR),
    maxShield: Math.round(skin.maxShield * PVP_SCALE_FACTOR),
  };
}
