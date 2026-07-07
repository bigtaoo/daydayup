import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { copyFileSync, mkdirSync } from 'node:fs';

// Strip Pixi's WebGPU renderer from the WeChat bundle.
//
// Application.init → autoDetectRenderer picks a renderer via dynamic import
// (import('./gpu/WebGPURenderer.mjs')). WeChat needs a single file, so we set
// inlineDynamicImports:true — which would otherwise inline the entire WebGPU
// renderer even though it never runs (we force preference:'webgl', and WeChat has
// no WebGPU). Replacing that module with a stub makes the WebGPU renderer subtree
// (device / pipeline / encoder / render-target systems) unreachable, so Rollup
// tree-shakes it out. The stub throws only if actually constructed, which never
// happens on the webgl path.
const stripWebGPU = {
  name: 'strip-webgpu',
  enforce: 'pre',
  resolveId(source) {
    if (source.endsWith('gpu/WebGPURenderer.mjs')) return '\0webgpu-stub';
    return null;
  },
  load(id) {
    if (id === '\0webgpu-stub') {
      return 'export class WebGPURenderer { constructor() { throw new Error("WebGPU renderer was stripped from the WeChat build (WebGL only)"); } }';
    }
    return null;
  },
};

// After the bundle is written, sync the runnable mini-game into platforms/wechat —
// the project WeChat DevTools actually opens (it keeps its own project.config.json,
// which carries the real appid, so we never overwrite that). This makes
// `npm run build:wechat` produce a ready-to-open project in one step.
const PLATFORM_FILES = [
  ['wechat/game.js', '../platforms/wechat/game.js'],
  ['wechat/game.json', '../platforms/wechat/game.json'],
  ['wechat/js/game.js', '../platforms/wechat/js/game.js'],
];
const copyToPlatform = {
  name: 'copy-to-platform',
  closeBundle() {
    mkdirSync(fileURLToPath(new URL('../platforms/wechat/js', import.meta.url)), { recursive: true });
    for (const [from, to] of PLATFORM_FILES) {
      copyFileSync(
        fileURLToPath(new URL(`./${from}`, import.meta.url)),
        fileURLToPath(new URL(to, import.meta.url)),
      );
    }
    console.log('  synced game.js / game.json / js/game.js → platforms/wechat');
  },
};

// WeChat mini-game bundle build.
//
// Produces a single self-contained IIFE at wechat/js/game.js, then copies the shell +
// bundle into platforms/wechat (see copyToPlatform above). No weapp-adapter: the bundle
// installs Pixi's own DOMAdapter itself. See design/04-wechat.md.
//
// Notes:
//  - IIFE + inlineDynamicImports → one file, no ESM import/export, no code-split
//    chunks (the WeChat runtime loads a single script via require).
//  - No assets are emitted: the slice renders with pure Pixi Graphics, so there are
//    no texture URLs to rewrite. assetsInlineLimit is raised as a guard.
//  - minify stays off for DevTools bring-up (readable stack traces); flip on for release.
//  - target es2020 matches the Web build; verify against the lowest WeChat base
//    library and lower this if needed (checklist item 2 in design/04-wechat.md).
export default defineConfig({
  plugins: [stripWebGPU, copyToPlatform],
  build: {
    target: 'es2020',
    outDir: 'wechat/js',
    emptyOutDir: true,
    minify: false,
    assetsInlineLimit: 100_000_000,
    lib: {
      entry: fileURLToPath(new URL('./src/main.wechat.ts', import.meta.url)),
      formats: ['iife'],
      name: 'DayDayUpGame',
      fileName: () => 'game.js',
    },
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});
