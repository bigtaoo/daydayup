import { defineConfig } from 'vite';
import { engineAlias } from '../build/ddAlias.mjs';
import { versionManifestPlugin } from '../build/versionManifestPlugin.mjs';

export default defineConfig({
  // @dd/engine — deterministic sim core (design/06), a sibling package at the repo root
  // because the server and both tools consume the same source. See build/ddAlias.mjs.
  resolve: { alias: engineAlias },
  // Emits dist/version.json, polled by src/platform/web/autoReload.ts so a tab left open
  // across a deploy reloads itself. public/_headers keeps that file (and index.html)
  // uncached at Cloudflare's edge, without which the poll would read a stale hash.
  plugins: [versionManifestPlugin()],
  server: { port: 5173, host: true },
  build: { target: 'es2020', outDir: 'dist' },
});
