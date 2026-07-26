import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const engineDir = fileURLToPath(new URL('../../client/src/engine', import.meta.url));

export default defineConfig({
  resolve: {
    // @dd/engine — same cross-package source alias `map-editor`/`server` already use
    // (no build step, no published package). Unused today (the animator's runtime
    // math is self-contained), kept for parity so a future rig/atlas type shared
    // with the game's render side doesn't need a fourth alias invented from scratch.
    alias: [
      { find: /^@dd\/engine$/, replacement: `${engineDir}/index.ts` },
      { find: /^@dd\/engine\//, replacement: `${engineDir}/` },
    ],
  },
  server: { port: 5176, host: true },
  build: { target: 'es2020', outDir: 'dist' },
});
