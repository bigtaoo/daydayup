import { defineConfig } from 'vitest/config';
// @ts-expect-error — plain .mjs helper, shared with every other vite/vitest config here.
import { engineAlias } from '../build/ddAlias.mjs';

// The engine's own tests import it through the same `@dd/engine` specifier every consumer
// uses, so the alias has to resolve here too. Only the engine alias: nothing in this
// package may reach into the client.
export default defineConfig({
  resolve: { alias: engineAlias },
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html', 'lcov'],
      reportsDirectory: './coverage',
      // The engine has no `src/` — its sources sit at the package root, so the include is
      // the package minus the things that are not the sim. Whole-tree for the same reason
      // the client's is (see client/vite.config.js's long note): this package is pure
      // deterministic logic by construction, so there is nothing here that would need a
      // browser to exercise and therefore no honest reason to scope narrower than all of it.
      include: ['**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/*.d.ts',
        // Test fixtures, not shipped logic — `goldenScenarios.ts` and `brimGrinderFloor.ts`
        // exist to be replayed BY the gates in this package, so counting them would measure
        // the tests against themselves.
        'fixtures/**',
        // Configs and the golden-recorder CLI.
        'vitest.config.ts',
        'sim.config.ts',
        'scripts/**',
        'coverage/**',
      ],
    },
  },
});
