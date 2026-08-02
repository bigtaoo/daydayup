import { defineConfig } from 'vite';
// @ts-expect-error — plain .mjs helper, shared with every other vite/vitest config here.
import { engineAlias } from '../../build/ddAlias.mjs';

export default defineConfig({
  // @dd/engine — the shared source alias (build/ddAlias.mjs). This tool consumes the
  // engine source directly, so RoomPiece/ArenaMap never drift from the real schema.
  resolve: { alias: engineAlias },
  server: { port: 5175, host: true },
  build: { target: 'es2020', outDir: 'dist' },
});
