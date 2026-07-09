/**
 * Enemy blueprint (design/09 actor content). The basic mob's HP / footprint /
 * loadout, read by SpawnSystem to instantiate wave enemies. Supersedes
 * sim.config.ts SIM.enemy + ENEMY_BLASTER from Stage B.
 *
 * Radius is the Stage-B px value re-anchored to grid via pxToFp (÷32). The weapon
 * is the shared enemy-gun sim spec (content/weapons.ts). HP/fire/bullet all live
 * here now — no enemy tuning left inline in a system.
 */
import type { Fp } from '../math/fixed';
import type { RangedSimSpec } from '../state/entities';
import { pxToFp } from './convert';
import { ENEMY_GUN_SIM } from './weapons';

export interface EnemyBlueprint {
  maxHp: number;
  radius: Fp;
  footprintRadius: Fp; // feet circle for solid push-out (< radius); see Actor.footprintRadius
  weapon: RangedSimSpec;
}

export const BASIC_ENEMY: EnemyBlueprint = {
  maxHp: 3,
  radius: pxToFp(15), // demo 15px
  footprintRadius: pxToFp(7),
  weapon: ENEMY_GUN_SIM,
};
