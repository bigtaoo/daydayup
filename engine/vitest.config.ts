import { defineConfig } from 'vitest/config';
// @ts-expect-error — plain .mjs helper, shared with every other vite/vitest config here.
import { engineAlias } from '../build/ddAlias.mjs';

// The engine's own tests import it through the same `@dd/engine` specifier every consumer
// uses, so the alias has to resolve here too. Only the engine alias: nothing in this
// package may reach into the client.
export default defineConfig({
  resolve: { alias: engineAlias },
});
