# WeChat mini-game adaptation & verification

The WeChat mini-game is the most constrained target: **no DOM, no full window/document, no eval**. Rendering dependencies and base-library versions must be verified explicitly.

> **Status (2026-07-07): boot + render verified in WeChat DevTools.** The vertical
> slice (tilted-view grid, player + weapon, pillars with Y-sort/height/shadow, enemy)
> renders in the simulator on base library 3.15.2 with no console errors, using Pixi v8
> WebGL + our own DOM adapter + the unsafe-eval polyfill. Remaining checklist items
> (lowest base library, real-device frame rate, touch feel) still require a device.

## Key constraints

- No full `document` / `window`; `Image`, `OffscreenCanvas`, `createImageBitmap`, `Audio`, etc. are not provided. See **Adaptation approach** below for how we satisfy Pixi's DOM dependencies without weapp-adapter.
- Usually only **one main canvas** (the first `wx.createCanvas()`); multiple WebGL contexts are poorly supported → confirms the "single engine" decision. Later `wx.createCanvas()` calls return offscreen (2D) sub-canvases.
- **No WebGPU** → force Pixi to WebGL (`preference: 'webgl'`). We also tree-shake the WebGPU renderer out of the bundle entirely (see build notes).
- **No `eval` / `new Function`** (unsafe-eval is disabled). Pixi v8 generates uniform/UBO/shader upload code via `new Function` by default → must use Pixi's eval-free polyfill.
- Avoid `document.createElement('canvas')` for texture generation; the demo's glow uses pure Pixi Graphics (portable). Canvas2D that *is* needed (e.g. `Text` glyph rasterization) goes through the adapter's `createCanvas` → `wx.createCanvas()`.

## Adaptation approach (verified)

We do **not** use weapp-adapter. Modern WeChat templates no longer ship it, and Pixi v8
exposes a clean official extension point — the `DOMAdapter` — that we implement in a
small file we own (`client/src/platform/wechat/WeChatAdapter.ts`). This matches the
project's open-source-control preference (see `00-tech-stack.md`, Decision 2).

Three concrete pitfalls were hit and fixed while bringing this up in DevTools:

| Symptom | Cause | Fix |
|---|---|---|
| `simulator game launch error: game.json: ["workers"] cannot be ''` — game never launches | `game.json` had `"workers": ""` (empty string is invalid) | Remove the `workers` field |
| Pixi needs `document`/`Image`/canvas that WeChat doesn't provide | No weapp-adapter | Implement Pixi's `Adapter` interface (`WeChatAdapter`), `DOMAdapter.set(WeChatAdapter)` before `app.init`, and init with `manageImports:false` so Pixi's browser-environment probe can't overwrite it with the `BrowserAdapter` (which calls `document.createElement`) |
| `Error: Current environment does not allow unsafe-eval` at `WebGLRenderer._unsafeEvalCheck` | WeChat forbids `eval`/`new Function`; Pixi generates upload code that way | `import 'pixi.js/unsafe-eval'` at the top of the WeChat entry — it swaps in eval-free polyfills and neuters the check |

Adapter surface actually implemented (the slice is Graphics-only and loads no remote
assets): `createCanvas` (→ `wx.createCanvas()`), `createImage`, the WebGL1 / 2D context
constructor probes (for WebGL1-vs-2 detection and text metrics), and stubs for
`fetch`/`parseXML`/fonts. Extend `fetch` (→ `wx.request`/`wx.downloadFile`) if Assets are
introduced later.

## Version-selection principle (important)

- Use Pixi **v8**; do not upgrade blindly. Pick a version tested to run every asset-loading path on the **lowest target base library**, then pin it (lockfile).
- The main pitfalls are in the **asset/texture loaders'** differing reliance on `Image` / `ImageBitmap` → must be verified on a real device, not from docs. (The current slice loads no images, so this surfaces once real assets land.)

## Build & run

`npm run build:wechat` (in `client/`) does everything:

1. `tsc --noEmit` typecheck, then a vite **lib build** (`vite.wechat.config.js`) of
   `src/main.wechat.ts` → a single self-contained **IIFE** at `client/wechat/js/game.js`
   (`inlineDynamicImports` → one file, no ESM `import`/`export`, no chunks — the WeChat
   runtime loads it via `require`).
2. The **WebGPU renderer is stripped** by a `strip-webgpu` plugin (stubs
   `gpu/WebGPURenderer.mjs`, whose subtree then tree-shakes away; `preference:'webgl'`
   means it never runs anyway).
3. A `copy-to-platform` plugin syncs `game.js` / `game.json` / `js/game.js` into
   **`platforms/wechat/`** — the project WeChat DevTools opens. Its
   `project.config.json` (with the real appid) is left untouched.

Project shape reference: a WeChat mini-game needs `game.js` (entry, just
`require('./js/game.js')` — no weapp-adapter), `game.json`, and `project.config.json`.
Core logic is reused from `src/game`; only the entry and platform layer differ.

## Adaptation layer (client/src/platform)

- `platform/` isolates platform differences behind interfaces: `Platform` (canvas +
  Pixi Application + input) and `InputSource`.
- Web entry `main.ts` uses `WebPlatform` (keyboard + mouse). WeChat entry
  `main.wechat.ts` uses `WeChatPlatform` (wx canvas + `WeChatAdapter` + touch), reusing
  the same `Game` core.
- **Input:** Web is mouse (fire) + keyboard (move); WeChat is a **move stick + a fire
  button** (`WeChatInput`, design/10 v33 — the right side used to be a second, aiming
  stick, but manual aim is gone: the engine auto-faces the nearest hostile, else the
  movement direction), plus corner buttons for weapon 1 / weapon 2 (no jump/block
  button — parry is the melee swing).
- ✅ **Full unit-test coverage across the platform layer, 2026-08-05 ("全部加测试" pass):**
  every file under `client/src/platform/` now has a dedicated test file except
  `types.ts` (pure type declarations) and `{Web,WeChat}Platform.ts`'s own `createApp()`
  method (constructs a real Pixi `Application`/`app.init()` against a real WebGL
  context — the same class of exemption `Game.ts`/`ArenaCanvas.mount()` already have,
  daydayup-testing-conventions memory). All of it runs under plain-node vitest, no
  jsdom: a hand-rolled `wx`/`window`/`AudioContext` fake per file (mirroring
  `WebInput.test.ts`'s pre-existing convention) is enough — `WeChatInput.test.ts`
  (touch→`TouchControls` wiring, including the `touchcancel` branch `WebInput` doesn't
  have), `audioSynth.test.ts` (the shared synth voice table, driven with a fake
  `AudioContext`/node graph that records its own calls), `WebAudio.test.ts`/
  `WeChatAudio.test.ts` (the autoplay-gesture gate, the `ctx.state==='running'` play
  gate, volume clamping, and — WeChat-only — the "base library claims support but
  construction throws" permanent-degrade branch), `WeChatAdapter.test.ts` (Pixi's DOM
  adapter surface against a fake `wx`, including the module-scoped 2D-context-probe
  cache — reset via `vi.resetModules()` per test so the cache can't leak across tests),
  and `{Web,WeChat}Platform.test.ts` (the two testable factory methods,
  `createInput`/`createAudio`). This closes the last gap this doc's own verification
  checklist below couldn't (screenshot/log-based live checks confirm the real device
  behaves correctly, but never pinned down the platform layer's OWN logic branches as a
  fast, deterministic regression suite).

## Verification checklist

> Method used so far: drive WeChat DevTools via its CLI (`cli.bat open --project
> platforms/wechat`) and capture the window with `PrintWindow` + read `WeappLog` logs.
> Mini-games have no automation API to assert rendered pixels, so this is
> screenshot + log based, not programmatic.

1. [x] Integrate the adapter; the `client` build boots in WeChat DevTools and renders the tilted-view scene. *(2026-07-07, base lib 3.15.2)*
2. [ ] Verify on the **lowest target base-library version** (not just the latest).
3. [ ] Real-device check: frame rate on low-end Android (target 30 vs 60 fps).
4. [ ] Verify WebGL2 availability; define a fallback path if unavailable.
5. [ ] Touch input on a real device (twin-stick logic is wired; feel needs hands-on).
6. [ ] Milestone 2: dynamic lighting (lightmap / normal maps) performance on the lowest base library + low-end devices.
