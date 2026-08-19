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
import { BLASTER_SIM, SABER_SIM } from './weapons';

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
  startWeapons: WeaponSimSpec[]; // loadout; index 0 active at spawn, SWAP toggles
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
  startWeapons: [BLASTER_SIM, SABER_SIM], // gun + saber; a Stage-F build swaps this
};
