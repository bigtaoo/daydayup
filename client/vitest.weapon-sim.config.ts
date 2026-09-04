import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.js';

// Sibling of vitest.pve-sim.config.ts / vitest.pvp-sim.config.ts, same reasoning:
// `weaponSweep.sim.ts` plays the shipped level once per weapon per seed (24 player-facing
// weapons × 8 seeds) to produce per-weapon balance data. Cheaper than the PvE level sim
// (its runs are capped at 6000 ticks rather than 40 000) but still real bot-driven runs —
// out of the default `npm test` glob on the same grounds. Run it via
// `npm run test:weapon-sim`.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ['sim/weaponSweep.sim.ts'],
      testTimeout: 900_000,
      hookTimeout: 900_000,
    },
  }),
);
