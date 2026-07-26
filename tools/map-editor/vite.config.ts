import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const engineDir = fileURLToPath(new URL('../../client/src/engine', import.meta.url));

export default defineConfig({
  resolve: {
    // @dd/engine — same cross-package source alias `server` already uses (no build
    // step, no published package; this tool consumes the client's engine source
    // directly, so RoomPiece/ArenaMap types never drift from the real schema).
    alias: [
      { find: /^@dd\/engine$/, replacement: `${engineDir}/index.ts` },
      { find: /^@dd\/engine\//, replacement: `${engineDir}/` },
    ],
  },
  server: { port: 5175, host: true },
  build: { target: 'es2020', outDir: 'dist' },
});
