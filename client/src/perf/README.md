# `src/perf` — client performance analysis

Ported from the sibling project `funny` (`client/src/cache/PerfMonitor.ts` +
`client/src/cache/MemoryMonitor.ts`), adapted to this client's Pixi v8 renderer and to the
fact that daydayup has no telemetry backend to send findings to.

## What it is

| file | role |
| --- | --- |
| `frameSampler.ts` | Pure windowed sampler: fps, frame/update/render percentiles, long-task busy ratio, hidden-tab discard, sustained-low-fps streak. No Pixi, no DOM. |
| `glProbe.ts` | Counts the WebGL commands that break batching (draw calls, program/texture/framebuffer binds) per frame. |
| `drawAttribution.ts` | **Which objects** those draw calls belong to: `attributeDraws` (hide a group, re-render, the drop is its cost) and `graphicsCensus` (every Graphics with Pixi's own batching verdict). Console-only. The 400-float rule it reports against is pinned to real Pixi in `render/staticGraphics.test.ts`. |
| `sceneCounters.ts` | Scene-graph walk (nodes / visible / **filtered**), GPU texture count, JS heap. |
| `PerfMonitor.ts` | Installs the above on a live `Application` and emits one `PerfSnapshot` per window. |
| `PerfOverlay.ts` | On-screen readout. |
| `frameProbe.ts` | A/B/C frame differencing for ART work: `readFrame`/`diffFrames`, plus `probeFrames`, which runs a **liveness control** first and refuses to be believed if it moves zero pixels. `window.__perf.probe(...)`. |
| `gpuTimer.ts` | GPU-side frame timing via `EXT_disjoint_timer_query_webgl2` — what the GPU actually did, not what the CPU spent submitting it. Carries its own controls (`sweepTrust`) and the fixed-vs-fill decomposition (`resolutionSplit`). |
| `index.ts` | `installPerf(app, { overlay })` + the `window.__perf` console handle. |

## Using it

```bash
npm run dev --prefix client
```

- `http://localhost:5173/` — the **monitor** runs in every session. It is one ticker
  bracket plus a windowed counter; a sustained stutter leaves a `[perf]` console warning
  that already names which half of the frame was to blame.
- `http://localhost:5173/?perf=1` — adds the **overlay** and the GL draw-call probe.
- `window.__perf.monitor.latest` — the last snapshot, from the devtools console.
- `window.__perf.overlay.toggle()` — show/hide without a reload.
- `window.__perf.attribute({ name: nodes, ... }).text` — per-group draw-call attribution. Needs
  `?perf=1` (without the GL probe there is nothing to count, and it says so rather than reporting
  zeros). Group deltas deliberately do **not** sum to the total: a draw call belongs to a
  *boundary* between neighbours, so a group whose cost exceeds its own object count is one that is
  cutting the batcher — which is the finding worth having.
- `window.__perf.census().text` — every Graphics, largest geometry first, `!` on the ones Pixi will
  not batch. Pixi v8 auto-batches a Graphics only under **400 floats** of geometry, and nothing in
  the renderer surfaces that, so a hand-banded gradient quietly crossing the line looks exactly
  like one that batches fine. This is the probe that found the wall shading.

A worked example, the one the 2026-08-24 pass was measured with:

```js
const L = window.__game.layers, ents = L.entities.children;
const walls = ents.filter((e) => e.children.length === 4 && e.children[0].constructor.name.startsWith('_TilingSprite'));
const actors = ents.filter((e) => ['Enemy', 'Actor'].includes(e.constructor.name));
console.log(window.__perf.attribute({ walls, actors, ground: [L.ground], shadow: [L.shadow] }).text);
console.log(window.__perf.census().text);
```

...and the census row to look for is a `Graphics` over 400 floats with a `!`. After the sampled-ramp
pass the wall shading is 8-15 fills of ~150 floats and does not appear; what does is a door's
stroke-heavy recess (2010 floats, 10 fills), which is a different shape of problem and not one a ramp
texture fixes.

Thresholds, matching funny's `nw_fps_warn` / `nw_cpu_busy_warn` escape hatch under this
repo's key namespace:

```js
localStorage.setItem('daydayup.perf.fpsWarn', '50')   // warn below 50fps instead of 25
localStorage.setItem('daydayup.perf.busyWarn', '0.3') // long-task busy ratio
```

## How funny's version was changed, and why

1. **No telemetry sink.** funny's monitors exist to file `reportAnomaly` events to Loki so a
   slow client in the field is visible without a repro. daydayup has no such channel, so a
   breach goes to `console.warn` and to the overlay. `onWarn` / `onSnapshot` are the seams
   where a backend would attach later.
2. **The frame is split into update vs render.** funny reports a single fps number; here
   every sample also carries the CPU cost of the game's own update and of
   `renderer.render`, so a report says *which half* to look at. Done by bracketing the
   ticker (`UPDATE_PRIORITY.HIGH` / `UTILITY`) and wrapping `renderer.render` — nothing in
   `Game`/`GameLoop` knows the monitor exists.
3. **A GL command probe, which funny has no equivalent of.** funny renders a handful of
   card sprites; "how many draw calls" was never its question. Here it is *the* question —
   see the measurement below.
4. **Pixi v8, not v7-legacy.** No `PIXI.utils.BaseTextureCache`, no `DisplayObject`. The
   texture count comes from the renderer's own managed-texture hash (shape-sniffed, since
   it is a private field), and the walk is over `Container`.
5. **No pool registry.** funny's `MemoryMonitor` dumps `poolRegistry` idle-object counts;
   this client has no object pools to report, so that half is not ported. What replaces it
   is `scene.filtered` — the count of nodes carrying a filter, i.e. the number of extra
   render-target passes the frame will pay for. That counter is what found this client's
   actual bottleneck within minutes of the port landing (below), so it earns its place.

## The first measurement, and what it found (2026-08-24)

Taken in a real run, 8 live enemies, one shielded player, at 1920x855:

```
frame p50 16.7ms   update p50 0.6ms   render p50 10.4ms
draws 175   prog 105   tex 162   framebuffers 23  (~11 filter passes)
nodes 892   filtered 11   gpu tex 72   heap 49MB
```

Read: the frame was **render-bound by more than 15x**, and the render cost was not geometry
— 892 nodes is nothing. It was **175 draw calls with 105 shader-program switches for 11
filtered nodes**. Every actor carried a `NormalLitFilter` unconditionally, and a filtered
container is its own render-target pass in Pixi: bind target, draw, bind back, re-draw
through the filter's program. Nine of those (plus the two screen-wide post-fx) accounted for
the framebuffer binds, and they also cut the sprite batcher into as many pieces as there were
actors. `filtered` tracking the on-screen actor count is the signature.

**Fixed the same day**, by moving lighting to one screen-space pass over the scene layer
(`SceneLightFilter` on `Layers.lit`, see `game/fx/filters/litFx.ts`). Same scenario after:

```
frame p50 16.7ms   update p50 0.5ms   render p50 2.4ms
draws 157   prog 95   tex 150   framebuffers 6  (~3 filter passes)
nodes 893   filtered 3   gpu tex 50   heap 46MB
```

| | before | after |
| --- | --- | --- |
| render p50 | 10.4 ms | **2.4 ms** |
| filter passes | 11 | **3** |
| framebuffer binds | 23 | **6** |
| filtered nodes | 11 | **3** |
| draw calls | 175 | **157** |
| program switches | 105 | **95** |

## The second measurement: where the draw calls went (2026-08-24)

Draw calls had fallen by only 18. `drawAttribution.ts` was written to answer why, and did, in one
report — same scenario, 8 live enemies, 1920x855:

```
total  draws 165  prog 102
  wallBlocks      79 draws   50 prog  (27 nodes)
  actors          22 draws   22 prog  (9 nodes)
  shadow          22 draws    0 prog  (1 node)
  doors           14 draws   10 prog  (4 nodes)
  ground           5 draws    0 prog  (1 node)
```

Read: **27 wall runs were half the frame's draw calls**, and the whole `shadow` layer — one row here,
because it was measured as a layer — was another 22 for its 23 Graphics. The census explained both.
A wall block was 5 children, of which the shading Graphics is 520-816 floats, over Pixi's 400-float
auto-batch line, so a draw call plus a program switch each way; and the cap's additive key light is a
blend-mode change, which breaks the batch on both sides. The shadow layer was 23 Graphics of 736-24258
floats — every one of them over the line, hence one draw call each and, since they are all consecutive
Graphics, no program switch at all. Two different failure modes with the same 400-float cause.

Fixed the same day, in two parts — see design/01's "Draw calls" note for the full account:

| | before | after |
| --- | --- | --- |
| draw calls | 165 | **108** |
| program switches | 102 | **98** |
| `shadow` layer draws | 22 | **1** |
| wall-block draws | 79 | **50** |
| nodes | 902 | **871** |
| Graphics re-added per frame | 168 | **114** |
| render p50 | 2.4 ms | 2.1 ms (inside the noise) |

1. The cap's additive key light is pre-multiplied into the swatch (`scene/capLight.ts`), so the cap
   is one ordinary sprite instead of two with a blend change.
2. `render/staticGraphics.ts` forces `batchMode: 'batch'` on authored-once geometry — but only on
   `ground` and `shadow`, which now have their **own render groups**. Any descendant `zIndex` write
   invalidates a whole render group, and `entities` writes one per actor per frame, so those layers
   were being re-collected 60 times a second for no reason. `shadow` keeps one measured caveat: a
   bullet or actor spawning adds a shadow to it, which *does* invalidate the group, so under sustained
   fire its batched geometry repacks most frames at about +0.12 ms. See that module's header.

Both were verified by reading the frame back out of the GL context and diffing it against the old
form rebuilt in the live scene: **0 of 1,641,600 pixels different**, twice. For a change that claims
to be a pure optimisation that is the check to run — not a screenshot, and certainly not the source.

## The third measurement: the ramps themselves (2026-08-24)

Both of the routes the section below named got done the same day, in one mechanism —
`render/shadeRamp.ts`, which draws a shading gradient as a **sampled 256-texel texture** instead of a
stack of hand-stepped rects. Same scenario, 8 live enemies at 1920x855, both reads taken at one fixed
point (room built, nothing fired, 52 children on `entities`) with `git stash` between them — the frame
TOTAL drifts by a few draws with how many doors and pickups are on screen, the per-group rows do not:

| | before | after |
| --- | --- | --- |
| draw calls | 102 | **27** |
| program switches | 93 | **17** |
| wall/door block shading | 50 draws / 50 prog | **0 / 0** |
| actor rig shading | 20 draws / 20 prog | **3 / 2** |
| unbatched Graphics | 47 (36,174 floats) | **9 (9,208 floats)** |

`FillGradient` — the obvious tool, and the one the plan below names — is still unusable here: it calls
`DOMAdapter.createCanvas()` at `fill()` time and throws in the canvas-free test environment. A
`BufferImageSource` does not, so the same smoothness arrives *with* machine-checkable ramps
(`readRampFill` recovers the ramp's segment from a fill style, `rampProfile` reads its texels).

Two things this pass learned about measuring, both of which cost a round:

- **`gl.readPixels` on this canvas is a stale frame.** `antialias: true` +
  `preserveDrawingBuffer: false` means the resolved default framebuffer only updates on a page
  composite, which never happens in a hidden tab. Hiding all 27 wall shadings and re-reading reported
  **zero** difference — a broken harness agreeing with you.
- **`renderer.extract.pixels` respects the frame you ask for, but the scene's filters are
  screen-space.** Extract a custom region and only the part matching the real on-screen position is
  lit; 25 of 27 wall blocks came back at mean luma 0, where a dark overlay is a genuine no-op.

What works, and what every number above came from — now packaged as `frameProbe.ts`, because
retyping it is how each of the mistakes below got made:

```js
// The whole recipe, with both guards:
const props = window.__game.roomBuilder.props;
const r = window.__perf.probe({
  change: () => { props.forEach(p => (p.visible = false));
                  return () => props.forEach(p => (p.visible = true)); },
});
r.trustworthy || console.warn(r.problems);   // READ THIS FIRST
r.diff;                                      // { changed, pct, meanDelta, maxDelta, bbox }
```

The raw form is still `render` -> `drawImage(app.canvas)` -> `getImageData`, read three times
(A, B, then C after the undo). That third read is not optional: this repo once shipped a swap
helper whose restore path was skipped by an `if (!node.parent) continue` guard — correct when
attaching, wrong when re-attaching a detached node — and the only symptom was a "restore check"
that equalled the A/B delta instead of zero.

**And the restore check is not sufficient (2026-08-24).** A prop-art pass spent about an hour on
diffs that all read exactly zero: hiding all 19 props, then the whole `entities` layer, then the
entire world, each time with a clean restore. Nothing was wrong with the reader. The scene under
test was never on screen — `Game.beginRun()` is reachable from the console and sets up a complete
run (phase `playing`, entities built, textures loaded) but does NOT hide the main menu, which
draws over everything in `layers.ui`. A, B and C agreed perfectly, on a frame of the menu. Note
that C-equals-A *passes* in that situation, because hiding something invisible changes nothing.

So a probe needs a third read of a different kind: a **liveness control**, some change the frame
cannot fail to react to, run BEFORE the measurement. `probeFrames` defaults it to blanking the
stage and reports `trustworthy: false` when it moves nothing. A zero diff means nothing until the
reader has demonstrated it can see the scene at all. (Pass a narrower `control` when you want to
prove a specific subtree is on screen rather than just "something is".)

And when a diff IS non-zero, ask **where** before asking how big. Binning the rig-shading deltas by
normalised radius and by angle to the key light is what found a real defect in the *old* code: its
chord bands left 3.6% of every body circle unpainted, in two crescents at the poles of the light axis.

## The fourth measurement: the arena's frame, on a real GPU (2026-08-26)

Every measurement above is a CPU number — `render p50` is the cost of *submitting* the frame. The
PvP arena needed the other half: `arena_launch` keeps **294 wall blocks and 124 pillars resident
with no culling anywhere in `client/src`**, and the draw-call work above was all tuned on a
27-run PvE room, so the open question was whether the arena's frame is actually expensive on a GPU.
It had no frame-time number at all, and the standing assumption was that getting one needed a
handset.

It did not. What it needed was **the right browser surface**: the in-app browser pane here reports
`ANGLE (Microsoft, Microsoft Basic Render Driver)` — a software rasterizer with no timer-query
extension, which is where "this machine cannot measure GPU time" came from — while real Chrome on
the same box reports `ANGLE (Intel, Intel(R) Arc(TM) Pro Graphics, D3D11)` and supports
`EXT_disjoint_timer_query_webgl2`. The claim was about a surface, not a machine.

Measured with `gpuTimer.ts`: ticker stopped, renders driven by hand, `n` renders per query, median
of the samples. 1920x855, resolution 1.0, camera settled at zoom 4.29, all menus hidden:

```
GPU frame  ~3.8-4.3 ms  (medians across runs; min 2.82, max 4.84)
draws 36   prog 20   tex 82   framebuffers 10   (~5 filter passes)
            world-only, HUD+UI hidden: draws 30   prog 17
```

Both controls fired, which is the only reason the number is quotable:

- **empty target: 0.000 ms** — the harness itself costs nothing, so the frame's cost is the scene's.
- **resolution sweep: 3.20 / 4.31 / 5.93 ms at 0.5 / 1.0 / 2.0**, min-max bands non-overlapping
  (res-0.5 max 3.66 < res-2.0 min 5.42). The timer demonstrably responds to load.

And that sweep is the finding, not just the control: **16x the pixels for 1.85x the time.**
`resolutionSplit` puts it at **~3.0 ms fixed against ~0.7 ms of fill** at native resolution. The
arena frame is not fill-bound, so it is not a shader problem, and the render-quality tiers (which
exist to remove full-viewport passes) are aimed at the wrong 20%.

Where the fixed cost is, by hiding one render-group root at a time — full frame 4.05 ms:

| layer | cost | share |
| --- | --- | --- |
| `ground` | **2.28 ms** | **56%** |
| `shadow` | 0.63 ms | 16% |
| `entities` (294 wall blocks + 124 pillars) | 0.39 ms | 10% |

**The walls and pillars are a tenth of the frame.** The floor is more than half of it, and
`ground` measured **flat across the whole 16x pixel range** (2.15 / 2.17 / 2.76 ms) — it is
geometry submission, not fill.

`census()` names the mechanism in one line. `buildGroundLayer` paints `drawRoomWash` +
`drawFloorMottle` + `drawFloorDecals` **per room** into two `staticGraphics()` Graphics, and
`arena_launch` has 60 room rects over 4485x3462 px of floor:

```
1069 Graphics, 7 NOT batched
    Graphics   284966 floats  1375 fills  batch      <- floorDark
    Graphics   265566 floats  1343 fills  batch      <- floorLight (blendMode 'add')
    Graphics    49392 floats  2646 fills  batch      <- shadow
```

`staticGraphics.ts`'s own header records the numbers its policy was measured against: *"a room's
shared wall-shadow Graphics is ~24k floats, the floor's decal pass ~50k"*, and on `ground`/`shadow`
forcing `batch` bought -24 draw calls for -0.08 ms. Those same two passes are **285k and 266k
floats** here — 5.7x and 11x larger — and all of it is submitted every frame regardless of where
the camera is. The policy is not wrong; it is being applied an order of magnitude outside the
content it was measured on. That is the thing to fix, and it is worth ~5x what culling the walls
and pillars would buy.

Three method notes, each of which cost a round:

- **Attribute by hiding a render-group ROOT, never a child inside one.** Hiding the 322 floor
  sprites *inside* `layers.ground` measured **slower** than leaving them visible (4.52 vs 4.14 ms):
  the toggle invalidates the group and the batcher repacks ~550k floats, which costs more than the
  geometry removed. Hiding `layers.ground` itself skips the group with its cached instructions
  intact and is trustworthy. Only the group-root rows above are quotable for that reason.
- **`ticker.FPS` and `PerfMonitor` are both invalid in a background tab.** `document.hidden` was
  true throughout; the browser throttles rAF, so `FPS` read 60.2 while the sampler had accumulated
  333 ms of frames in six seconds of wall time, and every window is `discarded` by design. The GPU
  timer is unaffected because it does not use rAF — but see the next point.
- **A backgrounded tab eventually makes the GPU clock unusable.** A later re-measurement returned
  `GPU_DISJOINT_EXT` on **every** sample (25 of 25 discarded) once the window had been fully
  behind another app for a while. That is the extension refusing to lie, and the harness reporting
  `ms: null` rather than a plausible number is the correct outcome — the fix is to foreground the
  window, not to relax the check. Relatedly, `setTimeout` is clamped to ~1 s in a background tab,
  so the result poll must not yield; `gpuTimer` polls synchronously after `gl.finish()` for exactly
  this reason, and reading `GPU_DISJOINT_EXT` *clears* it, so it must be read once per query.

Scope, stated rather than implied: this is a desktop Intel Arc GPU, and it says the arena is
comfortable here (~4 ms of a 16.7 ms budget). It does **not** answer design/04's on-device
question, and the reason it does not is now sharper rather than vaguer — the cost is
resolution-independent geometry submission, which is the half that gets relatively *worse* on a
mobile GPU, not better. What changed is that a device run now has a specific thing to check.

## What the numbers say to attack next

~90 of the remaining 98 program switches and 90 of the 108 draw calls are Graphics inside the
Y-sorted `entities` layer (wall shading 50, actor rig shading 22, doors 10). All of it is static
geometry that goes unbatched only because it is *large*.

Forcing the batch mode there was tried and **rejected on measurement**: it works (-50 draws, -50
program switches) but `entities` is invalidated every frame, so the batcher repacks ~18k floats and
2247 fills per frame — **+0.7 ms on a 2.4 ms render**. `render/staticGraphics.ts` documents the rule
that came out of it, and `RoomBuilder.test.ts` has a test whose whole job is to stop the next person
reaching for it.

*(Superseded by the section above — this is the plan as it stood, kept because its reasoning was right
and its choice of tool was not.)*

The route with a number behind it is to get that geometry *under* the 400-float line rather than to
override it. Probed live by swapping in a smaller shading geometry: the frame goes to **52 draws /
43 programs**. `wallShadingSurfaces.ts` draws every ramp as 12-20 separate stepped-alpha rects; one
`FillGradient` quad per ramp would be smaller, cheaper to pack *and* smoother than the banding. Not
pixel-identical, so it needs a look before it ships.

Still worth saying: none of this is currently costing frame time (render p50 2.1 ms of a 16.7 ms
budget). It is headroom for a low-end mobile GPU, where program switches cost far more than they do
here — which is also why the CPU side of every candidate was measured, not assumed.

## The fifth measurement: the floor was made cullable, and the fourth measurement's diagnosis was wrong (2026-08-26)

The section above ends by naming `layers.ground` as the thing to fix and gives the mechanism: the
floor's per-room wash/mottle/decals accumulated into two whole-map `Graphics` (284,966 and 265,566
floats on `arena_launch`) and all of it was submitted every frame however far away the camera was.
That much is true, and it was fixed: `groundLayer.ts` now mounts one piece per room (per region, per
door), each tagged with the rect it paints, and `groundCulling.ts` switches the off-screen ones off
from `FxController.updateCamera`. Standing in the arena's first room:

```
batcher packed, layers.ground   101,304 floats / 49,962 indices   (13 of 374 pieces visible)
                without the cull  1,730,364 floats / 845,796 indices
```

**17x less vertex data and 17x fewer triangles, and the GPU frame did not measurably move.**
Interleaved A/B, cull on against every piece forced visible, 13 samples of 6 renders each:

```
cull on    4.07 ms   band 2.68-4.83
cull off   4.28 ms   band 4.11-4.82     <- bands OVERLAP
ground hidden entirely  2.16 ms
```

By the standard the fourth measurement set for itself — a reading is quotable when the min/max bands
do not overlap — that is a null result, not a 5% win. And it is the finding, because it falsifies the
diagnosis it was meant to confirm: **the ground layer's ~2 ms is not vertex or triangle work.**
Cutting the submitted triangles by 17x changed nothing; hiding the layer outright still costs 2 ms.
Nor is it draw calls — the whole layer is 3 of the frame's 42.

### The control that was wrong

The fourth measurement's central inference was *"16x the pixels for 1.85x the time, therefore the
frame is not fill-bound, therefore the fixed cost is geometry submission."* The sweep behind it
varies `renderer.resolution`. **Every filter in this scene has `resolution: 1`** — Pixi's `Filter`
default, which does NOT follow the renderer's:

```
layers.lit    SceneLightFilter        resolution 1     <- ground + shadow + entities are INSIDE this
layers.fx     BlurFilter              resolution 1
layers.world  Vignette, Chromatic     resolution 1
```

So almost the whole scene is rendered into filter targets pinned at 1x, and a renderer-resolution
sweep scales the final blit and little else. "Resolution-independent" was a statement about the
filter chain, not about the scene's fill. The empty-target control and the disjoint checks were all
sound; the *interpretation* of the sweep was not, and one wrong control was enough to point a whole
pass at the wrong half of the frame.

### What to do next, and how to measure it

The question the sweep should have asked is not "more pixels per unit of scene" but "more scene per
pixel": vary the on-screen AREA the overlays cover, at a fixed resolution. Two cheap experiments,
both A/B-able live:

- Move the camera so a room's blended overlays cover a quarter of the viewport rather than all of it,
  and re-run the same interleaved A/B. If the cost tracks covered area, it is fill inside the filter
  chain and the render-quality tiers are aimed at the right thing after all.
- Toggle `layers.lit`'s filter off entirely and repeat. `ground` hidden vs visible costs ~2 ms with
  five filter passes live over it; the same delta with no filter says the cost is the floor's own
  blending, and a much smaller one says the floor is expensive only because the passes above it have
  to read what it wrote.

Two smaller notes from the same sitting, both of which cost a round:

- **`gl.finish()`-bounded wall-clock is not a cross-check on the timer query.** Submitting 40 renders
  and timing to a `finish()` reported ~0.4 ms/frame against the timer's 4.3, and then FAILED its own
  resolution control (0.37 / 0.58 / 0.38 / 1.01 ms at 0.5 / 1 / 2 / 3, non-monotonic). The timer
  query passes that control; this does not. Do not use it to "confirm" a GPU number.
- **In a background tab each `sample()` costs ~1 s of wall time**, because the result poll's
  `setTimeout` fallback is clamped there. It does not corrupt the reading, but it caps a single
  console evaluation at roughly six samples before the CDP call times out — accumulate into a handle
  on `window` and call a stepper repeatedly rather than writing one long loop.
