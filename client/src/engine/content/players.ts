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

export interface PlayerBlueprint {
  maxHp: number;
  radius: Fp;
  speedPerTick: Fp; // fp displacement per tick at full move magnitude
  margin: Fp; // clamp inset from the world edge
  jumpV: Fp; // initial upward z velocity, fp/tick
  gravity: Fp; // z acceleration per tick, fp/tick²
  startWeapons: WeaponSimSpec[]; // loadout; index 0 active at spawn, SWAP toggles
}

export const PLAYER: PlayerBlueprint = {
  maxHp: 6,
  radius: pxToFp(16), // 0.5 grid (demo 16px)
  speedPerTick: pxToFp(6.4), // 3.2 px/frame × 2 = 6.4 px/tick ≈ 6 grid/s
  margin: pxToFp(20),
  jumpV: pxToFp(26), // 13 px/frame × 2
  gravity: pxToFp(3.6), // 0.9 px/frame² × 4 (dt doubled → dt² ×4)
  startWeapons: [BLASTER_SIM, SABER_SIM], // gun + saber; a Stage-F build swaps this
};
