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

What works, and what every number above came from:

```js
const app = window.__game.app;
const read = () => { app.renderer.render(app.stage);
  const c = document.createElement('canvas'); c.width = app.canvas.width; c.height = app.canvas.height;
  c.getContext('2d').drawImage(app.canvas, 0, 0);
  return c.getContext('2d').getImageData(0, 0, c.width, c.height); };
const A = read();            // new form
swapInOldForm();
const B = read();            // old form, rebuilt live
swapBackToNewForm();
const C = read();            // MUST equal A exactly, or the numbers mean nothing
```

That third read is not optional. This pass shipped a swap helper whose restore path was skipped by an
`if (!node.parent) continue` guard — correct when attaching, wrong when re-attaching a detached node —
and the only symptom was a "restore check" that equalled the A/B delta instead of zero.

And when a diff IS non-zero, ask **where** before asking how big. Binning the rig-shading deltas by
normalised radius and by angle to the key light is what found a real defect in the *old* code: its
chord bands left 3.6% of every body circle unpainted, in two crescents at the poles of the light axis.

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
