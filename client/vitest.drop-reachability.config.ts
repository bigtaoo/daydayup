import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.js';

// Sibling of vitest.pve-sim.config.ts: `dropReachability.sim.ts` bot-drives real runs of the
// shipped dungeon (8 seeds x 2 bot profiles) to re-measure the v50/v51 drop-reachability sweep —
// the measurement both versions rest on, which until now existed only as an ad-hoc script that
// was never committed.
//
// Out of the default `npm test` for the same reason as its siblings: it plays whole runs rather
// than asserting a unit, so it belongs to the opt-in tier this directory is for. It is NOT slow
// (~6 s, cheaper than pveLevelSim — runs end when the bot dies or extracts, and most end on
// floor 0), which is why `test:sims` includes it.
//
//     npm run test:drop-sim        (repo root, or `-w client`)
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ['sim/dropReachability.sim.ts'],
      testTimeout: 900_000,
      hookTimeout: 900_000,
    },
  }),
);
