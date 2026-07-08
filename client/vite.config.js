import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const engineDir = fileURLToPath(new URL('./src/engine', import.meta.url));

export default defineConfig({
  resolve: {
    // @dd/engine — deterministic sim core (design/06). Client references it via
    // this alias; the server will consume the same source as a workspace dep.
    // Order matters: match the exact bare specifier to the barrel first, then
    // fall through to subpath imports (@dd/engine/math/fixed → src/engine/math/fixed).
    alias: [
      { find: /^@dd\/engine$/, replacement: `${engineDir}/index.ts` },
      { find: /^@dd\/engine\//, replacement: `${engineDir}/` },
    ],
  },
  server: { port: 5173, host: true },
  build: { target: 'es2020', outDir: 'dist' },
});
