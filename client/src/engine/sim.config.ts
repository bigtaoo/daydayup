/**
 * Sim tuning — the cross-cutting simulation constants that are neither weapon nor
 * actor content. Weapons + actor stats moved to content/ in Stage C (weapons.ts /
 * players.ts / enemies.ts); the drop table + heal amount moved to content/drops.ts
 * in Stage F. What remains here is the wave-director cadence and the
 * projectile/pickup padding.
 *
 * SPATIAL UNIT (Stage C): grid — 1 fp = 1/1000 grid, 1 grid = 32 px. Ported
 * Stage-B px paddings cross via pxToFp (÷32). Any change here that alters outcomes
 * bumps ENGINE_VERSION.
 */
import { pxToFp } from './content/convert';

export const SIM = {
  bullet: {
    oobMargin: pxToFp(50), // despawn once this far outside the world
  },
  waveBreakTicks: 24, // 48 frames pause between cleared wave and next spawn
  pickupRadius: pxToFp(15), // collect padding beyond player radius
} as const;
