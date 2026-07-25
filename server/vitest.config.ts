import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// The server consumes @dd/engine from the client package's source (design/06 "server via
// workspace dependency; same bytes on both sides"). Mirror the client's alias so tests
// and the dev entrypoint resolve the engine identically.
const engineDir = fileURLToPath(new URL('../client/src/engine', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@dd\/engine$/, replacement: `${engineDir}/index.ts` },
      { find: /^@dd\/engine\//, replacement: `${engineDir}/` },
    ],
  },
});
