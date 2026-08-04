import { defineConfig } from 'vite';
// @ts-expect-error — plain .mjs helper, shared with every other vite/vitest config here.
import { engineAlias } from '../../build/ddAlias.mjs';
// @ts-expect-error — plain .mjs helper, shared with tools/map-editor's vite config.
import { versionManifestPlugin } from '../../build/versionManifestPlugin.mjs';

export default defineConfig({
  // @dd/engine — the shared source alias (build/ddAlias.mjs). Unused today (the
  // animator's runtime math is self-contained), kept for parity so a future rig/atlas
  // type shared with the game's render side works without inventing anything.
  resolve: { alias: engineAlias },
  // version.json lets the desktop shell (tools/desktop-shell) detect a new build
  // without comparing full asset contents — see contentUpdatePoller.ts there.
  plugins: [versionManifestPlugin()],
  server: { port: 5176, host: true },
  build: { target: 'es2020', outDir: 'dist' },
});
