# UI, HUD & screen flow

The player-facing shell around the engine: the **HUD** during play, the **screens** that wrap a run (menu → loadout → in-match → result), and the **input surface** (twin-stick + corner buttons) that turns touches/keys into the engine's `PlayerCommand`. It builds on the all-Pixi UI decision (`00`), the `ui` render layer (`01`), the controls/orientation lock (`05`), the WeChat input+text constraints (`04`), and the engine↔render split (`06`/`08`). This doc is the source of truth for **what UI exists, how it reads engine state without touching it, and how input becomes a command**.

## The decisions (locked)

- **UI is drawn with Pixi, no DOM.** Every screen, HUD element, stick, and button is a Pixi `Container`/`Graphics`/`Text` in the `ui` layer (`00`, `01`). No HTML overlay — it would not exist on WeChat (`04`) and would split the render path. One engine, one renderer, one UI toolkit.
- **UI reads `state` + `events`, never mutates the engine.** The HUD renders from `GameState` (hp, weapon, enemy count, phase) and the per-frame `events` queue (`08`: `hit`, `deflect`, `death`, `pickup`) for transient feedback. It is downstream of the engine exactly like the render layer (`06`'s day-one split). The **only** channel UI→engine is a `PlayerCommand` submitted through the `InputSource` (`08`).
- **Input is quantized to a command at the UI edge.** Sticks/mouse/buttons are sampled each frame and converted to `moveBrad/moveMag`, `aimBrad`, and a `buttons` bitfield **before** they reach the engine (`08`'s `PlayerCommand`, `06`'s "quantize at the input edge"). The engine never sees a screen pixel or a float angle. This is what keeps local play and net play on one code path.
- **Landscape-only, twin-stick + corner buttons.** Left stick moves, right stick aims + fires; corner buttons are weapon-1 / weapon-2 (`05`, `04`). There is no jump or block button — parry is the melee swing (right stick). The layout assumes horizontal space and `deviceOrientation:"landscape"` (`05`). Portrait is dropped.
- **A screen state machine wraps the engine; the engine only knows `phase`.** `GameState.phase` is just `idle | playing | gameover` (`08`). Everything around a match — main menu, loadout/preset pick (`05`, `09`), pause, result/summary, restart — lives in a **render-side `ScreenManager`**, not in the engine. The engine is a pure match simulator; the shell decides which match to start and what to show before/after.

## Screen flow (the MVP shell)

The minimal loop a player can complete start-to-finish. This is the part the current vertical slice (`Game.ts`) is missing — it drops you straight into a scene with no way to win or restart except refresh.

```
 Boot / splash
   → Main menu            (Play PvE · [later] Arena · settings)
   → Loadout / preset     PvE: pick persistent base loadout (05/09)
                          PvP: pick a balanced arena preset (05)
   → In-match             HUD + controls; engine phase = playing
        ├─ Pause          overlay; engine keeps last state, no ticks advance
        └─ (net) waiting   "waiting for players / reconnecting" (06 stall)
   → Result               clear / death / (PvP) win-loss  → summary
   → back to menu or "run again" (re-seed, rebuild state)
```

- **`ScreenManager`** is a small render-side state machine (`enum Screen`, one active `Container` per screen, swap on transition). It owns the `GameEngine` lifecycle: constructs it with `(config, seed, input)` on match start, tears it down on result. It is *not* deterministic and carries no gameplay — safe to hold Pixi objects, timers, wall-clock.
- **Result → restart** is just "build a fresh `GameState` from a new seed and re-enter `playing`." Because a run is `seed + config + input stream` (`08`), restart needs nothing persisted from the old match except meta progression (server-authoritative, `05`/`09`).
- **Pause** (single-player only) stops calling `engine.tick()`; the last state stays on screen. In co-op/PvP there is no true pause — the frame stream keeps coming (`06`); the shell shows a non-blocking overlay instead.

## HUD (in-match)

Lives in the `ui` layer (`01`, topmost). Renders each frame from `state` + `events`. Current slice shows a monospace `Text` blob (`Game.ts:buildHud`); the real HUD is composed widgets:

| Element | Source | Notes |
|---|---|---|
| Health | `player.hp / maxHp` | Hearts or a bar; flash/shake on `hp_changed`/`hit` events (`07`) |
| Equipped weapon + slot | `player.weapon` (`02`) | Icon + name; the two slots from `05`'s corner buttons; cooldown sweep from `weapon.cooldownTicks` (`08`) |
| Ammo / charge (if any) | weapon spec (`03`/`09`) | Only for weapons that have it |
| Crosshair / aim indicator | current `aimBrad` | On the `ui` layer per `01`; on touch it tracks the right stick, on web the mouse |
| Swing / parry flash | `deflect` event (`08`) | Transient — a melee swing that deflected a bullet; no persistent "block" state exists (`05`) |
| Minimap / room progress | `room` + cleared count (`05`/`09`) | PvE run structure; post-MVP polish |
| Pickup / buff toast | `pickup` event (`08`) | Transient "picked up X"; drives the roguelite build feedback — weapons + run buffs, no affixes (`05`/`14`) |
| Score / timer / team | `state` (PvP) | Elimination/score win condition (`05` open question) |

- **Damage/feedback numbers, hit flashes, deflect sparks** are driven by the `events` queue (`08`), consumed once per render frame — same channel the fx layer uses (`01`). UI feedback and fx read the same events; neither writes back.
- **HUD never reads a weapon's internal cooldown by calling into engine logic** — it reads the plain `cooldownTicks` field off state and maps it to a 0..1 sweep. Presentation only.

## Controls & the input→command boundary

The concrete shape of `05`/`04`'s twin-stick, and where `08`'s `PlayerCommand` is assembled.

- **Two virtual sticks + corner buttons** (touch), or **WASD + mouse + keys** (web). Both feed one `readController()` that returns a normalized frame: `{ moveDir, moveMag, aimDir/aimPoint, fire, swap, interact }` (no `block`/`jump` — parry is the melee swing, jump removed).
- **Quantization happens here, once:** `moveDir → moveBrad`, `moveMag → 0..255`, `aimPoint`(web, screen)→world→`aimBrad` or `aimDir`(stick)→`aimBrad`; buttons packed into the `buttons` bitfield (`08`). The result is a `PlayerCommand` submitted via `input.submit(cmd)` for the current tick. **After this line there are no floats and no pixels.**
- **Aim modes unified:** mouse gives a screen `point` (convert against camera offset, as `Game.ts:updatePlayer` already does), joystick gives a `dir`; both collapse to a single `aimBrad` so the engine has one aim input (`04`/`05`). An idle right-stick keeps last facing (already the slice's behavior) — encode that as the idle-hold default (`08`).
- **Discrete actions are edge-detected in the engine**, not fired from the UI: the UI only reports the current button *level* in `buttons`; the engine compares against last tick to detect a tap (`08`). So "tap to swap weapon / interact" needs no special UI event — just set the bit while held.
- **Web vs WeChat** differ only in how `readController()` gathers raw input (`WebPlatform` keyboard+mouse vs `WeChatInput` touch sticks, `04`); the quantization and command assembly are shared.

## Layout, orientation & safe areas

- **Landscape, anchored corners.** Sticks bottom-left / bottom-right, action buttons clustered by the right stick (thumb reach), HUD status top-left, score/timer top-center (`05`). Everything positions relative to screen edges, re-laid-out on resize.
- **Safe-area insets.** WeChat and notched phones report insets (`wx.getWindowInfo` safe area; web `env(safe-area-inset-*)` is unavailable inside canvas — read from the platform layer). UI anchors respect them so sticks/buttons aren't under a notch or the WeChat capsule menu (top-right — keep that corner clear).
- **Resolution independence.** UI uses the same world/screen scaling as the renderer; size widgets in logical units and scale with `renderer.resolution` so touch targets stay thumb-sized on high-DPI phones.

## WeChat / rendering constraints (from `04`)

- **`Text` rasterization** goes through the adapter's `createCanvas` → `wx.createCanvas()` (`04`). Fine for HUD labels; **prebake or limit dynamic text** — re-rasterizing large changing strings every frame is a known cost. Prefer sprite-based numbers for fast-changing values (damage, ammo) over live `Text`.
- **No DOM widgets, no eval** (`04`): buttons/sticks are Pixi hit-areas with `eventMode:'static'`, not HTML. Any procedural texture uses Pixi `Graphics`, never `document.createElement('canvas')`.
- **One canvas / WebGL** (`04`): UI shares the single renderer; no second context for an overlay.

## Relationship to the other docs

- **`00`/`01`:** all-Pixi UI, `ui` layer topmost. This doc fills in what lives there.
- **`04`:** WeChat input (virtual twin-stick) and `Text` constraints; this doc is the cross-platform UI form of it.
- **`05`:** controls, landscape lock, the run loop the screen flow wraps, preset/loadout pick.
- **`06`/`08`:** the engine↔render split and `PlayerCommand`; UI is strictly downstream + the one command channel. Pause/stall behavior follows `06`.
- **`09`:** weapon/preset/rarity data the loadout screen and HUD icons read.

## To design

- **Widget kit:** a minimal Pixi UI component set (button, stick, bar, toast, panel) — build vs. a tiny in-house layer. Keep it small; no heavy UI framework (bundle + WeChat).
- **HUD data contract:** the exact read-only view of `GameState` the HUD needs, so it never reaches into engine internals (mirror `08`'s interpolation-snapshot idea for UI).
- **Loadout/preset screen data** — the crafted loadout + chosen character (`14`) / `ARENA_PRESETS` (`09`); how much detail (stats, previews) to show.
- **Settings** (volume once audio lands `11`, control layout/left-handed mirror, quality tier per `01` roadmap).
- **Result/summary content:** what a run summary shows (drops collected, rooms cleared, time) — ties to `05`'s reward structure.

## Open questions

- **Damage/feedback numbers as `Text` vs sprite atlas** on WeChat — measure re-rasterization cost on the lowest base library (`04`) before choosing.
- **On-screen aim on touch:** free right-stick aim vs. aim-assist/snap to nearest (casual-first, `05`/`06`) — decide against real thumbs on a device (`04` checklist item 5).
- **Pause semantics in co-op:** is there any local "menu" that must not stall the frame stream, or is everything a non-blocking overlay (`06`)? Confirm when the net path lands.
- **Button count vs. clutter:** four corner buttons + two sticks is already busy in landscape; does weapon-swap need two dedicated slots or one toggle? Affects `05`'s control scheme and the `buttons` bitfield (`08`).
- **HUD for spectators / downed co-op players** (revive UI) — tied to `05`'s open death/penalty question.
