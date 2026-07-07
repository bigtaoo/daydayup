# DayDayUp — WeChat mini-game shell

The mini-game shell. `npm run build:wechat` bundles the game here **and** syncs it into
`../../platforms/wechat/` — the project WeChat DevTools actually opens (it carries the
real appid). It reuses the game core in `../src/game`; only the entry and the platform
layer (`../src/platform/wechat`) differ from the Web build. See `../../design/04-wechat.md`
for the full adaptation notes and verification status.

No weapp-adapter: the bundle installs Pixi's own `DOMAdapter` (`WeChatAdapter`) itself.

## Structure

```
wechat/
├─ game.js              entry: require('./js/game.js')
├─ game.json            mini-game config (orientation, etc.)
├─ project.config.json  DevTools project config (reference; set a real appid to open here)
└─ js/game.js           ← bundled output of ../src/main.wechat.ts (generated, git-ignored)
```

## Build & run

From `client/`:

```bash
npm run build:wechat
```

This typechecks, bundles `../src/main.wechat.ts` (with Pixi) into `js/game.js` as a single
self-contained IIFE (vite lib mode, `vite.wechat.config.js`), tree-shakes out Pixi's
WebGPU renderer (`strip-webgpu` plugin — WeChat forces WebGL), and syncs
`game.js` / `game.json` / `js/game.js` into `../../platforms/wechat/` (`copy-to-platform`
plugin). Then open `platforms/wechat` in WeChat DevTools. `js/` is git-ignored; `minify`
is off for readable stack traces — flip it on in the config for release.

Work through the checklist in `../../design/04-wechat.md` (boot & render ✅ → lowest base
library → real-device frame rate → WebGL2 → touch feel).

## Platform layer (already in place)

- `../src/platform/wechat/WeChatPlatform.ts` — acquires the single `wx` canvas, installs
  `WeChatAdapter`, and inits Pixi with WebGL (no WebGPU, no `resizeTo`, `manageImports:false`).
- `../src/platform/wechat/WeChatAdapter.ts` — Pixi v8 `DOMAdapter` implementation for the
  WeChat runtime (replaces weapp-adapter).
- `../src/platform/wechat/WeChatInput.ts` — twin-stick touch input: left stick moves,
  right stick aims + fires, corner buttons for jump / block / weapon 1 / weapon 2.
- `../src/main.wechat.ts` — entry; `import 'pixi.js/unsafe-eval'` first (WeChat forbids eval).
