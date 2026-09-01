# Work log — 2026-09-01 — the asset phases

One volume of the implementation log. The index, the phase spine and the rules for
appending live in [../ROADMAP.md](../ROADMAP.md); entries here are in date order.

## The first download becomes code only (2026-09-01, client + build + docs)

*"关于首包的问题，我觉得只需要代码和加载界面的图片即可。其他的都可以分批进行下载。"* The question came
out of the previous day's byte crisis: main had **2,729 bytes** of headroom, the music runtime is
code, and the fix that had shipped was to move one 606 kB PNG into a pack named for its own
symptom. The user's read was that the whole arrangement was backwards — the first download should
be code, and everything else should arrive while the player is in the lobby.

It was, and the reason is worth stating plainly: **the pack table shipped on 2026-08-25 bought
nothing it was capable of buying.** `preloadCoreArt` called `ensureAllPacks()` — all six packs, at
boot, in parallel. That satisfies WeChat's 4 MB rule (it is a rule about the FIRST download, and a
pack fetched a moment later is compliant) and it was argued as such at the time. What it left in
place was a byte tax on code: art held 2.49 MB of the 4.00 MB, so every code change was measured
against what was left.

### What the tiers are, and what decided them

Measured, not assumed — `client/public` is 4.93 MB across 163 files, and the split follows what
each screen actually draws:

| pack | contents | files | bytes | when |
| --- | --- | --- | --- | --- |
| `main` | `js/game.js` | 1 | 995 kB | the first download |
| `lobby` | `/ui/` | 17 | 387 kB | awaited at boot, behind a progress screen |
| `music` | `/audio/music/` | 2 | 1,115 kB | background, never awaited |
| `forge` | `/weapons/` | 27 | 443 kB | background, awaited at the run boundary |
| `run` | everything unmatched — rigs, fire/neutral biome, environment, SFX | 102 | 2,335 kB | background, awaited at the run boundary |
| `biome-ice` / `-lightning` / `-poison` / `boss` | unchanged | 14 | 654 kB | background, awaited at the run boundary |

First download **3.42 MB → 0.95 MB**, and the headroom that matters became 3.05 MB of room for
code. Total is unchanged at 5.72 MB / 30 MB: this moves bytes in TIME. The full design, including
every argument below, is in [`design/12`](../12-art-animation.md)'s "the first download is code
only".

Three decisions inside that table were not obvious.

**The forge is the gate, not START RUN.** The forge is where a player *chooses* using weapon art,
so weapons have to be dressed before it paints — and by then the background load has had the whole
login/menu/mode-select sequence to finish. Gating at START RUN would have shown a screen full of
grey placeholder cards and then made the wait anyway.

**Music is fetched and never awaited.** It is 1.09 MB and the one asset class a game can start
without, but it could not simply be backgrounded: a deck handed a path inside an unfetched
subpackage plays nothing, and `musicDirector`'s per-frame derivation is a no-op once `current`
already names the track it asked for. So the pack's completion calls the new
`MusicPlayer.invalidate()` — one hook, at one place, that decides nothing and only forgets a failed
answer. Without it the menu bed would have been silent for the session, which is precisely the
class of regression the previous day's runtime pass existed to close.

**The unreachable-today packs are awaited anyway.** `biome-ice` and friends are 654 kB of art no
authored content can reach, and gating them at their own point of use would mean re-running
`preloadBiomeTiles` once per pack and reasoning about a half-filled texture map. One transition
instead — because the rule this whole pass rests on is that **the set of available textures changes
only at a phase boundary**, never mid-room. `RoomBuilder` builds each room's sprites once, so a
texture that lands afterwards does not fix the sprite built without it; that is the "correct size,
correct blend mode, default (0,0) position, green tests, live report" failure shape this codebase
has the worst record with.

### `mainPack` and `defaultPack` had to stop being one field

`assetPacks.json` used one field for two ideas: the package whose root is `''` (WeChat's first
download) and the destination for a path no rule matches. They were both `main` and the distinction
had never come up. Now `mainPack: "main"` and `defaultPack: "run"`, and the flip IS the safety
property: **a new asset added with no rule can no longer silently enlarge the first download.** A
rule is required to opt INTO `main`, and `assetManifest.test.ts` now sweeps the real `client/public`
tree asserting no shipped file lands there — over the tree rather than over the loader tables,
because the file that would land in `main` by accident is exactly the file nobody remembered to add
to a table.

Each pack also declares a `phase` (`main` | `lobby` | `background` | `run`), so `preloadArt.ts`
asks `packsForPhase()` instead of naming packs and the boot sequence cannot drift from the table.

### Three things found while building it, none of them in the plan

**1. The gate has to be armed before `Game` is constructed.** `isRunArtReady()` answers `true`
until `beginDeferredArt()` has been called — deliberately, because that is what keeps the gate out
of every unit test and every caller that never deferred. The first wiring put the kick after
`game.start()`, which reads naturally ("start the download while the player reads the menu") and is
wrong: `start()` enters a run on its own first pass when `?replay=` is set, so that run would have
begun with placeholder art and no gate. Now pinned by reading both entry files' source, the same
technique `audio/musicPipeline.test.ts` uses to check `GameLoop` calls the director.

**2. The progress bar could not have moved.** `ensureRunArt(onProgress)` memoised the promise, and
the background kick creates that promise with no listener at all — so the gate's callback, arriving
later, was dropped on the floor. A single stored callback cannot work here; progress is now a
broadcast, and a listener registering mid-download is immediately replayed the current count so a
gate that opens at 12 of 16 draws its bar at 12 instead of starting at zero and jumping. Found by
the test asserting the tick sequence, not by looking at a bar.

**3. The build kept a full stale copy of the old main package.** `wechatAssetSync.mjs` prunes
`platforms/wechat` to match the plan, and derived the directories to sweep FROM the plan. That
works for a renamed texture and fails for exactly this change: once no `dest` begins with `ui/` or
`skins/`, the sweep never visits them, and the previous build's copy stays on disk — inside the
first download, invisible to the byte gate, which weighs `client/public` through the rules and
never looks at the built tree. The sweep is now derived by exclusion (everything except the bundle
and the appid config), empty top-level directories are removed so `ui/` does not sit hollow beside
`packs/lobby/ui/`, and `build/wechatAssetSync.test.mjs` is new. Its own first run then found that
the rewritten sweep threw ENOENT on a fresh checkout, where this build is the one that creates the
directory.

### What was verified, and how

- **The real WeChat-shaped runtime**, `render/wechatPhasedBoot.test.ts` (14 tests): phase one
  fetches `lobby` and nothing else, every UI texture resolves, every rig/weapon/biome/environment
  texture is *genuinely absent* — not merely unused, because the fake enforces WeChat's own rule
  that a file inside an unfetched subpackage names nothing — and the run phase then fills every one
  of them in. That last assertion is the property the whole design rests on: a loader re-run after
  its pack lands works. The harness carries its own check that phase one requested only
  `packs/lobby/` paths, so "absent" cannot pass for the wrong reason. The runtime fake moved out of
  `wechatAssetLoad.test.ts` into `render/wechatRuntimeFake.ts` so both files drive it.
- **The gate**, `controllers/ArtGate.test.ts` (7 tests) against the real `preloadArt` module state
  and a host whose downloads never settle until released: inert with nothing deferred, one screen
  and one retry per wait, a repeat swallowed while the wait is up (the scrim stops taps, not the
  keyboard, and `Game.confirm()` is reachable in the phase the player is still standing in), no
  ticker callback left behind, and the gate opening anyway when every download fails — a spinner
  that never comes down is the worst possible reading of "gameplay is never blocked on art".
- **The progress screen**, `ui/loadingScreen.test.ts` (10 tests): the spin advances on wall-clock
  time rather than frame count, the bar draws nothing until a total is known, the scrim is
  interactive at every viewport, and a resize mid-wait re-lays-out.
- **Live, in the browser**: the lobby paints fully dressed with zero console errors, the forge shows
  every weapon card, a real run renders the fire biome / rig / enemies / props, and the progress
  screen — constructed on `Layers.overlay` through the real renderer at 1280x720 — covers a live
  run and animates. That last check needed a screenshot to force frames: the in-app browser pane
  starves `requestAnimationFrame` when it is not compositing, and `ticker.lastTime` was 83 seconds
  stale while `FPS` still read 56. The game itself was frozen too, which is what said the spinner
  was fine and the harness was not.

### Still open

- **Per-byte progress.** WeChat's `wx.loadSubpackage` returns a `LoadSubpackageTask` carrying
  `onProgressUpdate`, which would give real bytes. It is not in this repo's `wx.d.ts` and has never
  been exercised, so the bar counts completed units (packs, then loaders). A device item.
- **Concurrent `wx.loadSubpackage` is undocumented.** All `run`-phase packs are kicked together —
  the same thing `ensureAllPacks()` already did and which was verified working in the simulator on
  2026-08-25, so not a new risk, but not a documented guarantee either.
- **Background download while the lobby renders is untested on a handset.** The download is native;
  image decode is not. If the menu hitches, the fix is serialising the kicks, not undoing the
  tiering.
- **The curtain re-encode is now a plain question with no gate behind it.** 468x832 of translucent
  gradient at 1.56 B/px; a lossless re-encode with this repo's own codec is byte-identical and the
  alpha bbox is the full canvas, so the only lever is pixel count (416 long-axis → 174 kB). It is
  drawn ~64 world px wide at a ~4x room zoom and resolution 2, so the file sits at roughly 1:1 with
  its own maximum on-screen density — which is why softening it is a judgement about whether the
  "you can pass here" cue survives, not a measurement.
