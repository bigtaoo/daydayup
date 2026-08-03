# DayDayUp Client

Single-engine PixiJS v8 client — the render/host half of the game. It owns screens, input,
scene views, audio and art; it owns **no** gameplay outcome (those all come from `@dd/engine`).
What it drives today: the full PvE run loop (menu → loadout → generated floors → checkpoint →
extract or descend → result), online co-op, 8-player PvP with squads, accounts, and an
8-locale i18n system (English canonical + 中文/Deutsch/Français/Español/Polski/Русский/Italiano)
with first-boot browser-language auto-detection.

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
| `WASD` / arrows | Move — the **body** faces the movement direction |
| Mouse | Aim — the **weapon** points at the cursor, independently of the body |
| Left click | Fire / swing (depends on the equipped weapon) |
| `1` / `2` | Switch to weapon slot 1 / 2 |
| `E` or `Space` | Interact: pick up / swap the weapon under you, hold to revive a downed ally |
| `Escape` or `P` | Pause (offline play only — an online match cannot stop the frame stream) |
| `O` | Settings (`Escape`/`O` closes it again) |

There is no block button and no jump: a melee **swing** parries bullets inside its own arc
(`design/03`), and jump was removed from the sim — actor `z` is a render offset only.

**Touch (mobile browser, Capacitor, WeChat):** virtual twin-stick — left half moves, right
half aims + fires; two corner buttons for weapon 1 / 2. Hit-test geometry lives in
`src/platform/TouchControls.ts` so every touch target behaves identically, and
`src/game/ui/TouchControlsView.ts` draws it, latched on the first touch so a mouse player
never sees it. Not there yet: an on-screen INTERACT control, and any verification of how this
feels under real thumbs on a real device (`design/04`).

## What the render layer is responsible for

- Tilted-view scene + **Y-sort depth occlusion** (walking in front of / behind a pillar occludes correctly)
- **Height / shadow separation** — the `z`/shadow split the tilted view needs, kept in the render layer where a future hop or blink would live
- **Actor / Skin / Weapon three-layer structure** (see `design/02-entity-model.md`)
- **Upper/lower body split** — body faces movement, weapon tracks aim, both driven off one engine actor
- `.tao` **rig playback** (`src/render/`) with per-character atlases and weapon sprites mounted on the rig's sockets
- Additive-blend fx layer (muzzle / deflect flashes), post-processing and particles, WeChat-safe rendering path

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
│  ├─ ui/             HUD + widget kit (HudView composing PlayerCard/WeaponCard/
│  │                  StatChip/FloorProgress/Minimap, plus the shared widgets)
│  │                  — pure-math modules sit beside their views so they stay testable
│  │                  without a canvas (textWidth is the only sizing input the HUD
│  │                  has; nothing here may call Text.width/getBounds)
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
