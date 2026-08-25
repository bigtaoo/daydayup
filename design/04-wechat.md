# WeChat mini-game adaptation & verification

The WeChat mini-game is the most constrained target: **no DOM, no full window/document, no eval**. Rendering dependencies and base-library versions must be verified explicitly.

> **Status (2026-08-25): real art loads here — and the game still does not RUN here.** Read
> both halves of that sentence.
>
> The asset half is done and verified against the real base library in the simulator: both
> entries call the same `render/preloadArt.ts`, `client/public` is mirrored into
> `platforms/wechat` by package, the main package sits at **3.31 MB / 4.00 MB** with four
> subpackages, and every registered texture of every loader resolves (checklist item 9).
> `wx.loadSubpackage` works, and the runtime reports WebGL2.
>
> The game half does not. Boot finishes `preloadCoreArt()` and never reaches the first line
> of `Game.start()` — see checklist item 10. So "real art loads" means resources arrive, NOT
> that anything is playable on this target yet. Until item 10 is closed, this platform is not
> shippable and no frame-rate or touch verification below it is even reachable.
>
> See **Asset loading** for the three mechanisms and **Verification** for exactly what is and
> is not proven.
>
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

Adapter surface actually implemented: `createCanvas` (→ `wx.createCanvas()`),
`createImage` (→ `wx.createImage()` — this is the WHOLE image path, see below), the
WebGL1 / 2D context constructor probes (for WebGL1-vs-2 detection and text metrics), and
stubs for `fetch`/`parseXML`/fonts.

`fetch` stays unimplemented on purpose, and an earlier version of this doc was wrong about
why it mattered. It said to "extend `fetch` if Assets are introduced later" — but when
Assets were introduced, nothing reached it. Pixi's texture parser only calls `fetch` on its
`createImageBitmap` path; with no `globalThis.createImageBitmap` (this runtime has none) it
takes the `DOMAdapter.createImage()` branch instead
(`pixi.js/lib/assets/loader/parsers/textures/loadTextures.mjs`), which needs no network
primitive at all. Anything that does land in `fetch` is asking for a REMOTE asset, which is
a bundle-boundary decision (`client/src/render/assetPacks.json`), not a loader detail — so
it should keep failing loudly rather than become a half-working `wx.request` shim.

## Version-selection principle (important)

- Use Pixi **v8**; do not upgrade blindly. Pick a version tested to run every asset-loading path on the **lowest target base library**, then pin it (lockfile).
- The main pitfalls are in the **asset/texture loaders'** differing reliance on `Image` / `ImageBitmap` → must be verified on a real device, not from docs. Real assets landed 2026-08-25, so this is live now rather than hypothetical: the exact device-dependent assumption is that `wx.createImage()` populates `width`/`height` before firing `onload`, and that `FileSystemManager.readFileSync(path, 'utf8')` returns a string on the lowest target base library. `wechatAssetLoad.test.ts` proves everything ABOVE those two facts; only a device or the simulator can prove the facts themselves.

## Build & run

`npm run build:wechat` (in `client/`) does everything:

1. `tsc --noEmit` typecheck, then a vite **lib build** (`vite.wechat.config.js`) of
   `src/main.wechat.ts` → a single self-contained **IIFE** at `client/wechat/js/game.js`
   (`inlineDynamicImports` → one file, no ESM `import`/`export`, no chunks — the WeChat
   runtime loads it via `require`).
2. The **WebGPU renderer is stripped** by a `strip-webgpu` plugin (stubs
   `gpu/WebGPURenderer.mjs`, whose subtree then tree-shakes away; `preference:'webgl'`
   means it never runs anyway).
3. A `copy-to-platform` plugin syncs `game.js` / `js/game.js` into **`platforms/wechat/`**
   — the project WeChat DevTools opens. Its `project.config.json` (with the real appid) is
   left untouched.
4. The same plugin then mirrors `client/public` into `platforms/wechat/` by package
   (`build/wechatAssetSync.mjs`) and GENERATES `game.json` — generated rather than copied
   because a second asset pack has to appear in it as a `subpackages` entry. The mirror
   prunes: a texture deleted or renamed in `client/public` is removed from the package
   instead of quietly continuing to cost bytes.

`npm run check:wechatpackage` (repo root, also folded into `npm run check`) is the byte
gate — see **Package budget** below. It reads `client/public` and the pack table directly,
so it is meaningful without running a build first, which is the point: art lands in the
repo long before anyone runs `build:wechat`, and that is when the budget should be checked.

Project shape reference: a WeChat mini-game needs `game.js` (entry, just
`require('./js/game.js')` — no weapp-adapter), `game.json`, and `project.config.json`.
Core logic is reused from `src/game`; only the entry and platform layer differ.

## Asset loading

Two mechanisms, because a mini-game has neither `fetch` nor `createImageBitmap`, and the
two halves of a shipped bundle need different answers. Both sit behind one seam,
`client/src/render/assetHost.ts`, whose web implementation is the identity function — so
the five loaders (`taoBundle` / `biomeTiles` / `uiSkins` / `environmentSprites` /
`weaponSkins`) kept their public shape exactly, and nothing at any call site changed.

| What | Web | WeChat |
|---|---|---|
| PNG | `Assets.load` → `createImageBitmap` | `Assets.load` → `DOMAdapter.createImage()` → `wx.createImage()`, `src` = a package-relative path |
| JSON sidecar (`animation.json`, `frames.json`) | global `fetch` | `wx.getFileSystemManager().readFileSync(path, 'utf8')` |
| Path form | `/skins/orb-core/eye.png` | `skins/orb-core/eye.png`, or `packs/<pack>/skins/...` for a subpackaged asset (`packedPathFor`, `assetManifest.ts`) |
| Subpackage | nothing to do — files are served | `wx.loadSubpackage`, via `packLoader.ts`, BEFORE any load that reads out of one |
| `Assets.init` | default | `{ skipDetections: true }` |

Three things worth keeping:

- **The image path never needed `fetch`.** See the adapter section above. `taoBundle.ts`'s
  two JSON reads — which used the GLOBAL `fetch`, not even the adapter's — were the only
  genuine blocker.
- **`Assets.init` must skip format detection.** Pixi's video-format probes call
  `document.createElement('video')`, and `Assets` sets its `_initialized` flag BEFORE
  running them. So on this runtime the default `init` throws, every concurrent load races
  past the flag, and the symptom is not a crash but exactly ONE arbitrary texture missing —
  whichever load happened to be first. `preloadCoreArt()` therefore calls `Assets.init`
  explicitly, with the host's options, before the first load. Found by
  `wechatAssetLoad.test.ts` on its first run, before any device saw it.
- **`getBaseUrl` returning `''`** is what lets a package-relative path survive Pixi's
  resolver untouched.

## Package budget

WeChat's limits (official 分包 docs, re-checked 2026-08-25): **main package ≤ 4 MB**, a
standard subpackage has **no individual cap**, an *independent* subpackage ≤ 4 MB, and the
whole game ≤ **30 MB**. `design/ROADMAP`'s parked note recorded only the 4 MB figure, which
made the situation look more constrained than it is.

Where it stands after the 2026-08-25 downsampling pass: **main 3.31 MB / 4.00 MB**, of which
0.90 MB is `js/game.js`, plus four subpackages totalling 0.64 MB (3.95 MB for the whole game
against the 30 MB ceiling). `client/public` went from **13.66 MB to 3.20 MB** — and the
dominant cause was never the missing atlas packer `12` had queued, it was source art
shipped at authoring resolution. `orb-core`'s four bone textures were 1254² while the two
sibling characters on the same rig had been 256² for months (a 30× difference per file),
and six byte-identical 650 KB `socket_*.png` copies accounted for 3.9 MB on their own.
Atlas packing would have saved almost none of that: merging RGBA PNGs does not remove
pixels. It remains worth doing for draw calls, not for bytes.

The gate enforces RAW bytes deliberately. WeChat's docs state the 4 MB limit without saying
whether it is measured before or after the package is compressed; community write-ups say
after, and DevTools' upload dialog is the only authoritative answer. Until someone reads
that number, raw is the conservative direction — the gate prints the compressed estimate
(~3.31 MB) alongside it so the real headroom is visible without depending on the guess.

Bundle boundaries live in `client/src/render/assetPacks.json`, read by three consumers (the
runtime's `assetManifest.ts`, the build's `wechatAssetSync.mjs`, and the gate).

**What is deferred, and why exactly these.** Each subpackage holds art a fresh run cannot
reach, checked against the shipped content rather than assumed:

| Pack | Contents | Why it is unreachable |
|---|---|---|
| `biome-ice` / `biome-lightning` / `biome-poison` | that element's floor / wall / wallface swatch | `theme.ts`'s `BIOME_ID_TO_ELEMENT` maps the only authored dungeon (`ember`) to `fire`, and anything without a `dungeonConfig` (PvP, arena) falls to `neutral` |
| `boss` | `skins/boss-core` | `blightlord` is its only user and spawns on floor 5 |

Explicitly NOT deferred: `brute-core` and `floater-core`. Both `brute` and `floater` spawn on
**floor 1** (`world/dungeons/ember/ember_l1_floor_1.json`), so a pack holding them would be a
lie the moment anyone made it lazy. `assetManifest.test.ts` pins that.

**They all load at boot**, once, from `preloadCoreArt` (`render/packLoader.ts`). That is not
the same thing as leaving them in the main package: WeChat's 4 MB limit is a rule about the
FIRST download, so a subpackage satisfies it even when fetched moments later, and the game can
start rendering while the rest arrives. What it avoids is the cost of real laziness — an
`await` on the path into a room, and a frame where a biome has no stone. Making a pack
genuinely lazy later is `await ensurePack('biome-ice')` at the point of use plus dropping it
from the boot set; no loader, manifest entry or call site moves.

Every subpackage also gets a generated no-op `game.js` at its root. The 分包 docs describe
`root` as "a directory whose `game.js` is the entry file" and never document a resource-only
subpackage, so the entry is written rather than gambled on.

## WebGL1 degrades silently

`GlTextureSystem.mjs` gates mipmap generation on
`autoGenerateMipmaps && (supports.nonPowOf2mipmaps || isPowerOfTwo)` and forces clamp when
`!supports.nonPowOf2wrapping && !isPowerOfTwo` — and `GlContextSystem` sets both
`nonPowOf2*` flags to `isWebGl2`. So on a WebGL1-only device:

- every non-power-of-two texture **silently loses the mip chain it asked for**, which
  reproduces the 2026-08-12 "can't tell what this character is" colour-noise bug (`12`);
- every non-power-of-two texture that asked to **wrap is clamped**, which turns a tiling
  swatch into one tile plus a smear of its last column.

Neither logs nor throws. This is checklist item 4 below, restated as something concrete
rather than a device question. `texturePowerOfTwo.test.ts` pins the wrapping half: the ten
floor/wall swatches are 256² and safe, and the four `wallface_*` faces (256×125..127) are
recorded as a known gap — padding them to 256×128 is a one-row art change, but their crown
rows are measured against that exact height (`wallTone.ts`'s `FACE_CROWN_ROWS`), so it is
an art decision, not a packaging side effect. The mipmap half is deliberately not pinned by
a count: essentially all sprite art is non-power-of-two, and changing that means padding
every file and moving every anchor with it.

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
> screenshot + log based, not programmatic — and it needs the simulator installed, which
> it is not on every machine (it was absent on 2026-08-25).

Because that method cannot run on a commit, the asset path is covered by a
**WeChat-shaped simulation suite** instead: `client/src/render/wechatAssetLoad.test.ts`
deletes `fetch` / `createImageBitmap` / `document` / `window` / `Image` / `XMLHttpRequest`,
installs a `wx` fake backed by the REAL shipped files, and runs the REAL `preloadCoreArt()`
through the real Pixi `Assets` pipeline and the real `WeChatAdapter`. The only fake is `wx`
itself. It pins: no loader touches a browser-only global; Pixi takes the `createImage`
branch; every path asked for is package-relative and names a real file; every registered key
of every loader resolves at the source art's real dimensions.

It cannot pin what the real base library does — that `wx.createImage()` fills `width`/
`height` before `onload`, that `readFileSync(..., 'utf8')` returns a string on the lowest
base library, or anything about uploading a wx `Image` to GL. Those stay below.

1. [x] Integrate the adapter; the `client` build boots in WeChat DevTools and renders the tilted-view scene. *(2026-07-07, base lib 3.15.2)*
2. [ ] Verify on the **lowest target base-library version** (not just the latest).
3. [ ] Real-device check: frame rate on low-end Android (target 30 vs 60 fps).
4. [ ] Verify WebGL2 availability; define a fallback path if unavailable. **See "WebGL1
   degrades silently" above** — the fallback already exists inside Pixi and is invisible;
   what is unknown is only whether any target device takes it.
5. [ ] Touch input on a real device (twin-stick logic is wired; feel needs hands-on).
6. [ ] Milestone 2: dynamic lighting (lightmap / normal maps) performance on the lowest base library + low-end devices.
7. [x] Real art loads at all, through the real loaders, in a runtime with none of the
   browser globals. *(2026-08-25, `wechatAssetLoad.test.ts` — simulation, not a device.)*
8. [x] The package fits: main 3.31 MB / 4.00 MB plus four subpackages, gated by
   `npm run check:wechatpackage`. *(2026-08-25)*
9. [x] **Real art loads in the real simulator.** *(2026-08-25, DevTools 2.01.2510280, appid
   `wx25a3b18a3e83ffce`.)* Everything item 7 could only simulate is now confirmed against the
   actual base library: 7/7 rig bundles, 5/5 biome element sets, 17/17 UI textures, 11/11
   environment sprites, 25/25 weapon textures plus both kind defaults — all at the exact
   post-downsampling dimensions. **`wx.loadSubpackage` works for real**: `boss-core` and the
   ice/lightning/poison swatches came out of subpackages. And the runtime reports
   **`webGLVersion: 2`** with `nonPowOf2mipmaps: true` / `nonPowOf2wrapping: true`, so the
   silent-degradation hazard above does not bite in the simulator (a low-end device is still
   unknown — that is item 3).
10. [ ] **`new Game(...)` does not survive this runtime.** Boot reaches the end of
   `preloadCoreArt()` and never reaches the first line of `Game.start()`; the only statement
   between them is the `Game` constructor, whose throw is swallowed by
   `boot().catch(reportWeChatBootFailure)` into a console message DevTools keeps off disk.
   Reproduced across two independent builds. NOT yet pinned to a line — a third instrumented
   run could not be landed because the simulator stopped reliably picking up new builds from
   `cli open` alone. **This is the next thing to chase, and it needs a dependable
   rebuild/reload loop first.** Prime suspect: `this.fx.attach()` compiles the
   post-processing shaders, and a shader that fails to compile paints nothing and throws
   nothing (the 2026-08-12 lesson in `12`).
11. [ ] DevTools' upload dialog still has to settle whether the 4 MB limit is measured raw or
   compressed (see **Package budget**).

**How to get diagnostics out of a mini-game at all.** There is no automation API worth the
name: `miniprogram-automator` *connects* to `cli auto --auto-port` (use `ws://127.0.0.1:…`,
not `localhost` — the port binds IPv6-only), but every method on it is 小程序-shaped
(`pageStack`, `navigateTo`, `currentPage`) and both `evaluate` and `screenshot` hang forever
against a GAME. What does work is making the game report on itself: write a JSON file to
`wx.env.USER_DATA_PATH`, which lands on disk under
`User Data/<profile>/WeappSimulator/WeappFileSystem/<openid>/<appid>/usr/` and can be read
from outside. Write the report BEFORE any step that might hang, and drop breadcrumbs at each
boot stage — a probe that only writes at the end cannot tell "boot failed" from "the last
call is unsupported here".

   *Status 2026-08-25:* DevTools is installed and `platforms/wechat` now carries a seeded
   `project.config.json`. Three gates were hit getting there, all worth writing down:

   - **Do not install the newest version winget offers.** `winget install
     Tencent.WeixinDevTools` gives `2.02.2608050`, whose **QR login is broken**: the scan
     completes (`[LoginState] qrcode-login-complete { hasUser: true, hasTicket: true,
     hasSignature: true }` in `WeappLog/logs`) but the second-stage `login update {…}` that
     commits the session never arrives, so WeChat says "登录成功" on the phone while the tool
     stays logged out. Only 游客模式 could log in. Pinning the previous major line —
     `winget install --id Tencent.WeixinDevTools --version 2.01.2510280 --force` — fixes it
     outright. Network, proxy, clock and multi-instance were all ruled out first; the
     `WeappLog/logs` `[LoginState]` sequence is what identifies it, since nothing is
     surfaced in the UI.
   - **The CLI needs 设置 → 安全设置 → 服务端口 switched ON**, once, by hand. That is a
     security setting, so it is a person's call, not something the build should flip.
   - **A mini-GAME project needs a real registered appid.** `touristappid` and an empty
     appid are both rejected by `cli open` with `不存在此 AppID (code 10)`, even from a
     logged-in session. `cli.bat` lands in `C:\Program Files (x86)\Tencent\微信web开发者工具\`.
