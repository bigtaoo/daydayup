import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.js';

// Separate from the default `npm test` glob (**/*.{test,spec}.ts), same reason as the two
// balance sims: arenaAudit.sim.ts produces a REPORT to read (design/15 map quality), not an
// assertion to pass, so it would only add noise to every default run. Run explicitly via
// `npm run audit:arena`.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ['sim/arenaAudit.sim.ts'],
    },
  }),
);
