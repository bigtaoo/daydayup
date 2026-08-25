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
├─ game.json            mini-game config (orientation, etc.) — the TEMPLATE the build reads;
│                       the copy in platforms/wechat/ is GENERATED from it, because a second
│                       asset pack has to appear there as a `subpackages` entry
├─ project.config.json  DevTools project config (reference; set a real appid to open here)
└─ js/game.js           ← bundled output of ../src/main.wechat.ts (generated, git-ignored)
```

`platforms/wechat/` additionally receives `skins/ biome/ ui/ weapons/ environment/` and a
`packs/<subpackage>/` tree, mirrored from `../public` by package
(`build/wechatAssetSync.mjs`). A mini-game resolves a package path from the project root,
which is why the art sits beside `game.json` rather than under `js/`. Each subpackage also
gets a generated no-op `game.js` — the 分包 docs describe a subpackage `root` as a directory
whose `game.js` is its entry, and never document a resource-only pack. `project.config.json`
is seeded (tourist appid) only if absent, so a real one is never overwritten.

## Build & run

From `client/`:

```bash
npm run build:wechat
```

This typechecks, bundles `../src/main.wechat.ts` (with Pixi) into `js/game.js` as a single
self-contained IIFE (vite lib mode, `vite.wechat.config.js`), tree-shakes out Pixi's
WebGPU renderer (`strip-webgpu` plugin — WeChat forces WebGL), and syncs
`game.js` / `js/game.js` into `../../platforms/wechat/`, mirrors the art in by package and
generates `game.json` (`copy-to-platform` plugin + `build/wechatAssetSync.mjs`). Then open
`platforms/wechat` in WeChat DevTools. `js/` is git-ignored; `minify` follows Vite's mode, so
plain `build:wechat` is minified and `build:wechat:debug` is not.

Run `npm run check:wechatpackage` (repo root) for the 4 MB main-package byte budget — it is
part of `npm run check` and needs no build.

Which art is in which package is decided in `../src/render/assetPacks.json`; `packLoader.ts`
fetches every subpackage once at boot. See `../../design/04-wechat.md`, "Package budget".

DevTools CLI (`cli.bat open --project platforms/wechat`) additionally needs
**设置 → 安全设置 → 服务端口** switched on once, by hand.

Work through the checklist in `../../design/04-wechat.md` (boot & render ✅ → lowest base
library → real-device frame rate → WebGL2 → touch feel).

## Platform layer (already in place)

- `../src/platform/wechat/WeChatPlatform.ts` — acquires the single `wx` canvas, installs
  `WeChatAdapter`, and inits Pixi with WebGL (no WebGPU, no `resizeTo`, `manageImports:false`).
- `../src/platform/wechat/WeChatAdapter.ts` — Pixi v8 `DOMAdapter` implementation for the
  WeChat runtime (replaces weapp-adapter).
- `../src/platform/wechat/WeChatInput.ts` — touch input: left stick moves, a fire button on
  the right (manual aim was removed engine-side), corner buttons for weapon 1 / weapon 2.
- `../src/platform/wechat/weChatAssetHost.ts` — how real art is reached here: package-relative
  paths for `wx.createImage()`, `FileSystemManager` for the JSON sidecars. See
  `../src/render/assetHost.ts` and `../../design/04-wechat.md`.
- `../src/main.wechat.ts` — entry; `import 'pixi.js/unsafe-eval'` first (WeChat forbids eval).
