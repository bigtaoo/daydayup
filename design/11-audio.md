# Audio: SFX, music & the engine→sound channel

How the game sounds, and — more importantly for a deterministic-lockstep title — **how audio stays entirely outside the simulation**. Audio is a *consumer* of the engine's per-frame `events` queue (`08`), exactly like the render/fx layer (`01`) and the animation runtime (`12`): it reads what already happened and plays a sound. It **never** feeds `GameState`, never advances a tick, never gates an outcome. This doc is the source of truth for **what makes sound, what event triggers it, how it loads, and the WeChat audio constraints** (`04`).

> **Status (2026-07-23): the event→sound seam + a placeholder web backend ship; real assets + the WeChat backend do not.** The `AudioBus` platform seam (`platform/types.ts`), a **synthesised** web backend (`platform/web/WebAudio.ts` — every cue is generated live with WebAudio, no asset files, no licensing), and the render-side event→cue map with per-frame coalescing (`Game.consumeEvents`) are built and wired on both entries. WeChat is a documented **no-op stub** (`platform/wechat/WeChatAudio.ts`) — real WeChat audio needs authored assets + on-device verification (below), so it is intentionally left for the owner. No music/ambience yet. This doc is still the source of truth for the full pipeline; what's shipped is the placeholder slice that proves it.

## The decisions (locked)

- **Audio is pure presentation — the same day-one rule as art (`06`/`12`).** Sound is driven by the engine `events` queue and by UI state; it writes back **nothing**. Two clients running different volume, muted, or a different audio quality tier stay byte-identical in simulation (`06`). A `hit` event *triggers* an impact sound, but the engine already decided the hit (`08`'s "events are the only engine→render channel").
- **Render-clock, not sim-clock.** Audio plays on wall-clock/display time and is scheduled the render frame an event is consumed — never on the 30 Hz tick (`08`). It holds no authoritative data, so it may lag, drop, or coalesce freely without affecting the match.
- **One closed trigger vocabulary, shared with fx/animation (`12`).** Sound cues key off the **same** small event-tag set the fx layer and animation use (`08`/`12`): `muzzle`, `impact`, `deflect`, `shield-break`, `death`, `pickup`, `footstep`, … Audio adds no private engine hooks — if a moment needs a sound, it needs an event, and that event already exists for fx.
- **Two buses + settings volume (`10`).** A **SFX** bus and a **music/ambience** bus, each with an independent volume (and master) surfaced in `10`'s settings screen. Muting is a render-side gain change, never a sim change.
- **Concurrency-capped, priority-mixed.** A bullet-hell emits far more events than a phone can voice. Cap simultaneous SFX voices; when over budget, **coalesce identical cues in the same frame** (ten `hit`s this frame → one impact at higher gain, not ten) and drop by a per-cue priority (player damage > enemy death > distant bullet). This also absorbs the catch-up multiplier's multi-step frames (`08`, below).
- **No audio in prediction-replayed frames (`06`).** Client-side prediction re-simulates the local player and *replays* recent ticks on reconcile (`06`). Those replayed ticks re-emit events — audio must fire a cue **once per real occurrence**, not again on every rollback. Play SFX only from **newly-confirmed / first-seen** events (dedupe by `(tick, event-seq)`), so a corrected prediction never double-triggers a sound.
- **WeChat: `InnerAudioContext` via the platform adapter — no `Audio` element (`04`).** WeChat provides no DOM `Audio`; sound goes through `wx.createInnerAudioContext()` (and `wx.createWebAudioContext()` where available), wrapped behind the same `platform/` seam as canvas/input (`04`). Web uses WebAudio. The engine/game core never calls either directly.

## The event → sound map

Audio subscribes to the per-frame `events` union (`08`) and maps each to a cue. Cues are **data** (an id + gain/priority/variation-count), never inline code — same discipline as content (`09`). Sketch:

| Engine event (`07`/`08`) | Cue | Notes |
|---|---|---|
| `bullet_fired` / `melee_swing` | `muzzle.<weaponFrame>` / `swing.<meleeFrame>` | per-frame variant (`03`); pitch-jitter by `combatPrng`? **No — render-side RNG only** (must not touch sim) |
| `hit` | `impact.<damageType>` | element-tinted layer (`03`/`13` colour law's audio cousin); coalesce per frame |
| `clash` | `clash` | two bullets annihilate |
| `deflect` | `deflect` | the parry — a signature, satisfying cue (pivot mechanic, `03`/`05`); should read clearly over the mix |
| `shield_break` | `shield-break` | shield→0; pairs with the character break-passive fx (`02`/`07`) |
| `status` | `status.<burn/chill/chain/poison>` | on-apply sting; the *lingering* aura loop is optional ambience, low gain |
| `knockback` | (usually silent / folded into `impact`) | avoid clutter |
| `death` | `death.<enemy/player>` | boss death = a distinct stinger |
| `downed` / `revive_progress` / `revived` | `downed` / `revive-loop` / `revived` | co-op feedback (`05`/`07`); revive-loop is a sustained cue while channelling |
| `pickup_spawned` / `pickup_taken` | `pickup.<weapon/heal/material/buff>` | material bank vs weapon swap read differently (`05`) |
| `hp_changed` / `shield_changed` | (UI feedback only, `10`) | low-frequency; often no dedicated SFX |

UI-side cues (button tap, screen transition, extract/descend commit, result screen) come from `10`'s `ScreenManager`, not the engine — they are wall-clock UI events, not sim events.

## Music & ambience

- **Biome themes.** One loop per elemental biome (`05`/`13`), lazy-loaded with that biome's asset bundle (`12`). Cross-fade on floor transition.
- **Boss stinger + combat layer.** Entering the boss room (`blightlord`, `09`) swaps to a boss track; an optional intensity layer can rise with on-screen enemy count read from `state` (render-side, no sim read-back).
- **Outpost / menu.** A calm hub loop for the forge outpost (`14`/`13`) and menus (`10`).
- **Ambience per biome** — low crystal hum / blight drone, desaturated to match the "environment desaturated, hazards saturated" law (`13`): the world bed stays quiet so combat cues pop.
- Music is **not** determinism-relevant, so it may use free wall-clock timing, dynamic mixing, and any RNG.

## WeChat audio constraints (from `04`)

- **`InnerAudioContext` per sound / a small pool.** Creating one context per SFX is costly; keep a **pool of reusable contexts** for short SFX and a couple of long-lived contexts for music/ambience. `wx.createWebAudioContext()` (if present on the target base library) gives lower-latency mixing for SFX — verify availability on the **lowest** base library (`04`), fall back to `InnerAudioContext`.
- **Format & size.** Prefer **mp3** (universally decoded); watch total package size against WeChat's main/sub-package limits (`04`) — audio is heavy, so biome tracks belong in **lazy sub-packages / downloaded bundles** (`12`), not the boot core.
- **Decode/latency.** First play of a clip may stall on decode; **preload** the core SFX set at boot. Expect higher input-to-sound latency than web — the deflect/hit cues must still feel tight, so keep those clips tiny and pre-decoded.
- **No `eval`, no DOM (`04`).** Nothing here uses `new Function`/`document`; the adapter surface is `wx.createInnerAudioContext` / `wx.createWebAudioContext` only.
- **Focus/blur & interruption.** Pause/duck music on `wx.onAudioInterruptionBegin` / hide, resume on end/show — and mirror it on web (`visibilitychange`). This is a `ScreenManager` concern (`10`), not the engine's.

## Asset pipeline & loading (with `12`)

- **Loaded through the same manifest/bundle system as art (`12`).** A **core audio bundle** (UI, common combat SFX, menu music) preloads at boot; **per-biome music/ambience + enemy-specific SFX** lazy-load with that biome's bundle between rooms (`05`/`12`), keeping the initial download small.
- **Stable ids, not filenames (`12`).** Cue ids (`impact.fire`, `deflect`, `music.biome.ice`) are the contract; the manifest maps ids→files so renaming a source asset never breaks a trigger.
- **Fetched vs bundled — audio is determinism-safe either way** (it never feeds the sim, `06`/`12`), so remote-downloaded audio does **not** touch the `ENGINE_VERSION`/replay guarantee (unlike fetched *config*, `09`). It still counts against package/download budget.

## Determinism & netcode (with `06`/`08`)

- **Audio reads the per-frame event union (`08`).** A catch-up render frame that ran ≥2 sim steps unions every step's events; audio must **coalesce** (above) rather than machine-gun the same cue N times. A 0-step frame has no new events → nothing plays.
- **Prediction reconcile (`06`).** Fire each cue once per confirmed occurrence; suppress re-emission during a rollback-replay (dedupe key above). Optionally, the local player's *own* fire/swing may play immediately on the predicted frame for feel, but then must be suppressed when that same tick is confirmed — pick one path per cue and document it, so a mispredict never doubles or drops the sound jarringly.
- **No RNG leak.** Any pitch/variant randomisation uses a **render-side** RNG, never the sim's injected `Prng` (`06`) — drawing from a sim PRNG for a sound would perturb the stream and desync.

## Settings & UX (with `10`)

- Master / SFX / music volume sliders + mute in `10`'s settings screen; persisted client-side (not sim state).
- Audio is optional and mobile-muted-by-default is common — the game must be **fully playable silent** (all critical feedback also has a visual channel: fx `01`, HUD `10`). Sound is juice, never the only signal.

## Relationship to the other docs

- **`08`:** the `events` queue is the single trigger source; audio is a downstream consumer like render, on the render clock.
- **`06`:** determinism — audio never feeds the sim; catch-up union + prediction-replay dedupe rules come from here.
- **`12`:** shares the asset manifest/bundle loader, the stable-id convention, and the closed event-tag vocabulary (animation events and sound cues fire off the same tags).
- **`04`:** WeChat `InnerAudioContext`/`WebAudioContext`, mp3/format, package-size, no-DOM/no-eval constraints.
- **`10`:** settings volume, focus/blur pause, and UI-originated cues (buttons, transitions, result).
- **`05`/`13`:** biome/boss/outpost structure the music follows; the "desaturated world, saturated hazards" law has an audio cousin (quiet bed, punchy combat).
- **`03`/`07`:** the cues per weapon frame / damage type / the signature deflect; the element colour law (`13`) extends to element-tinted `impact`/`status` sounds.

## To design

- **Cue catalogue** — the actual cue-id list + per-cue gain/priority/variation-count, authored as data (mirrors `09`'s content discipline). Where does it live — a `content/audio.ts` map, or the `12` manifest?
- **Music track list & transitions** — how many biome themes, boss/menu/outpost tracks, cross-fade rules, and the optional intensity layering source.
- **Voice-count budget & priority table** on WeChat low-end (`04`) — the concurrency cap and coalescing thresholds, measured on device.
- **Sourcing** — AI-generated vs. licensed library vs. commissioned, and the commercial-use licence check for a monetised title (`14`). See sourcing note below.
- **Placeholder audio** — a tiny free/procedural SFX set to wire the event→sound path early, swappable like the Graphics→atlas art placeholders (`12`).

## Open questions

- **`InnerAudioContext` pool size vs. latency** on the lowest base library (`04`) — is `wx.createWebAudioContext` reliable enough to prefer for SFX, or is the `InnerAudioContext` pool the safe floor?
- **Predicted-vs-confirmed cue policy** per cue (play-on-predict then suppress, or play-on-confirm only) — decide against real RTT (`06`).
- **Adaptive/interactive music** (intensity layers, stingers) vs. flat loops — worth the mixing complexity on WeChat, or ship flat loops first?
- **Total audio budget** against WeChat package limits (`04`) — how much goes in the boot core vs. lazy sub-packages, and what compression bitrate holds up.

## Sourcing audio (tools & libraries)

Practical note for producing the cue catalogue and tracks. **Verify the commercial-use / redistribution licence of anything used** — this is a monetised game (`14`), and "free for non-commercial" or "no redistribution inside an app" clauses are common. When in doubt, keep the licence text with the asset in the repo.

- **AI sound-effects:** *ElevenLabs* (text-to-SFX), *Optic/Stable Audio* and similar text-to-audio models — good for one-off impacts/whooshes; check the plan's commercial terms.
- **Procedural retro SFX (free, ideal for placeholders):** *jsfxr / sfxr / Bfxr / ChipTone* — generate 8-bit-ish shots/hits/pickups in-browser, export wav, MIT-ish/CC0; perfect for wiring the event path before final audio.
- **AI music:** *Suno* and *Udio* (song generation), or royalty-free-oriented *Soundraw / Mubert / AIVA* (built around clear commercial licensing). Read each service's license for in-game/redistribution rights before shipping.
- **Human-made libraries (not AI):** *Freesound* (CC — check per-clip licence, some require attribution), *Kenney.nl* (CC0 game assets, incl. audio — safest for commercial), *OpenGameArt* (mixed licences), or paid packs on *Humble/itch.io/GameDev Market*.

Recommendation: use **jsfxr/Kenney (CC0)** for placeholders now to prove the pipeline, then decide AI-generated vs. commissioned for the final pass once the cue catalogue is locked — the license check matters more than the source.
