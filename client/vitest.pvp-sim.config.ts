import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.js';

// Separate from the default `npm test` glob (**/*.{test,spec}.ts) on purpose:
// pvpBalanceSim.sim.ts runs ~180 real bot-vs-bot matches (~6s) to produce PvP
// tuning data (design/15, ROADMAP 4.x) — a real, repeatable check, but slow enough
// that taxing every default `npm test` run with it isn't worth it. Run explicitly
// via `npm run test:pvp-sim`.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ['src/game/pvpBalanceSim.sim.ts'],
      testTimeout: 30_000,
    },
  }),
);
