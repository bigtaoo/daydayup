# `src/perf` — client performance analysis

Ported from the sibling project `funny` (`client/src/cache/PerfMonitor.ts` +
`client/src/cache/MemoryMonitor.ts`), adapted to this client's Pixi v8 renderer and to the
fact that daydayup has no telemetry backend to send findings to.

## What it is

| file | role |
| --- | --- |
| `frameSampler.ts` | Pure windowed sampler: fps, frame/update/render percentiles, long-task busy ratio, hidden-tab discard, sustained-low-fps streak. No Pixi, no DOM. |
| `glProbe.ts` | Counts the WebGL commands that break batching (draw calls, program/texture/framebuffer binds) per frame. |
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

## What the numbers say to attack next

Draw calls fell by only 18 — the ~157 that remain are the environment itself (wall blocks
are Containers of several Graphics each, and Graphics do not batch with Sprites), which is
also where the 95 program switches come from. That is the next bottleneck, and unlike the
filter one it is a content/geometry problem rather than an architecture one. It is *not*
currently costing frame time (render p50 2.4ms of a 16.7ms budget), so it is recorded, not
scheduled.
