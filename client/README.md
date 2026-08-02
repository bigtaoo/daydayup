# DayDayUp Client

Single-engine PixiJS v8 client. Currently a **vertical slice** that validates the core architecture and gameplay.

## Run (Web)

This is one package of a root npm workspace — install at the repo root, not here.

```bash
npm install        # from the repo root
npm run dev -w client        # open http://localhost:5173
```

## Controls

**Desktop (keyboard + mouse):**

| Input | Action |
|-------|--------|
| `WASD` / arrows | Move |
| Mouse | Aim (character faces the cursor) |
| Left click | Fire / swing (depends on the equipped weapon) |
| `1` | Switch to ranged gun |
| `2` | Switch to melee sword |
| Right click / `Shift` (with sword) | **Block**: deflect enemy bullets back at enemies |
| `Space` | Jump (demonstrates height / shadow separation) |

**Touch (mobile browser, Capacitor, WeChat):** virtual twin-stick — left half moves,
right half aims + fires; corner buttons for jump / block / weapon 1 / weapon 2. Shared
logic in `src/platform/TouchControls.ts`, so all touch targets behave identically.

## What the demo validates

- Tilted-view scene + **Y-sort depth occlusion** (walking in front of / behind a pillar occludes correctly)
- **Height / shadow separation** (jumping lifts the character while the shadow stays on the ground and shrinks)
- **Actor / Skin / Weapon three-layer structure** (see `design/02-entity-model.md`)
- **Weapon-swap system** + **melee block/deflect** (the core fun, see `design/03-weapon-system.md`)
- Weapon positioning by facing with local z-order switching
- Additive-blend fx layer (muzzle / deflect flashes), WeChat-safe rendering path (pure Graphics, no canvas2D dependency)

## Layout

Gameplay outcomes are decided by `@dd/engine` (the repo-root `engine/` package), never
here. Everything below is the **render/host** half: it reads authoritative engine state
and produces input, and nothing else (`design/06`/`design/08`).

```
src/
├─ main.ts            Web entry (WebPlatform → Game)
├─ main.wechat.ts     WeChat entry (WeChatPlatform → Game); loaded by ../wechat/game.js
├─ game/
│  ├─ Game.ts         assembly, main loop, phase orchestration
│  ├─ phase.ts        the Phase union — shared vocabulary of Game and the screens
│  ├─ theme.ts        render palette (NOT gameplay tuning — that's the engine)
│  ├─ score.ts        the run's score table (host-side, never simulated)
│  ├─ coords.ts       the one place engine fp/brad becomes screen px/radians
│  ├─ scene/          world views mirroring engine state (Scene, Entity, Actor, Enemy,
│  │                  Bullet, Pickup, Portal, Backdrop, Skin, RoomBuilder, layers)
│  ├─ screens/        full-screen flow (MainMenu, Forge, Login, Party, Pause, Settings,
│  │                  Screens, confirmEdge)
│  ├─ controllers/    input → PlayerCommand and engine events → host callbacks
│  │                  (CommandBuilder, Ally/PvpBot controllers, LocalPredictor,
│  │                  EventReactor, RunOutcome)
│  ├─ match/          how a run is configured and connected (arenaCatalog, matchConfig,
│  │                  offlineConfig, pvpConfig, onlineConnect, gameQueryParams)
│  ├─ ui/             HUD + widget kit (HudView, widgets, Minimap, FloorProgress, …)
│  │                  — pure-math modules sit beside their views so they stay testable
│  │                  without a canvas
│  └─ fx/             FxController, particles, filters
├─ render/            skin/rig/atlas infrastructure (.tao runtime, weapon + UI skins)
├─ net/               transport, CoopSession, matchmaking, party, auth, session
├─ meta/              persistent forge/blueprint state
├─ settings/          persisted user settings
├─ i18n/              English-canonical t() + locales
└─ platform/          platform isolation: canvas, Pixi Application, input, lifecycle
   ├─ types.ts        Platform / InputSource / InputState interfaces
   ├─ TouchControls.ts  shared virtual twin-stick (used by both web and wechat)
   ├─ web/            WebPlatform + WebInput (keyboard + mouse, and touch)
   └─ wechat/         WeChatPlatform + WeChatAdapter + WeChatInput (wx canvas + touch)

sim/                  offline harnesses (PvP balance sim). Outside src/ on purpose:
                      nothing shipped can import them.
```

`Game` takes a `Platform`-provided `InputSource`; it never references `window`,
`document`, or a device directly. Aim is abstracted as either a screen `point`
(mouse) or a `dir` (virtual joystick) so both control schemes reuse the same loop.

## Cross-platform builds

One PixiJS codebase, per-platform entry + platform layer. All share `src/game`.

| Target | Command | Notes |
|--------|---------|-------|
| Web (dev) | `npm run dev` | http://localhost:5173 |
| Web (prod) | `npm run build` | → `dist/` |
| WeChat mini-game | `npm run build:wechat` | bundles + syncs into `../platforms/wechat/`; open that in WeChat DevTools. **Boot + render verified** (see `../design/04-wechat.md`) |
| Android | `npm run cap:add:android` then `npm run cap:sync` / `cap:open:android` | opens in Android Studio to build the APK (needs Android SDK) |
| iOS | `npm run cap:add:ios` then `cap:open:ios` | opens in Xcode (macOS only) |

Capacitor (`capacitor.config.ts`) wraps the `dist/` web build in a native webview;
touch input already works there. Native projects (`android/`, `ios/`) are generated on
demand and git-ignored. Desktop (Windows/macOS) can later use the community Electron
target; the web build itself already runs on desktop browsers.
