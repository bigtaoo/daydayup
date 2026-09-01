# Audio: SFX, music & the engine→sound channel

How the game sounds, and — more importantly for a deterministic-lockstep title — **how audio stays entirely outside the simulation**. Audio is a *consumer* of the engine's per-frame `events` queue (`08`), exactly like the render/fx layer (`01`) and the animation runtime (`12`): it reads what already happened and plays a sound. It **never** feeds `GameState`, never advances a tick, never gates an outcome. This doc is the source of truth for **what makes sound, what event triggers it, how it loads, and the WeChat audio constraints** (`04`).

> **Status (current): every shipped sound in the game plays, on BOTH web and WeChat — cues, UI cues and music.** The dated `Update:` paragraphs below carry the history in order; this headline is the summary and is kept rewritten rather than appended to, because a stale first sentence under a stack of accurate updates is this repo's own named docs-drift failure mode.
>
> **Status (2026-08-28): the shipped SFX set is what plays, on BOTH web and WeChat.** The seam is unchanged — engine `events` → `controllers/EventReactor.ts` → the `AudioBus` platform seam (`platform/types.ts`) — and the procedural voice table (`platform/audioSynth.ts`) still ships. What changed is that a cue now resolves to a **shipped sample first**, and to its synth voice only as a fallback.
>
> The new module is `client/src/audio/`: **`cueCatalogue.ts`** (the catalogue — per-cue variant count, gain and priority, and the id→path rule), **`SampleBank.ts`** (fetch + decode, best-effort per file, through `render/assetHost.ts`'s new `readBinary` — the same platform seam the art loaders use, so audio inherits the design/12 bundle rules), **`decodeAudio.ts`** (one promise over two runtimes' `decodeAudioData` shapes), **`VoiceBudget.ts`** (the concurrency cap, priority-ranked) and **`CueMixer.ts`** (sample-or-synth, catalogue gain, coalesce gain, variant choice, pitch jitter). Both entries call `audio.preload()` at boot, fire-and-forget: 95 kB decodes long before the first shot, and until it lands the synth voices carry the mix. WeChat runs the identical module, reading bytes with `FileSystemManager.readFileSync` instead of `fetch`.
>
> **Measured in a real browser (2026-08-27), not assumed:** all **46 files fetched 200 and decoded** (15 cues / 46 variants). A 3-second firing burst in the tutorial produced **27 sample voices and 0 synth voices**, with 9 further cues dropped by the voice cap — all `muzzle`, the most expendable cue in the ladder. Peak PCM sampled on the SFX bus itself: **0.000** in silence, **0.067** for a `deflect` sample, **0.021** for the `status.burn` synth keep, and **0.092 → 0.136 (×1.49)** for one `impact` against ten coalesced into one — this doc's "higher gain, not ten cues", on the wire.
>
> **Update (2026-08-30): the UI now makes sound too.** Everything above is about cues the ENGINE causes; the four `ui.*` cues are the ones the player's own finger causes, and they close this doc's own "UI-side cues (button tap, screen transition, extract/descend commit, result screen) come from `10`'s ScreenManager, not the engine". `ui.tap` / `ui.back` / `ui.toggle` / `ui.denied` are ordinary members of `AudioCue`, so they inherit the catalogue, the voice cap, the mixer's sample-or-synth ladder and both backends unchanged — what differs is only who fires them (`client/src/audio/uiSound.ts`, a module sink attached at boot, instead of `EventReactor`). Four more CC0 files ship for them (**50 files, 101.9 kB**), cut from the same Kenney Interface Sounds pack `clash`/`status.chill`/`wave-clear` already came from. Measured in a real browser rather than assumed: 50/50 variants decoded, a real mouse click on SETTINGS produced **one decoded 43 ms voice and zero oscillators**, and peak PCM on the SFX bus reads **ui.tap 0.046, ui.back 0.045, ui.toggle 0.042, ui.denied 0.057** against **muzzle 0.055, pickup.heal 0.064, impact 0.091, deflect 0.111** — the UI sits at or below the quietest combat cue, which is the mix this doc asks for. The WeChat half is unverified on a device, like the rest of that platform's audio.
>
> **Update (2026-08-31, second pass the same day): MUSIC PLAYS.** The runtime landed on top of the assets. Two loops ship under `client/public/audio/music/` — `menu.mp3` (69.0 s, 511.8 kB) and `boss.mp3` (64.5 s, 603.4 kB), **1.09 MB** total — cut from two AI-generated masters (Suno) kept in `art/audio/sources/suno/` by `tools/audio-pipeline/process_music.py`, and they are now what a player hears. The new modules are `client/src/audio/musicCatalogue.ts` (an exhaustive `Record<MusicTrack, TrackDef>`, same discipline as the cue catalogue) and `client/src/audio/MusicPlayer.ts` (two decks, one equal-power crossfade, used both to change track and to CLOSE THE LOOP), with a deck per platform (`platform/web/webMusicDeck.ts`, `platform/wechat/weChatMusicDeck.ts`) and `client/src/game/musicDirector.ts` deriving the track from the situation every render frame. `setMusicVolume` is real in both backends, and the settings screen's music slider — which had always moved a number that went nowhere — now moves the music bus. See "The music runtime" below.
>
> **Update (2026-09-01): a test pass over the music work found a real bug in the thing all three asset gates trust.** Nothing about what plays changed; what changed is that the shipped-file parser is now itself under test. `audio/mp3Frames.ts` — the MPEG frame walker that tells `platform/audioAssets.test.ts`, `audio/musicAssets.test.ts` and one `musicPipeline` case what a shipped file *is* — had **no test of its own**, because every caller feeds it the 52 files that are already correct, leaving every rejection branch and the LAME delay/padding arithmetic unexercised. It turned out its header's claim that a truncated file "fails as itself" was **false**: constant-bitrate frames are fixed length, so a cut always leaves an intact header at the last boundary and the walk stepped past the end of the buffer counting the stub as a whole frame. Now caught, by a frame declaring more bytes than remain plus a trailing stub too short to be a header — after measuring that all 52 shipped files and both masters end on an exact frame boundary, so the strict rule rejects nothing real. A second fix in the same file: the frame-length guard is now `!(len > 4)` rather than `len <= 4`, because both reserved header indices together make the length `NaN` and `NaN <= 4` is false — the old form let NaN through to `i += NaN`, which ends the walk quietly and reports a duration divided by a zero sample rate. Two new suites came with it (`audio/mp3Frames.test.ts`, `platform/wechat/weChatMusicDeck.test.ts`) and two stale cases were replaced; see "What guards it" below.
>
> **Still open — and none of it is a wiring problem any more:** `dungeon.ember` has no master, so it plays `menu.mp3` as a declared placeholder (`TrackDef.borrowedFrom`); the WeChat path remains unverified on a real device, now including whether `InnerAudioContext` takes a subpackage path and which shape that runtime's `decodeAudioData` has; the voice cap (12) is a first pass rather than a measurement; **nobody has listened to the 50 cues or the 2 loops**; and the AI masters still have no archived licence text and no captured prompt (recorded as declared gaps in `credits.json`, gated as such). The cues were selected by measurement — fit against the synth voice each replaces — plus the material the world already specifies (`13`: crystal-mirror enemies, so glass). That rules out defects and matches loudness; it cannot say a sound is *right*, and the weakest pick on that basis is `win`. Now that everything actually plays, listening is the open item that a person, not a test, has to close. The game stays fully playable silent, so none of it blocks anything.

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

UI-side cues (button tap, screen transition, extract/descend commit, result screen) come from `10`'s `ScreenManager`, not the engine — they are wall-clock UI events, not sim events. **Built 2026-08-30 — see "The UI cues" below.**

## The cue catalogue & the loading path (built 2026-08-27)

The data half of "what does a cue sound like", and the reason the 46 shipped files went from staged to audible.

- **Where it lives: `client/src/audio/cueCatalogue.ts`**, not the design/12 asset manifest. The manifest answers a different question ("which WeChat package does this path belong to") and it answers it for audio already, by prefix rule, with no entry needed. What it cannot hold is the **mix** — per-cue gain, voice-cap priority, variant count — which are content decisions in `09`'s sense, so they get a content-shaped table.
- **An exhaustive `Record<AudioCue, CueDef>`.** Adding a cue to the union is a *compile* error until it has an audio decision. That one table replaced three hand-maintained copies of the cue list (it had been duplicated in `audioAssets.test.ts` and `audioSynth.test.ts`).
- **Variant COUNTS, not file lists.** `tools/audio-pipeline/` names files mechanically (`<stem>_NN.mp3`, stem = the cue id with `.` → `-`), so paths are generated. A literal list of 46 strings would be 46 chances to typo a name that fails *silently* — a missing file is indistinguishable from "no sample, use the synth". `cueCatalogue.test.ts` checks the generated set against both the directory listing and `credits.json`, in both directions.
- **The fallback ladder, in `CueMixer`:** a decoded sample if one exists → otherwise the synth voice. That second rung is permanent, not a shim: `status.burn` has no sample by decision, a cold boot fires cues before the preload resolves, and a failed fetch or decode lands there too. Both rungs pass through the same catalogue gain, so the swap never changes the weight of the mix.
- **Gain is the mix, and it applies to both rungs.** The shipped files were peak-matched to the synth voice each replaces, so `1.0` means "as loud as the placeholder was". `muzzle` sits at 0.8 (it fires on every shot), the status stings at 0.75 (this doc's "quiet bed, punchy combat"), and `deflect` is the one cue deliberately *above* its placeholder at 1.15 — the signature parry has to read over the mix. The synth path reaches the bus through a trim node when its gain is not exactly 1.
- **Coalescing now carries a COUNT.** `EventReactor` collects `Map<AudioCue, number>` rather than a `Set`, and the mixer turns it into a log-shaped gain boost (+0.15 per doubling, capped at ×1.5). Ten hits in a frame are one impact at higher gain — measured at ×1.49 on the bus.
- **The voice cap is real and priority-ranked** (`VoiceBudget`, 12 simultaneous sample voices). At the cap a cue only sounds if it *outranks* the weakest voice still playing, which is then stopped over a 12 ms fade rather than cut dead. Equal priority loses, so a stream of `muzzle`s does not chop itself up. Ladder: `win` (120, never stealable) > `wave-clear` > `deflect` (95) > `shield.break` > `pickup.*` > `death` (70) > `impact` (60) > `status.*` > `clash` > `muzzle` (20). Voices retire by TIME, not by an `ended` event — a clip's length is known before it starts, and a cap that silently stopped purging would fail *closed* (the mix going quiet after 12 cues, looking exactly like "audio broke").
- **Variant choice never repeats the previous variant** (repetition fatigue is audible across a set long before any one sample sounds wrong), plus ±3% render-side pitch jitter. Both draw from an injected `random` defaulting to `Math.random` — never the sim's `Prng` (`06`).
- **Loading goes through `AssetHost.readBinary`**, added beside `readJson`: `fetch` on web, `FileSystemManager.readFileSync` (no encoding → ArrayBuffer) on WeChat, both via `packedPathFor`. Consequence worth keeping: a future **music subpackage is a prefix rule in `assetPacks.json`**, not a loader change.

### What guards it, and why the units were not enough (2026-08-28)

Every link above has unit tests, and that is exactly why two **integration** tests exist on top of them: the failure mode this whole section is about is *silent*. Break the sample branch, drop the preload call, drift a path — the game keeps making noise, because the synth voices carry it, and no unit fails.

- **`audio/audioPipeline.test.ts`** — real `EventReactor` → real `WebAudio` → real mixer/bank/catalogue, with only the `AudioContext` and the byte read faked. It asserts the property no unit owns: a frame of real `GameEvent`s reaches the **shipped samples**, not the fallback (a frame containing all 16 cues plays 15 decoded voices and exactly one synthesised — `status.burn`). It is the automated form of the browser measurement in the status block.
- **`audio/wechatAudioLoad.test.ts`** — the audio counterpart of `render/wechatAssetLoad.test.ts`: browser globals deleted, a `wx` fake backed by the **real** mp3s, and the real `WeChatAudio.preload()`. It pins the four things that differ on this platform and are each a way to ship 95 kB of dead weight unnoticed: bytes come from `readFileSync` with no encoding, the path must be package-relative, a failure arrives as a synchronous *throw*, and `decodeAudioData` is the **callback** form (the fake returns nothing at all, so a promise-only implementation loads zero samples and fails here rather than on a device).
- **The voice cap's behaviour at saturation was discovered by writing the test, not assumed:** over the cap a higher-priority cue does not get refused, it **steals** the weakest slot — so every cue still starts and the loser is faded out 12 ms in. A frame of all 16 cues sacrifices exactly three voices, and all three are at or below priority 40.
- **A source-level guard on the two entry points** rides along in the pipeline test: that each calls `audio.preload()`, that neither AWAITS it, and that the WeChat one does it after the host swap. Crude on purpose — both entries are top-level `boot()` scripts with no seam, and every other test builds the backend itself, so deleting that one line would leave the whole suite green and the shipped set silently unloaded.
- **35 injected mutations, all caught** (20 across the module and its units, 11 across the two integration tests, 4 against the entry wiring). Two survivors on the first run were both worth the trip: one exposed a **fake-fidelity bug** — the `wx` fake ignored `readFileSync`'s encoding argument, so "read the mp3s as utf8", which on a device hands a string to the decoder and loses every sample, passed the suite — and one showed the string-return guard was only observable through its message, which is now asserted.

## The UI cues (built 2026-08-30)

The other half of the vocabulary: what a **screen** sounds like. Same catalogue, same mixer, same files-on-disk discipline — a different origin, and that difference is the whole design.

- **Four cues, because a press has four possible answers.** `ui.tap` = heard you, `ui.back` = you are leaving this screen, `ui.toggle` = the setting under your finger changed, `ui.denied` = that press did nothing. The last is the only cue in the game that reports an *absence*: an unaffordable craft, or ACQUIRE with nothing left to buy, used to be indistinguishable from an input the game never received.
- **They are ordinary `AudioCue`s.** No parallel path: the catalogue gives them gain/priority/variants, `CueMixer` gives them the sample-or-synth ladder and the pitch jitter, `VoiceBudget` counts them, and both backends play them with no per-platform code. The only thing different is who calls `play`.
- **`client/src/audio/uiSound.ts` is that caller — a module sink, deliberately.** Every engine cue reaches the bus through one object (`EventReactor`), which `Game` already hands the bus to. UI cues have no such funnel: they originate in ~14 screen classes and the widget kit (`10`'s `ui/widgets.ts`), none of which take dependencies at all. Threading an `AudioBus` through all of them to play a click would be the largest constructor change in the client, so the module owns one nullable sink — the same shape `render/uiSkins.ts` and `i18n` already use. **Unset is the safe state**: with nothing attached `playUiCue` is a no-op, which is what every widget test runs against.
- **Attached at boot, in both entries**, beside `audio.preload()` — the composition root, where the device is created. A source-level test guards that line in `main.ts`/`main.wechat.ts` for the same reason the preload guard exists: nothing else in the suite runs `boot()`, so its absence would be green everywhere and silent in the game. (It also lives there rather than in `Game`'s constructor because `Game.ts` is the repo's one tracked 500-line offender and the length gate forbids growing it — the placement is better for it, not a concession.)
- **The default is audible; the opt-outs carry meaning.** `Button` plays `ui.tap` unless told otherwise, so ~40 buttons sound without opting in. `sound: 'ui.back'` marks the button that dismisses a screen (forward and back must not sound alike — on a phone they are the same finger in nearly the same place), `sound: 'ui.toggle'` a settings option, and `sound: 'silent'` the handful whose OUTCOME picks the cue: the forge's craft rows and ACQUIRE play `ui.tap` or `ui.denied` from `ForgeActions`, because only the transaction knows which happened.
- **The cue plays AFTER the button's handler**, not before. The settings mute button is one of these, and its handler is what applies the new volume — reversed, muting would beep and unmuting would be silent.
- **A slider ticks once on release**, not per pixel of travel, and the tick doubles as the level preview: it plays through the bus the slider just changed, so releasing the SFX slider is how a player hears what they set it to. An OS-level `pointercancel` is not a commit and says nothing.
- **Priority 110 — above every combat cue, below `win`.** A cue the player caused by pressing a button must not be the one the cap drops: a silent press reads as a missed input, where a dropped `muzzle` reads as nothing at all. They are rare enough that outranking combat costs the mix nothing.
- **One variant each**, against this doc's own "a cue that fires often needs several". That rule is about repetition fatigue across a *set*; a UI cue is the opposite case — a direct answer to the player's finger that has to read as the same affordance every press. Two buttons that sound different are a bug, not variety. The ±3% pitch jitter is all the variation they get.
- **Level is set once, in the voice table.** All four sit at catalogue gain 1.0, and the shipped files were peak-matched to their synth voice's amplitude (0.08-0.10, about -21 dBFS), below every combat voice. One knob, not two.
- **Sourcing reversed direction.** For the combat set the synth voice existed first and the sample was chosen to match it; there was no UI voice before this pass, so the **sample was picked first** (on `audit.py`'s `ui` gate plus the pack's own family names: `select`, `back`, `toggle`, `error`) and the synth voice was then written to imitate its measured duration and centroid. `tools/audio-pipeline/process_ui.py` is a separate driver for exactly one reason: a UI voice is a single `tone()`, so its peak IS its `gain` argument and needs no re-render to measure, where `process_all.py` reads a `synth.json` audit of re-rendered voices.

### What guards them

Same principle as the section above — the failure is inaudible, so the tests are about the data and the wiring, not the sound.

- **Unit**: the sink (attach/detach, resume-before-play, the one-shot warning), the widget defaults and the call order, and `ForgeActions`' outcome-to-cue choice.
- **Wiring**: `game/gameUiSound.test.ts` presses REAL buttons on the REAL screens `Game` builds and asserts which cue each produced — including the two moments this doc names by hand (the extract/descend commit and the result screen) and the weapon-pickup rows, which are the only buttons built in a loop at runtime rather than in a constructor.
- **Convention, swept rather than sampled**: `game/ui/buttonCueConventions.test.ts` reads the source of all **48** `new Button(...)` sites across 14 files and holds them to the rules above — a dismiss button declares `ui.back` (and nothing else may), a settings option declares `ui.toggle`, only the outcome-dependent ones are `silent`. A behaviour test can only cover the call sites someone listed; the thing that will actually happen is a NEW screen shipping a BACK button that sounds like a forward one. Because a regex that matches nothing passes everything, the sweep also fails on any construction shape it cannot parse and holds floors on what it found (48 buttons, 13 dismiss, 30 on the default).
- **End to end, both platforms**: `audio/audioPipeline.test.ts` gained a real `Button` press producing a **decoded** `/audio/ui-tap_00.mp3` and zero oscillators, a check that each `ui.*` cue plays its own file, that a press clears the autoplay gate on a backend nothing else resumed, and that a press admitted at a saturated cap steals only from below it. `audio/wechatAudioLoad.test.ts` runs the press against the WeChat-shaped runtime with the browser globals deleted, where clearing that gate is not a nicety: nothing else in a mini-game session can start the context.
- **27 injected mutations, all caught** — including the one that survived the first round and forced the cap test above: dropping the UI priority from 110 to 10 changed nothing any test could see, which is exactly the kind of decision that quietly stops being true. The sweep's own blinding case is in there too (a button constructed through a shape the parser does not recognise), because a source-level test that silently stops covering anything is worse than no source-level test.

## Music & ambience

> **Assets AND runtime built 2026-08-31, in two passes the same day.** Two of the three planned
> launch loops exist as shipped files, pass a gate, and are what the game plays. What the two files
> commit to is immediately below; what the runtime does with them is under "The music runtime";
> what is still only a design is under "Still design, not built", which is now a much shorter list.

### What the two shipped loops commit to

- **Three tracks for launch, not eight.** `menu` (menu + forge outpost), `dungeon.ember` and `boss`.
  The original plan below is one loop per elemental biome, but `theme.ts`'s `BIOME_ID_TO_ELEMENT`
  maps the only authored dungeon to `fire`, and ice/lightning/poison have art with no dungeon
  pointing at them. Same standard `assetPacks.json` already applies to art: do not pay bytes or
  authoring time for content a run cannot reach. `menu` and `boss` ship; `dungeon.ember` does not
  exist yet, and until it does the runtime should substitute an existing loop rather than fall silent.
- **A loop is a REGION of a longer master, chosen by measurement.** An AI service returns a 4-6
  minute song with an intro and a fade-out, not a loop. `process_music.py --search` ranks every
  20-90 s region by how well its two ends match across the player's crossfade window; the chosen
  region and its measured figures are recorded per track in that file's `TRACKS` table.
- **The loop is closed by the PLAYER, not by the file** (built; `audio/MusicPlayer.ts`).
  `el.loop = true` is not usable here — MP3 frame padding denies sample-exact wrapping. The player
  instead starts a second deck at `length - 2 s` and equal-power crossfades into it: the same
  mechanism a track-to-track change needs, reused for the loop itself. Consequence for the assets, and it is a large one: head and
  tail have to be *tonally compatible over 2 s*, not sample-continuous — a much weaker and much
  more achievable requirement. `menu` measures **1.15 dB** mean energy-weighted per-band difference
  across that window; `boss` **1.63 dB**.
- **Level is set by a band target, and that target IS the mix decision.** The shipped cue set was
  deliberately peak-matched DOWN to the synth voices it replaced and sits at **-14..-21 dBFS peak**;
  both AI masters arrived at **-0.1 dBFS**, about 20 dB hot. Music is normalised so its **250-2000 Hz
  RMS lands at -30 dBFS** — the band `impact` (-33.7), `muzzle` (-22.9) and `ui.tap` (-34.8) all peak
  in. That leaves every cue's peak **9.1 to 15.7 dB above** the music's continuous level in the band
  they share. Measured against the cues' PEAKS rather than their RMS on purpose: RMS-to-RMS would
  demand a ~25 dB cut and bury the music, because a 43 ms transient and a 69 s bed are not
  comparable as averages.
- **Music is MP3, which REVERSES this doc's own earlier conclusion.** The SFX pass ended with
  *"OGG/Vorbis remains the right choice for music loops, where the fixed header amortises away"* —
  correct on bytes (the ~3.6 kB Vorbis codebook header does amortise past ~2 s) and incomplete on
  decode support: ogg/Vorbis is unreliable on iOS Safari and is absent from `InnerAudioContext`'s
  documented format list. Trading a few tens of kB against a chance of silence on two major targets
  is the wrong trade. The byte reasoning in that note still stands; its conclusion for music does not.
- **Music stays STEREO, where every cue is mono.** `audit.py`'s `sfx`/`ui` gates fail a stereo file
  ("wastes bytes") because a 100 ms cue's second channel is pure overhead. Music streams, so its
  bytes amortise over 69 s and the RAM argument for mono does not apply — which matters, because a
  decoded 69 s stereo AudioBuffer at 48 kHz is **26 MB of RAM**. That figure is the reason music
  streams through long-lived decks instead of going through `SampleBank` like every cue.
- **A per-track low shelf is a legitimate processing step.** `boss` arrived with its 40-49 Hz band
  **13 dB above every other band** — inaudible on a phone speaker, the only thing audible on
  headphones, and costly in MP3 bits either way. A 4th-order zero-phase shelf at 80 Hz / -14 dB
  brought its 20-250 Hz RMS from -11.1 to -26.7 dBFS. Every filter in the pipeline is a single
  zero-phase multiply over the *whole region's* spectrum, i.e. circular convolution — and a loop
  region *is* circular, so filtering cannot introduce an endpoint discontinuity the way a
  windowed/overlap-add filter would.
- **The gate is a new `audit.py` class, `music`, not the existing `loop`.** `loop` requires
  `step_db <= -50` (what `el.loop = true` needs) and forbids stereo; `music` drops both, and adds
  `xfade_band_diff <= 2.5` and `mid_band_dbfs` within `[-31, -29]`. Files route to it **by
  directory** (`audio/music/*`), not by name: a track called `menu.mp3` matches no cue prefix, fell
  through to the combat gate, and both beds were duly reported as "too long" and "stereo wastes
  bytes".

### The music runtime (built 2026-08-31)

The half that turns two files on disk into something a player hears. Every decision here exists
because music's failure mode is **silence**, which is exactly what shipped for a month while the
assets, the gate, the subpackage rule and the documentation all existed and nothing was connected.

- **The catalogue is `client/src/audio/musicCatalogue.ts`**, and `MusicTrack` lives in
  `platform/types.ts` beside `AudioCue` — the same split, for the same reason. Adding a track to the
  union is a COMPILE error until it has an entry: which file, how long that file is, its mix gain,
  and whether the file is really its own.
- **`TrackDef.lengthS` is load-bearing, not descriptive.** The player starts the next deck at
  `length - XFADE_S`, so a length that drifts from the shipped file moves the crossfade off the seam
  the asset was measured at — audible as a badly cut loop, invisible everywhere else.
  `audio/musicAssets.test.ts` checks it against the file's real audible duration (parsed at the MPEG
  frame level, no decoder) to within 50 ms.
- **`XFADE_S = 2.0` is shared with the asset pipeline and must not move on one side alone.**
  `tools/audio-pipeline/audit.py`'s `XFADE_S` is the width of the two windows `xfade_band_diff`
  compares, and the shipped figures (menu 1.15 dB, boss 1.63 dB) ARE that measurement. Widen it here
  alone and the player crossfades material whose compatibility was never checked; narrow it and
  measured seam quality is left on the table. Both sides stay internally consistent either way,
  which is why a test now reads `audit.py` and asserts the two numbers agree — the same class of
  drift the pipeline pass hit three times in one afternoon between its own search and its own gate.
- **`dungeon.ember` has no master, so it plays `menu.mp3` — and says so in a FIELD, not a comment.**
  `TrackDef.borrowedFrom` names the track whose file is being borrowed, so `PLACEHOLDER_TRACKS` is
  derived and testable. **It borrows `menu` and not `boss`**, which is the worse fit and the right
  choice: with one file on both sides of the boss-room threshold there is no audible change at all,
  and "the music never switches" is indistinguishable from "the music feature is broken". A bed that
  is wrong for the room is a taste complaint; a transition nobody can hear is a bug report. Closing
  it is one file plus one catalogue line.
- **Music STREAMS; it never goes through `SampleBank` like a cue.** A 69 s stereo loop decodes to
  ~26 MB of `AudioBuffer` at 48 kHz. Hence two long-lived decks per platform, re-pointed rather than
  rebuilt — and on web that is also forced: `createMediaElementSource` may be called only once per
  element, so a deck built per track would throw on the first loop wrap, a minute into the menu.
- **The two decks are the only per-platform code, and they differ structurally.** Web is
  `Audio` element → `createMediaElementSource` → deck gain → **music bus gain** → destination.
  WeChat is an `InnerAudioContext` with **no audio graph at all**, so there is no bus node: the
  settings volume has to be multiplied into each stream's own `.volume` together with that deck's
  crossfade level. That is why `setMusicVolume`'s two implementations can never be shared, and it is
  the answer to why the interface has that method rather than a gain node.
- **On WeChat, music is deliberately independent of `wx.createWebAudioContext`** — the one audio API
  on that platform this doc records as unverified on the lowest base library. A base library without
  it loses the sampled cues (the synth voices carry them) and keeps the bed.
- **`musicDirector.ts` derives the track EVERY FRAME; nothing triggers it.** From (render phase,
  live `GameState`, our seat's room) it answers `menu` / `dungeon.<biome>` / `boss`, and setting the
  track already playing is a no-op inside the player. Three properties follow that an event-driven
  director would each have to earn: no moment can be missed (a new screen or run entry point changes
  the situation, and the situation is what is read), nothing fires twice (so a prediction rollback
  re-emitting events, `06`, cannot restart a bed), and **the autoplay gate crosses itself** — while
  the context is suspended the call has nothing it can do, and the frame after the first gesture
  resumes it, the same call starts the bed.
- **Boss music keys off the ROOM, not off a live boss.** `RoomPiece.role === 'boss'` for the room our
  seat's `roomId` names. The bed therefore changes as the threshold is crossed rather than when the
  first spawn lands, and stays changed while the player collects the boss's death drops instead of
  snapping back over the corpse. A player straddling a door passage has no `roomId` at all, which
  reads as "not the boss room" — that keeps the bed on the doorway frame, where remembering the last
  known room would hold boss music through the door OUT of it.
- **Where the loop wrap happens is READ BACK from the deck, never accumulated.** `dtMs` drives the
  crossfade envelope only. An internal clock drifts from the stream on every stalled frame,
  backgrounded tab and audio interruption, and it drifts silently — the symptom would be a fade that
  starts before or after the seam, i.e. something that sounds like a badly cut asset.
- **The settings slider is wired at last.** `game/settingsBinding.ts` had always computed
  `effectiveVolume(state, 'music')` and pushed it into `setMusicVolume`; both backends threw it away
  in a `(_v) => {}`. Mute is a gain of 0 and NOT a stop, so unmuting reveals where the bed had
  reached rather than restarting it.
- **Focus/blur is wired on both platforms, for the first time on either.** Web listens to
  `visibilitychange` and holds the decks (position survives, so a tab-away and back does not replay
  the opening bar); WeChat has no DOM, so it uses `wx.onAudioInterruptionBegin`/`End`, registered in
  the constructor rather than beside the decks because an interruption can begin before any music has
  played. A held player also stops making wrap decisions — a deck paused ON the wrap point would
  otherwise fire the instant it was released, on evidence gathered while it was silent. Cues are
  deliberately NOT held: the longest is 350 ms and would have finished before the handler ran.
- **`Game.ts` was not touched.** The per-frame call sits in `GameLoop.update`, ahead of the
  playing/paused/idle branch so the menu bed is driven at all, and reaches the device through a
  module sink (`setMusicAudio`, attached at boot in both entries) rather than a constructor dep —
  the same shape and the same reason as `audio/uiSound.ts`, plus one hard constraint: `Game.ts` is
  this repo's one tracked 500-line offender and the drift gate pins its length.

#### What guards it

Same principle as the cue sections above, and a stronger version of it: a cue that fails to load
still SOUNDS, because `CueMixer` falls back to a synth voice. Music has no fallback, so every broken
link is silence — and silence is what a month of green tests looked like.

- **`audio/musicAssets.test.ts`** — the gate the loops never had. `platform/audioAssets.test.ts`
  reads `public/audio/` **non-recursively**, so the moment music shipped into a subdirectory it fell
  out of that file's byte budget, credits cross-check, format check and licence sweep all at once.
  The new file holds a music byte budget, generated-paths ↔ files-on-disk in both directions, the
  catalogue length against the real file, **stereo required** (the exact inverse of the cue rule —
  if the two assertions ever agree, one is broken), the shared `XFADE_S`, and the provenance record.
- **Provenance for AI-generated masters, filed OUTSIDE the CC0 path.** `packs.json` declares every
  SFX source pack CC0 and a test asserts that of every entry, so a Suno master filed there would
  either break that gate or quietly weaken it. `credits.json` grew `music` / `music_terms` instead,
  and what the test checks is that the record exists and stays **honest about what it lacks**: the
  verbatim prompt was never captured (`prompt: null`, `prompt_archived: false`) and no licence text
  is archived (`license_text_archived: false`). Both are pinned as declared gaps, because a test
  demanding they be filled would only invite them to be filled with a guess.
- **`audio/mp3Frames.test.ts` (2026-09-01) — the gate ON the gates.** The frame walker every rule
  above rests on had no test of its own, and it is the one place here where being wrong is silent in
  both directions: a parser that mis-reads a duration makes the catalogue assertion compare two wrong
  numbers, and a rejection branch that never fires lets a malformed file ship. It is now driven by
  synthetic streams whose answers are known by construction — the spec tables and the frame-length
  formula are deliberately restated in the test, so a walker computing a different length lands
  off-sync and fails rather than agreeing with a shared constant. That found the missing truncation
  check and the `NaN`-blind frame-length guard described in the status block. One shape stays
  uncatchable on purpose: a cut AT a frame boundary is byte-for-byte a valid shorter file, which is
  precisely why `credits.json`'s byte-size cross-check is not redundant beside a parser that walks
  every frame. It also pins, over all 252 accepted version/bitrate/rate combinations, that the
  shortest describable frame is 24 bytes — the invariant the walk's progress depends on.
- **`platform/wechat/weChatMusicDeck.test.ts` (2026-09-01)** — the counterpart of
  `webMusicDeck.test.ts`, which that platform's deck did not have. The integration file above drives
  it from outside (paths, volume products, interruption, degrade), which leaves exactly what the web
  deck's own battery had found missing on its side: `position()`'s null-when-idle contract, currently
  unobservable because the player only reads the LIVE deck, and the small `playing` state machine
  deciding whether `stop`/`setPaused`/`position` do anything. It also pins the one behaviour with no
  web counterpart — restarting an unchanged `src` via `stop()` then `play()`, because assigning `src`
  is the only rewind `InnerAudioContext` offers, and that IS how the second deck begins the loop wrap.
- **`audio/musicPipeline.test.ts`** (web) and **`audio/wechatMusicLoad.test.ts`** (WeChat) —
  integration, in the shape `audioPipeline.test.ts`/`wechatAudioLoad.test.ts` established. Real
  director → real backend → real player → real deck, with only the `AudioContext` / `Audio` element /
  `wx` faked. They assert the CONNECTIONS in the order a player meets them: a track reaches a real
  element's `src`, the graph is deck → music bus → destination (a deck wired to the destination
  bypasses the settings volume; wired to the SFX bus makes two sliders one slider), the autoplay gate
  opens by itself, the situation changes the file, the loop closes at `length - 2 s`, and a tab-away
  holds it. The WeChat file additionally pins that the src is the **packed subpackage path** and that
  it names a real file on disk, that volume is a product of bus × fade, and that music survives
  `createWebAudioContext` being absent entirely.
- **Source-level guards** on the boot wiring and on where the tick sits in `GameLoop`, for the reason
  the `preload` guard exists: every test attaches the sink itself, so deleting that line from an
  entry would leave the whole suite green and the game silent.
- **Measured in a real browser, because I cannot hear it.** After the first gesture: `menu.mp3`
  fetched as a **206 Partial Content** range request (i.e. genuinely streaming), one deck live with
  `duration: 69` exactly matching the catalogue, `loop: false`, deck gain rising 0.10 → 1.00 across
  2 s of frames; `setMusicVolume(0.2)` moved the music bus to 0.2 and left the SFX bus at 0.5 and the
  deck fade at 1.0; a switch to `boss` stopped deck 0 and streamed `boss.mp3` on deck 1 at gain 1.0;
  zero console errors. One incidental finding worth keeping: in that embedded pane `requestAnimationFrame`
  is suspended while `document.hidden` stays false, so the whole game loop freezes while audio keeps
  streaming — the bed ran to its end and went quiet, and the **wrap recovered on the first frame that
  ran**, which is the position-read design paying for itself.
- **66 injected mutations, 65 caught.** The three first-round survivors were all worth the trip: two
  were real gaps (the web deck's `position()` was unguarded by any test, and `ensureMusic`'s
  "give up for the session" latch was only covered on the *other* degrade path), and the third is a
  genuine EQUIVALENT mutant — deleting the biome→track lookup changes nothing, because the only biome
  that exists maps to `dungeon.ember`, which IS the fallback. That one is recorded in the test rather
  than hidden, with the assertion that will start biting the moment a second biome loop ships.
- **A further 45 mutations on 2026-09-01**, over the two new suites and the walker's own fixes: 41
  caught, and the 4 survivors are of two shapes, both the same kind as the biome one above — a clamp
  on `setBusVolume` that `applyVolume` clamps again (with its twin in `WeChatAudio.setMusicVolume`),
  and the frame-length guard, which no input can reach in either the old or the fixed form. All
  recorded in the tests as equivalent mutants rather than killed by reaching into private fields. **The battery earned its keep twice.** Once by catching a
  test that pinned nothing — the new web volume case used `0.5`, which is the field's own default, so
  deleting the assignment under test survived it. And once by refuting a change I had already made:
  the frame-length guard was deleted as unreachable dead code, and the mutant that disables the
  reserved-index check then **hung the suite** instead of failing a test, because a free-format index
  gives a frame length of 0 and `i += len` never advances. The guard is back, and the lesson
  generalises past audio: an unreachable branch that turns a hang into a thrown error earns its line,
  and when a guard looks dead the question is what happens to the LOOP without it.

### Still design, not built

- **Ambience per biome** — low crystal hum / blight drone, desaturated to match the "environment desaturated, hazards saturated" law (`13`): the world bed stays quiet so combat cues pop. A second, independent bus-level layer, not a track: it plays UNDER whichever bed the director chose.
- **A combat intensity layer.** The boss bed swaps on room entry (built), but the optional layer that rises with on-screen enemy count read from `state` (render-side, no sim read-back) does not exist. It needs a second simultaneous stream per platform, which the two-deck player deliberately does not have room for — three decks, or a separate ambience player.
- **Biome themes beyond `ember`.** `BIOME_ID_TO_TRACK` is the one-entry table a new biome adds to, and `assetPacks.json`'s `music` pack has room for roughly one more loop before its own limit. Lazy-loading a biome's loop with that biome's asset bundle (`12`) is still eager-at-boot like every other pack.
- **A distinct boss STINGER** — a one-shot on room entry over the bed change, as opposed to the bed change itself.
- Music is **not** determinism-relevant, so it may use free wall-clock timing, dynamic mixing, and any RNG.

## WeChat audio constraints (from `04`)

- **`InnerAudioContext` per sound / a small pool.** Creating one context per SFX is costly; keep a **pool of reusable contexts** for short SFX and a couple of long-lived contexts for music/ambience. `wx.createWebAudioContext()` (if present on the target base library) gives lower-latency mixing for SFX — verify availability on the **lowest** base library (`04`), fall back to `InnerAudioContext`.
- **Format & size.** Prefer **mp3** (universally decoded); watch total package size against WeChat's main/sub-package limits (`04`) — audio is heavy, so biome tracks belong in **lazy sub-packages / downloaded bundles** (`12`), not the boot core.
- **Decode/latency.** First play of a clip may stall on decode; **preload** the core SFX set at boot. Expect higher input-to-sound latency than web — the deflect/hit cues must still feel tight, so keep those clips tiny and pre-decoded.
- **No `eval`, no DOM (`04`).** Nothing here uses `new Function`/`document`; the adapter surface is `wx.createInnerAudioContext` / `wx.createWebAudioContext` only.
- **Focus/blur & interruption.** Pause/duck music on `wx.onAudioInterruptionBegin` / hide, resume on end/show — and mirror it on web (`visibilitychange`). **Built 2026-08-31**, and NOT in `ScreenManager` after all: it landed in each audio backend, because both signals are platform APIs and the thing being held is the platform's own stream. Cues are not held (the longest is 350 ms).

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

- ~~**Cue catalogue** — the cue-id list + per-cue gain/priority/variation-count, authored as data.~~ **Built (2026-08-27):** `client/src/audio/cueCatalogue.ts` plus the loading path — see the section above. It landed as its own module rather than in `content/` or the `12` manifest, for the reason recorded there.
- **Music track list & transitions** — **partly answered 2026-08-31**: three launch tracks rather than eight, and the cross-fade rule is settled by the double-deck loop mechanism above (2 s equal-power, serving both the loop and track-to-track). What the RUNTIME still owes: `MusicPlayer` plus one streaming deck implementation per platform (web `Audio` + `MediaElementAudioSourceNode` into a music gain node; WeChat two long-lived `InnerAudioContext`s whose `.volume` carries bus × fade, since they cannot be routed through a gain node), a `musicDirector` deriving the wanted track from screen/biome/boss-room state **each frame** rather than from events (idempotent, so it needs no dedupe and clears the autoplay gate by itself), a real `setMusicVolume` in both backends, focus/blur pause (`visibilitychange` / `wx.onAudioInterruptionBegin` — the audio side has neither today), and a TS-side byte budget and provenance record for the music files. The `assetPacks.json` prefix rule making `audio/music/` a subpackage **is done** (2026-08-31) — the WeChat byte gate forced it the moment the files existed, since without a rule they fall to `main` and took it from 4.00 to 5.09 MB against a hard 4.00 MB limit. One caution for whoever writes the runtime: with music moved out, **main sits at 4,191,575 / 4,194,304 bytes — 2,729 spare**, so the runtime's own code will not fit until something leaves main or the uncompressed-vs-compressed measure is settled (the checker reports main as ~3.36 MB gzipped). That last one is a real hole: `platform/audioAssets.test.ts` reads `public/audio/` **non-recursively** and filters `.mp3`, so the two loops sit outside every gate it holds, including the 160 KiB budget.
- **Voice-count budget** on WeChat low-end (`04`) — the priority table and the coalescing curve now exist and are enforced (above), but the cap itself (12) was reasoned from what a frame can ask for, **not measured on a device**. That measurement is what is left.
- ~~**Sourcing** — AI-generated vs. licensed library vs. commissioned, and the commercial-use licence check for a monetised title (`14`).~~ **Resolved for SFX (2026-08-27):** CC0-only, from free libraries, no AI generation and no commission. Six Kenney CC0 packs, licence texts archived under `art/audio/licenses/` and asserted by test. Still open **for music** — see the sourcing note below, where CC0 music turned out to be almost entirely chiptune, a style mismatch for `13`'s flat-cel direction.
- ~~**Placeholder audio** — a tiny free/procedural SFX set to wire the event→sound path early.~~ **Resolved (2026-07-26):** `platform/audioSynth.ts` is that set, and it is still what plays. The 2026-08-27 asset pass did not replace it; it produced the files that will, once the catalogue above exists.

## Open questions

- **`InnerAudioContext` pool size vs. latency** on the lowest base library (`04`) — is `wx.createWebAudioContext` reliable enough to prefer for SFX, or is the `InnerAudioContext` pool the safe floor?
- **Predicted-vs-confirmed cue policy** per cue (play-on-predict then suppress, or play-on-confirm only) — decide against real RTT (`06`).
- **Adaptive/interactive music** (intensity layers, stingers) vs. flat loops — worth the mixing complexity on WeChat, or ship flat loops first?
- **Does `menu`'s missing high register matter?** Both AI masters were prompted for crystalline bell/glass timbres and both placed their energy about two octaves below what was asked: the first put 90% of it under 109 Hz (which is why it became `boss` instead), and the second, after `sub-bass`/`drone` went into the exclude list, reached 160 Hz-1.2 kHz but still produced nothing above 4 kHz (-70 dBFS and below). Neither file is *defective*; the question is whether a bed with no sparkle reads as the cold crystal hub `13` describes. Only listening answers it, and as of this pass nobody has listened to the music either.
- ~~**Total audio budget** against WeChat package limits (`04`) — how much goes in the boot core vs. lazy sub-packages, and what compression bitrate holds up.~~ **Answered for SFX (2026-08-27, re-measured 2026-08-30):** the whole 50-file set is **101.9 kB** and sits in the boot core, with the main package at **3.42 MB / 4.00 MB** (the four UI cues added 6.9 kB). Bitrate is not a fixed setting — each file is encoded at whichever sample rate on a 16–48 kHz ladder yields the **smallest** MP3 while still clearing 2.2× its own measured 95% rolloff, because MP3 bytes are not monotonic in sample rate. A `client/src/platform/audioAssets.test.ts` budget of 160 KiB now gates drift. **Still open for music**, which is where the real bytes are and which belongs in lazy subpackages, not the core.
- **Who signs off on how it sounds.** The 50 shipped files were chosen from spectra, not by ear (status block). Measurement cannot close this; a person has to listen — and as of 2026-08-27 these files are what actually plays, so "the synth voices are what plays anyway" is no longer the reason it can wait. It is still not *blocking* (the game is playable silent), but it is now the top open item on this doc.
- **Does WeChat's `decodeAudioData` take the promise or the callback form** on the lowest target base library? `audio/decodeAudio.ts` accepts either, so the answer only decides which branch is dead code — but a decode that fails silently costs every sample on that platform, and the fallback (synth voices) is quiet about it.

## Sourcing audio (tools & libraries)

Practical note for producing the cue catalogue and tracks. **Verify the commercial-use / redistribution licence of anything used** — this is a monetised game (`14`), and "free for non-commercial" or "no redistribution inside an app" clauses are common. When in doubt, keep the licence text with the asset in the repo.

- **AI sound-effects:** *ElevenLabs* (text-to-SFX), *Optic/Stable Audio* and similar text-to-audio models — good for one-off impacts/whooshes; check the plan's commercial terms.
- **Procedural retro SFX (free, ideal for placeholders):** *jsfxr / sfxr / Bfxr / ChipTone* — generate 8-bit-ish shots/hits/pickups in-browser, export wav, MIT-ish/CC0; perfect for wiring the event path before final audio.
- **AI music:** *Suno* and *Udio* (song generation), or royalty-free-oriented *Soundraw / Mubert / AIVA* (built around clear commercial licensing). Read each service's license for in-game/redistribution rights before shipping.
- **Human-made libraries (not AI):** *Freesound* (CC — check per-clip licence, some require attribution), *Kenney.nl* (CC0 game assets, incl. audio — safest for commercial), *OpenGameArt* (mixed licences), or paid packs on *Humble/itch.io/GameDev Market*.

**What actually happened for SFX (2026-08-27) — CC0-only, no AI, no commission.** Six Kenney CC0 packs (Impact Sounds, Interface Sounds, Sci-Fi Sounds, Digital Audio, RPG Audio, Music Jingles), **556 files audited**, 46 shipped (50 since the UI pass added four from the same Interface Sounds pack — see "The UI cues"). Full selection rationale, per-cue, in `art/audio/README.md`. Four findings worth carrying forward:

- **A free pack is not a clean pack.** Across the 556 files: **43 clip**, peaking to **+3.51 dBFS** — above full scale, and unfixable once baked in; **233 carry >5 ms of leading silence**, which is pure added latency on a cue this doc requires to feel instant; **247 are bit-identical dual-mono**, half their bytes a duplicate channel. Audit before picking, not after.
- **MP3 beats OGG for short SFX, by 2.6×.** Vorbis carries a **~3.6 kB fixed codebook header** per file, which dwarfs a 100 ms payload: a 5 ms clip costs 3685 bytes as Vorbis against 703 as MP3, and the two converge only around **2 s** of audio. Measured in a real browser, MP3 also decoded sample-exact (0.1 ms) where Vorbis added up to 30 ms of padding. This agrees with the "prefer mp3" rule above, for a reason that rule did not state. **OGG/Vorbis remains correct for music loops**, where the header amortises away.
- **MP3's encoder delay is not a problem here, because the Xing/LAME tag survives.** Decoders read the delay/padding fields and trim them; measured leading silence through a browser decoder was 0.1 ms. A re-encode that drops the tag would silently reintroduce tens of ms of latency, so `audioAssets.test.ts` asserts the tag is present.
- **CC0 music is a style problem, not an availability problem.** CC0 game music is overwhelmingly chiptune/8-bit (OpenGameArt's CC0 collections, `Spooky Dungeon`, the NES/retro sets). That is a **direct mismatch** for `13`'s flat-cel orb-core / crystal-mirror direction — usable as placeholder, wrong as final. Expect the music decision to be AI-generated vs. commissioned in a way the SFX decision was not, or to need CC-BY sources plus a credits screen (`credits.json` and `10`'s settings/credits surface already anticipate this).

For anything further, the licence check still matters more than the source: keep the licence text **with** the asset in the repo (`art/audio/licenses/`), record the upstream URL and a **sha256** so the pack stays verifiable (`art/audio/packs.json`), and assert both in a test.
