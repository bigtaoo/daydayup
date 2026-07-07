# WeChat mini-game adaptation & verification

The WeChat mini-game is the most constrained target: **no DOM, no full window/document**. Rendering dependencies and base-library versions must be verified explicitly.

## Key constraints

- No full `document` / `window`; `Image`, `OffscreenCanvas`, `createImageBitmap`, `Audio`, etc. must be provided by **weapp-adapter** (WeChat's official adaptation library).
- Usually only **one main canvas** (`wx.createCanvas()`); multiple WebGL contexts are poorly supported → confirms the "single engine" decision.
- **No WebGPU** → Pixi v8 falls back to WebGL automatically. Confirm the WebGL2 support surface across target devices' base libraries.
- Avoid `document.createElement('canvas')` for texture generation; use `wx.createCanvas()` or pure Pixi Graphics/RenderTexture (the demo's glow uses pure Graphics, which is portable).

## Version-selection principle (important)

- Use Pixi **v8**; do not upgrade blindly. Pick a version that has been tested to run every asset-loading path on the **lowest target base library**, then pin it (lockfile).
- The main pitfalls are in the **asset/texture loaders'** differing reliance on `Image` / `ImageBitmap` → must be verified on a real device, not from docs.

## Verification checklist (run in WeChat DevTools + on a real device)

> Done by the developer in WeChat DevTools. This repo's demo first guarantees the Web build runs and that the rendering path is WeChat-safe.

1. [ ] Integrate weapp-adapter; the `client` build boots in WeChat DevTools and renders the tilted-view scene.
2. [ ] Verify on the **lowest target base-library version** (not just the latest).
3. [ ] Real-device check: frame rate on low-end Android (target 30 vs 60 fps).
4. [ ] Verify WebGL2 availability; define a fallback path if unavailable.
5. [ ] Touch input replacing mouse/keyboard (see below).
6. [ ] Milestone 2: dynamic lighting (lightmap / normal maps) performance on the lowest base library + low-end devices.

## Adaptation layer (client/src/platform)

- `platform/` isolates platform differences: input, canvas acquisition, asset paths, lifecycle.
- The Web entry `main.ts` uses browser APIs directly; the WeChat entry later adds `game.js` + weapp-adapter, reusing the `Game` core.
- **Input:** the demo uses mouse + keyboard (to verify rendering/gameplay on Web); WeChat needs a **virtual joystick + touch**, already isolated behind the `input` abstraction for easy replacement.

## Build artifact shape (to be integrated)

A WeChat mini-game project needs `game.js` (entry), `game.json`, and `project.config.json`, and `require('./weapp-adapter')` at the top of the entry. Core logic is reused from `src/game`; only the entry and platform layer differ.
