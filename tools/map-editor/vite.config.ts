import { defineConfig } from 'vite';
// @ts-expect-error — plain .mjs helper, shared with every other vite/vitest config here.
import { engineAlias } from '../../build/ddAlias.mjs';
// @ts-expect-error — plain .mjs helper, shared with tools/animator's vite config.
import { versionManifestPlugin } from '../../build/versionManifestPlugin.mjs';

export default defineConfig({
  // @dd/engine — the shared source alias (build/ddAlias.mjs). This tool consumes the
  // engine source directly, so RoomPiece/ArenaMap never drift from the real schema.
  resolve: { alias: engineAlias },
  // version.json lets the desktop shell (tools/desktop-shell) detect a new build
  // without comparing full asset contents — see contentUpdatePoller.ts there.
  plugins: [versionManifestPlugin()],
  server: { port: 5175, host: true },
  build: { target: 'es2020', outDir: 'dist' },
});
