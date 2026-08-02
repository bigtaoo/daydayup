import { defineConfig } from 'vite';
import { engineAlias } from '../build/ddAlias.mjs';

export default defineConfig({
  // @dd/engine — deterministic sim core (design/06), a sibling package at the repo root
  // because the server and both tools consume the same source. See build/ddAlias.mjs.
  resolve: { alias: engineAlias },
  server: { port: 5173, host: true },
  build: { target: 'es2020', outDir: 'dist' },
});
