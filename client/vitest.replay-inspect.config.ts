import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.js';

// Sibling of vitest.pve-sim.config.ts, different reason: `replayInspect.sim.ts` needs a
// recorded replay file (DD_REPLAY=<path>) that only exists once somebody has pressed F9,
// so it cannot be part of the default glob. The analysis it runs IS in the default suite
// — see sim/replay/inspect.test.ts.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ['sim/replayInspect.sim.ts'],
      testTimeout: 600_000,
      hookTimeout: 600_000,
    },
  }),
);
