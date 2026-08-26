/**
 * Player blueprint (design/09 actor content). The stats GameState reads to
 * instantiate the player, plus the physics constants the Movement / ApplyInput
 * systems tune against. Supersedes sim.config.ts SIM.player from Stage B.
 *
 * Physics values are the Stage-B px-per-tick tuning re-anchored to grid via pxToFp
 * (÷32), so behaviour is byte-identical to Stage B modulo rounding — see the
 * per-field derivation. Velocities were already pre-multiplied to per-tick
 * displacement @30Hz in Stage B (× 60/30 = ×2), so ÷32 alone rescales them.
 */
import type { Fp } from '../math/fixed';
import type { WeaponSimSpec } from '../state/entities';
import { pxToFp } from './convert';
import { BLASTER_SIM, SABER_SIM, WEAPON_SIM_BY_ID } from './weapons';

/**
 * PLAYER_BASE — the stats SHARED by every character (design/09). The per-character
 * defensive identity (maxHp, maxShield, shield-break passive) lives on the SkinDef
 * (content/skins.ts); at match start GameState merges a chosen SkinDef into these
 * base constants to build the PlayerActor. Two-pool regen timings are cross-cutting
 * engine constants (config.ts SHIELD_REGEN_*), shared by any shielded actor.
 */
export interface PlayerBase {
  radius: Fp;
  footprintRadius: Fp; // feet circle for actor↔actor push-out (< radius); see Actor.footprintRadius
  solidRadius: Fp; // radius used against walls/pillars; see Actor.solidRadius
  speedPerTick: Fp; // fp displacement per tick at full move magnitude
  margin: Fp; // clamp inset from the world edge
  weaponSlots: number; // carried-weapon slots (design/09 WEAPON_SLOTS)
  // Default loadout: one GUN + one MELEE weapon, index 0 active at spawn, SWAP toggles.
  // Order matters twice — index 0 is what a run spawns holding, and resolveLoadout()
  // below fills a crafted loadout's free slots from here BY KIND, so this list is also
  // the per-kind default table. Keep exactly one entry per kind.
  startWeapons: WeaponSimSpec[];
}

export const PLAYER_BASE: PlayerBase = {
  radius: pxToFp(16), // 0.5 grid (demo 16px)
  footprintRadius: pxToFp(7), // small feet circle so two bodies can overlap in a crowd
  /**
   * Against a WALL or a PILLAR, the character stops at its own body radius, not at
   * the 7 px feet circle (ENGINE_VERSION 43, from the report *"角色走到墙角的时候，
   * 太靠墙了，感觉陷进去了"*).
   *
   * The feet circle exists so a tall sprite may overlap what it stands against — a
   * genuine depth cue between two BODIES, and still what `footprintRadius` is for.
   * Against a standing wall it produced the opposite reading: the rendered body is
   * 32 px wide (`radius` × 2 — the rig is normalized to exactly that, design/12),
   * so hugging a wall's east or west face buried 9 px of the silhouette in the
   * wall's own art and the character read as embedded in the stone rather than
   * beside it.
   *
   * Matching the body radius exactly makes the silhouette land tangent to the wall
   * — close enough to still read as "against it", which is what the report asked
   * for. The depth cue survives untouched on the other two sides: the body floats
   * 4–36 px ABOVE its ground point (the rig's own hover, design/13's "it floats,
   * there is no walk cycle"), so a character standing south of a wall still overlaps
   * that wall's standing face by most of its height at this clearance.
   */
  solidRadius: pxToFp(16),
  speedPerTick: pxToFp(6.4), // 3.2 px/frame × 2 = 6.4 px/tick ≈ 6 grid/s
  margin: pxToFp(20),
  weaponSlots: 2,
  // gun + saber. Every run carries both (resolveLoadout): a crafted weapon REPLACES the
  // default of its own kind rather than emptying the other slot, so the swap verb always
  // has something to swap to. A Stage-F build swaps the defaults themselves.
  startWeapons: [BLASTER_SIM, SABER_SIM],
};

/**
 * Resolve the loadout a run actually spawns with (design/05/09, ENGINE_VERSION note
 * below). The invariant this enforces: **a character always carries a gun AND a melee
 * weapon** — the swap control (Button.SWAP_WEAPON / the HUD's idle-slot chip) is a core
 * verb, not something a run can silently lose.
 *
 * Rules, in order:
 *   - Unknown ids are dropped (design/09 forward-compat), then the list is capped at
 *     `weaponSlots`.
 *   - Whatever survived keeps its staged order and stays ACTIVE-first — you crafted it,
 *     you spawn holding it.
 *   - Every free slot is then filled from `startWeapons` with a kind (`ranged`/`melee`)
 *     the staged list doesn't already cover. So: nothing crafted → gun + saber; one
 *     crafted gun → that gun + saber; one crafted blade → that blade + gun.
 *
 * Replaces the old "empty loadout → auto pistol" fallback, which was reachable on EVERY
 * ordinary run (a fresh save's `loadout` is `[]`, and crafted weapons are consumed after
 * one run, so runs 2+ were always empty) and left the player with a single weapon and no
 * melee at all. Staging two weapons of the SAME kind is still honoured verbatim — that
 * is an explicit choice, and no crafted weapon is ever discarded to make room for a
 * default.
 */
export function resolveLoadout(ids: readonly string[] | undefined): readonly WeaponSimSpec[] {
  const staged = (ids ?? [])
    .map((id) => WEAPON_SIM_BY_ID[id])
    .filter((s): s is WeaponSimSpec => s !== undefined)
    .slice(0, PLAYER_BASE.weaponSlots);

  // No `staged.length === 0` shortcut: the fill loop below already yields exactly
  // `startWeapons`, in order, for an empty list. A mutation battery flagged that early
  // return as unreachable-equivalent — and returning `PLAYER_BASE.startWeapons` itself
  // handed callers a mutable alias of the content table, which the loop's fresh array
  // never does.
  const out = [...staged];
  for (const fallback of PLAYER_BASE.startWeapons) {
    if (out.length >= PLAYER_BASE.weaponSlots) break;
    if (!out.some((w) => w.kind === fallback.kind)) out.push(fallback);
  }
  return out;
}
