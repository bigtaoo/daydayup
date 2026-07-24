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
  footprintRadius: Fp; // feet circle for solid push-out (< radius); see Actor.footprintRadius
  speedPerTick: Fp; // fp displacement per tick at full move magnitude
  margin: Fp; // clamp inset from the world edge
  weaponSlots: number; // carried-weapon slots (design/09 WEAPON_SLOTS)
  startWeapons: WeaponSimSpec[]; // loadout; index 0 active at spawn, SWAP toggles
}

export const PLAYER_BASE: PlayerBase = {
  radius: pxToFp(16), // 0.5 grid (demo 16px)
  footprintRadius: pxToFp(7), // small feet circle so the body can overlap a pillar
  speedPerTick: pxToFp(6.4), // 3.2 px/frame × 2 = 6.4 px/tick ≈ 6 grid/s
  margin: pxToFp(20),
  weaponSlots: 2,
  startWeapons: [BLASTER_SIM, SABER_SIM], // gun + saber; a Stage-F build swaps this
};
