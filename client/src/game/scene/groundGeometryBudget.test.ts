/**
 * The ground stage's BATCH-POLICY ENVELOPE, over real shipped maps (2026-08-26).
 *
 * Why this file exists. `buildGroundLayer` mounts its four overlay passes with
 * `staticGraphics()`, which forces `batchMode: 'batch'` and so overrides Pixi's 400-float
 * auto-batch cutoff unconditionally. That override is a *measured* trade, and
 * `render/staticGraphics.ts`'s header states the content it was measured on: **"a room's shared
 * wall-shadow Graphics is ~24k floats, the floor's decal pass ~50k"**, where forcing `batch` on
 * `layers.ground`/`layers.shadow` bought -24 draw calls for -0.08 ms.
 *
 * Nothing checked that the content stayed inside that envelope, and it did not. On 2026-08-26 a
 * GPU timer-query pass (`perf/gpuTimer.ts`, `perf/README.md`'s fourth measurement) found
 * `layers.ground` costing **2.28 ms of a 4.05 ms arena frame — 56%**, resolution-INDEPENDENT, i.e.
 * geometry submission rather than fill. `arena_launch`'s two floor passes had grown to **291,722 and
 * 274,282 floats**, ~6x and ~11x the numbers the policy was validated at, and all of it is submitted
 * every frame regardless of where the camera is. For comparison the same frame's 294 wall blocks and
 * 124 pillars together cost 0.39 ms (10%).
 *
 * None of that needed a GPU to see. The float counts come out of the REAL `GraphicsContextSystem`
 * headlessly — `staticGraphics.test.ts` already drives it that way — so this is a property that was
 * offline-measurable the whole time and simply had no test. That is the gap this file closes, and
 * the reason it is a sweep over `ARENA_CATALOG` rather than a fixture: a fixture cannot notice that
 * a per-room cost met a 60-room map.
 *
 * Two bounds, deliberately of different kinds, because the 2026-08-26 batteries kept showing that a
 * numeric bound measured on one body of content passes vacuously on the next:
 *
 *  1. **A per-ROOM rate** (portable). These passes are painted per room, so their cost is
 *     `rooms x rate`. The rate is the part a 3-room dev fixture can still falsify, which makes it
 *     the bound that would have caught this at authoring time — adding a fifth per-room pass moves
 *     it immediately, on any map.
 *  2. **A per-GRAPHICS total** (content-specific), swept over every catalog map, with an explicit
 *     exemption list. `arena_launch` is over it today, so it is exempted AND pinned: the test
 *     asserts it still FAILS the budget, which makes the known defect the gate's own control (the
 *     same trick `arenaQuality`'s `landing_basic` assertion uses), and caps it so it cannot grow
 *     while the fix is outstanding.
 *
 * Scope, stated rather than implied: the harness hands `buildGroundLayer` no `wallRects` and the
 * real `doorRects`. Omitting wall rects can only ADD floats (they suppress rubble — see
 * `groundLayer.test.ts`'s "keeps rubble off the wall footprints"), so every total here is an upper
 * bound on the shipped one, which is the safe direction for a budget. Cross-checked against the
 * live browser census of the same map: grid (17,280) and room-light (6,400) match EXACTLY, and the
 * two floor passes read 2-3% ABOVE the browser's 284,966 / 265,566 — the predicted direction, which
 * is what says this harness is measuring the same pipeline the GPU pays for rather than a mirror
 * of it.
 */
import { describe, it, expect } from 'vitest';
import { Container, Graphics, GraphicsContextSystem, Texture, TextureSource } from 'pixi.js';
import { createGameState } from '@dd/engine/state/GameState';
import { biomePalette } from '../theme';
import { buildGroundLayer, floorRegionsPx, roomRectsPx } from './groundLayer';
import { ARENA_CATALOG, type ArenaId } from '../match/arenaCatalog';
import { fpToPx, PX_PER_GRID } from '../coords';
import { AUTO_BATCH_VERTEX_LIMIT } from '../../perf/drawAttribution';
import type { RectPx } from './wallGeometry';
import { Layers } from './layers';
import { Backdrop } from './Backdrop';
import { RoomBuilder } from './RoomBuilder';

/**
 * Per-Graphics ceiling for batch-forced ground geometry, in floats.
 *
 * Anchored to `staticGraphics.ts`'s own measurement (~50k for the floor's decal pass, where the
 * policy was a win) and rounded up to give authored content real room: this is "stay within an
 * order of the content this override was validated on", not a tuned optimum. It is deliberately
 * NOT transcribed from what any map scores today — the margin assertions below exist so nobody
 * can quietly retune it to whatever the content happens to be.
 */
const FLOOR_PASS_FLOAT_BUDGET = 64_000;

/** Side of the reference room the per-room rate below is measured at. */
const REF_ROOM_PX = 512;

/**
 * Floats per REF_ROOM_PX-square room (measured 5,219-5,574 across 1..60 of them).
 *
 * Scoped to that room size on purpose, because the rate is NOT room-invariant: the passes count
 * their blobs from room AREA (`Math.max(2, Math.round(area / MOTTLE_PX_PER_BLOB))` and friends), so
 * the same code yields ~5.3k floats for a 512px room, ~13.9k at 1024px and ~55.5k at 2048px. An
 * earlier draft of this file put a bare 3k-8k band here and would have failed on any map authored
 * with bigger rooms while the real defect sailed through — the exact "informative bound measured on
 * one body of content" trap the 2026-08-26 batteries kept turning up. What gates the shipped
 * content is the two-sided pin on the real builder further down; this band only holds the COST
 * MODEL (linear in room count) in place.
 */
const PER_ROOM_FLOAT_BAND = { min: 3_000, max: 8_000 };

/**
 * Maps allowed to exceed {@link FLOOR_PASS_FLOAT_BUDGET}, with the number each is pinned at.
 *
 * An explicit list, so adding a map puts it under the budget automatically and exempting one is a
 * visible edit here — the same direction `ARENA_HARNESS_IDS` is scoped in, and for the same reason:
 * a gate scoped by a property the offending content happens to have would silently stop covering
 * the next offender.
 */
const OVER_BUDGET: Partial<Record<ArenaId, { pinnedFloats: number; why: string }>> = {
  arena_launch: {
    // 291,722 measured 2026-08-26 (274,282 of it the base wash/mottle/decals, the rest door wear).
    // Capped just above, so the known defect cannot grow while the fix is outstanding; DROP this
    // entry when the per-district split lands — do not raise it.
    pinnedFloats: 300_000,
    why: '60 rooms x ~4.6k floats of per-room wash/mottle/decals; costs 2.28 ms of a 4.05 ms frame',
  },
};

/** Pixi's real batching decision, driven by the smallest renderer it accepts — same fake as
 *  `staticGraphics.test.ts`, which is where that shape is justified. */
function contextSystem(): GraphicsContextSystem {
  const renderer = {
    uid: 1,
    limits: { maxBatchableTextures: 16 },
    gc: { addResourceHash: () => undefined, now: 0 },
  } as never;
  return new GraphicsContextSystem(renderer);
}

function tex(size: number): Texture {
  return new Texture({ source: new TextureSource({ width: size, height: size }) });
}

interface GroundGeometry {
  rooms: number;
  /** Floats per mounted Graphics, largest first. */
  floats: number[];
  /** True only if every mounted Graphics is batch-forced — otherwise a budget on them is a
   *  budget on nothing in particular. */
  allBatchForced: boolean;
  largest: number;
}

/** `buildGroundLayer` over a set of room rects, measured through the real context system. */
function measure(
  rooms: readonly RectPx[],
  regions: readonly RectPx[],
  doorRects: readonly RectPx[] = [],
): GroundGeometry {
  const ground = new Container();
  buildGroundLayer(ground, {
    rooms: rooms as RectPx[],
    floorRegions: regions as RectPx[],
    wallRects: [],
    doorRects: doorRects as RectPx[],
    palette: biomePalette('ember'),
    floorTex: tex(256),
  });
  const sys = contextSystem();
  const gfx = ground.children.filter((c): c is Graphics => c instanceof Graphics);
  const floats = gfx
    .map((c) => sys.updateGpuContext(c.context).geometryData.vertices.length)
    .sort((a, b) => b - a);
  return {
    rooms: rooms.length,
    floats,
    allBatchForced: gfx.every((c) => c.context.batchMode === 'batch'),
    largest: floats[0] ?? 0,
  };
}

/** One catalog map, through the real producers a match resolves against. */
function measureArena(id: ArenaId): GroundGeometry {
  const map = ARENA_CATALOG[id];
  const state = createGameState({ seed: 1, worldW: 1, worldH: 1, waves: [], arena: map });
  const w = fpToPx(state.worldW);
  const h = fpToPx(state.worldH);
  // `passageGrid` is ABSOLUTE grid, unlike a room's `solids` — the same conversion `RoomBuilder`
  // does when it unions arena passages into the door list.
  const doorRects = map.doors.map((d) => ({
    x: d.passageGrid.x * PX_PER_GRID,
    y: d.passageGrid.y * PX_PER_GRID,
    w: d.passageGrid.w * PX_PER_GRID,
    h: d.passageGrid.h * PX_PER_GRID,
  }));
  return measure(roomRectsPx(state, w, h), floorRegionsPx(state, w, h), doorRects);
}

/** N identical rooms on a grid — isolates the per-room rate from any one map's authoring. */
function synthetic(n: number, side = REF_ROOM_PX): GroundGeometry {
  const rooms = Array.from({ length: n }, (_, i) => ({
    x: (i % 10) * (side + 88),
    y: Math.floor(i / 10) * (side + 88),
    w: side,
    h: side,
  }));
  return measure(rooms, rooms);
}

describe('the ground stage is painted PER ROOM, and that is what its cost scales with', () => {
  it('grows linearly in room count, at a bounded per-room rate', () => {
    const counts = [1, 4, 12, 30, 60];
    const rates = counts.map((n) => {
      const m = synthetic(n);
      return { n, largest: m.largest, perRoom: m.largest / n };
    });
    for (const { n, perRoom } of rates) {
      expect(perRoom, `${n} rooms`).toBeGreaterThan(PER_ROOM_FLOAT_BAND.min);
      expect(perRoom, `${n} rooms`).toBeLessThan(PER_ROOM_FLOAT_BAND.max);
    }
    // Linear, not merely monotonic: the rate must be flat across a 60x range in room count. A
    // per-room pass that started scaling super-linearly (say a decal pass that consulted every
    // other room) would keep every total under its budget on a small map and blow up on a big one.
    const perRoom = rates.map((r) => r.perRoom);
    expect(Math.max(...perRoom) / Math.min(...perRoom)).toBeLessThan(1.25);
  });

  it('is one whole-map Graphics per pass, so the total is the whole map every frame', () => {
    // The cost model above only holds because these passes accumulate into ONE context each,
    // rather than one per room. That is also exactly why the total cannot be culled by camera
    // today, and therefore the thing a fix has to change.
    const one = synthetic(1);
    const sixty = synthetic(60);
    expect(one.floats).toHaveLength(sixty.floats.length);
    expect(sixty.largest).toBeGreaterThan(one.largest * 40);
  });

  it('forces the batch on every pass it mounts — or these budgets are about nothing', () => {
    // If `staticGraphics()` stopped being used here, Pixi's own 400-float cutoff would apply and
    // the geometry would cost draw calls instead of a repack. Either is a real design, but the
    // budgets in this file are written for the batch-forced one.
    expect(synthetic(12).allBatchForced).toBe(true);
    expect(measureArena('arena_launch').allBatchForced).toBe(true);
    // ...and every pass is far past the auto cutoff, which is why the override is load-bearing.
    for (const f of synthetic(12).floats) expect(f).toBeGreaterThan(AUTO_BATCH_VERTEX_LIMIT);
  });
});

describe('every catalog map stays inside the envelope staticGraphics() was measured on', () => {
  const ids = Object.keys(ARENA_CATALOG) as ArenaId[];

  it('sweeps the whole catalog, not a hand-picked subset', () => {
    // Guards the sweep itself: an exemption list is only fail-safe if the thing it exempts FROM
    // actually enumerates everything.
    expect(ids).toContain('arena_launch');
    expect(ids.length).toBeGreaterThanOrEqual(2);
  });

  for (const id of ids) {
    const exempt = OVER_BUDGET[id];

    if (!exempt) {
      it(`${id}: every ground pass is under the budget, with margin`, () => {
        const m = measureArena(id);
        expect(m.largest).toBeLessThan(FLOOR_PASS_FLOAT_BUDGET);
        // State the margin, so a future map that creeps up on the budget is visible as a shrinking
        // number here rather than as a still-passing test.
        expect(FLOOR_PASS_FLOAT_BUDGET / m.largest).toBeGreaterThan(2);
      });
      continue;
    }

    it(`${id}: is over the budget, which is what makes this gate a real one`, () => {
      // The exemption's own control. If this map ever comes back UNDER the budget, either the fix
      // landed (delete the entry) or the gate stopped measuring anything — and a test that only
      // ever asserted "under budget" could not tell those apart from a passing sweep.
      const m = measureArena(id);
      expect(m.largest).toBeGreaterThan(FLOOR_PASS_FLOAT_BUDGET);
      expect(m.largest / FLOOR_PASS_FLOAT_BUDGET).toBeGreaterThan(4);
    });

    it(`${id}: does not grow past what it was pinned at`, () => {
      const m = measureArena(id);
      expect(m.largest).toBeLessThanOrEqual(exempt.pinnedFloats);
      // And the pin is not slack enough to hide real growth: it sits within 10% of today's score,
      // so the next per-room pass added to this map fails here instead of being absorbed.
      expect(exempt.pinnedFloats / m.largest).toBeLessThan(1.1);
    });
  }

  it('the smallest catalog map cannot reach the budget, so its pass is not evidence', () => {
    // Honest about what a green `landing_basic` proves: with 3 rooms it scores 13,750, ~4.6x under
    // the budget, so it would keep passing through a per-room regression of nearly 5x. The per-room
    // rate above is the bound that actually covers it; this asserts the limitation rather than
    // leaving it implied.
    const m = measureArena('landing_basic');
    expect(m.largest * 4).toBeLessThan(FLOOR_PASS_FLOAT_BUDGET);
    expect(m.largest * 6).toBeGreaterThan(FLOOR_PASS_FLOAT_BUDGET);
  });
});

/**
 * Pinned from the REAL `RoomBuilder.build` on `arena_launch`, 2026-08-26. These reproduce the live
 * browser `census()` of the same map EXACTLY (284,966 / 265,566 / 17,280 / 6,400 on ground; 49,392
 * on shadow), which is what says the headless path measures the shipped frame and not a lookalike.
 */
const REAL = {
  /** The additive pass (mottle-light + door wear), and the multiply pass (wash + mottle-dark +
   *  decals). BOTH are pinned, two-sided: an earlier draft bounded only the larger one, and a
   *  battery then showed three mutants walking straight through it — a doubled stain density, a
   *  doubled mottle density and `drawRoomWash` deleted outright all land on the SECOND pass. */
  groundPasses: [284_966, 265_566],
  shadowLargest: 49_392,
  /** `staticGraphics.ts`'s stated envelope for the wall-shadow pass, for comparison. */
  shadowMeasuredAt: 24_000,
};

/**
 * The pins above are EXACT, not banded, and that is a deliberate choice with a cost.
 *
 * Deterministic pipeline, fixed seed, fixed authored map: these integers reproduced byte-identically
 * across runs and matched the live browser `census()` exactly, so there is no noise for a tolerance
 * to absorb — a tolerance only decides how much silent drift is allowed through. A 2% band was tried
 * first and a battery walked `drawRoomWash` deletion straight past it: removing that pass moves
 * `groundPasses[1]` by 480 floats, **0.18%**, which is exactly the size of change a band is worst at
 * seeing. Nothing else in the suite noticed it either.
 *
 * So: if you changed the floor art on purpose, re-measure and update these numbers in the SAME
 * commit as the art change. That is the intended workflow, the same one `arenaWallCoverage.test.ts`
 * uses for its 294/124/74 counts and `checkFileLength` uses for its baseline — the test is here to
 * make a geometry change visible, not to hold the art still.
 */

/** Every batch-forced Graphics on one layer of a real build, floats descending. */
function layerFloats(layer: Container, sys: GraphicsContextSystem): number[] {
  return layer.children
    .filter((c): c is Graphics => c instanceof Graphics)
    .map((c) => sys.updateGpuContext(c.context).geometryData.vertices.length)
    .sort((a, b) => b - a);
}

describe('the REAL builder, not the mirror in this file', () => {
  // Every case above calls `buildGroundLayer` directly with rects this file assembles. That is a
  // MIRROR of the pipeline, and 2026-08-26 is the day this repo learned what that costs: a
  // door-clip fix was verified against a harness that mirrored `RoomBuilder.build`'s sequence,
  // scored perfectly, and the shipping code did nothing at all. So the aggregate is also read back
  // off the real call site — `RoomBuilder` is headlessly constructible on `Layers` + `Backdrop`,
  // the same way `arenaWallCoverage.test.ts` drives it.
  const built = (() => {
    const layers = new Layers();
    const rb = new RoomBuilder(layers, new Backdrop(layers));
    const state = createGameState({ seed: 1, worldW: 1, worldH: 1, waves: [], arena: ARENA_CATALOG.arena_launch });
    rb.build(state);
    const sys = contextSystem();
    return { ground: layerFloats(layers.ground, sys), shadow: layerFloats(layers.shadow, sys) };
  })();

  it('ground: both shipped passes are over the budget, and pinned two-sided', () => {
    // Two passes over the budget, not one — the fix has to address both, and a change that merged
    // them into a single context would look like an improvement here while costing the same.
    expect(built.ground.filter((f) => f > FLOOR_PASS_FLOAT_BUDGET)).toHaveLength(2);
    // Exact, both passes: growth is the regression this file exists for, and a DROP means a
    // per-room pass quietly stopped running — which no other test in the suite noticed.
    expect(built.ground.slice(0, 2)).toEqual(REAL.groundPasses);
    for (const f of REAL.groundPasses) expect(f).toBeGreaterThan(FLOOR_PASS_FLOAT_BUDGET);
  });

  it('shadow: inside the budget, but recorded against the envelope it was measured at', () => {
    // Not a defect today, and the reason to pin it anyway: it is the SAME drift as ground's, two
    // doublings behind. `staticGraphics.ts` measured this pass at ~24k; the arena runs it at ~49k.
    expect(built.shadow[0]).toBe(REAL.shadowLargest);
    expect(built.shadow[0]).toBeLessThan(FLOOR_PASS_FLOAT_BUDGET);
    expect(built.shadow[0]).toBeGreaterThan(REAL.shadowMeasuredAt); // ~2x, stated rather than implied
    // One shared context plus many small per-entity ones: a change that made them all large would
    // multiply the repack cost without moving the max.
    expect(built.shadow.length).toBeGreaterThan(100);
    expect(built.shadow[1]!).toBeLessThan(built.shadow[0] / 10);
  });

  it('every arena room yields the SAME mottle count under a halved density constant', () => {
    // Not a budget assertion — a content one, and the only mutant this file could not kill.
    // Halving `MOTTLE_PX_PER_BLOB` (260,000 -> 130,000) leaves `arena_launch` byte-identical. That
    // looked like a test gap and is not: the count is `Math.max(2, Math.round(area / PX_PER_BLOB))`,
    // and across all 60 rooms (82,944 to 286,720 px, median 143,360) BOTH constants land on 2 — the
    // small rooms clamp to the floor, and even the two rooms over 260,000 px round 2.21 back down to
    // 2. That constant's comment promises "~one blob per 510x510 of floor"; on this map it never gets
    // to mean anything, and the mottle is a flat 2 blobs per polarity per room regardless of size.
    //
    // Asserted as the exact equivalence rather than as a bound, so the next battery finds the answer
    // here instead of re-deriving it, and so a map authored with rooms big enough to leave the floor
    // shows up as a visible change.
    const state = createGameState({ seed: 1, worldW: 1, worldH: 1, waves: [], arena: ARENA_CATALOG.arena_launch });
    const rooms = roomRectsPx(state, fpToPx(state.worldW), fpToPx(state.worldH));
    const MOTTLE_PX_PER_BLOB = 260_000; // mirrored from floorRender.ts, deliberately
    const count = (area: number, per: number) => Math.max(2, Math.round(area / per));
    const counts = rooms.map((r) => count(r.w * r.h, MOTTLE_PX_PER_BLOB));
    const halved = rooms.map((r) => count(r.w * r.h, MOTTLE_PX_PER_BLOB / 2));
    expect(rooms).toHaveLength(60);
    expect(counts).toEqual(halved);
    expect(new Set(counts)).toEqual(new Set([2]));
  });

  it('the mirror in this file still mirrors — above the real number, and close to it', () => {
    // The check that fails the day `buildGroundLayer` gains a step the harness does not model.
    // Direction is asserted, not just closeness: the harness omits `wallRects`, which suppress
    // rubble, so it must come out slightly HIGHER. A harness that drifted BELOW the real number
    // would mean it is missing a pass, which is the failure that hid the door-clip fix.
    const harness = measureArena('arena_launch').largest;
    expect(harness).toBeGreaterThanOrEqual(built.ground[0]!);
    expect(harness / built.ground[0]!).toBeLessThan(1.1); // measured 1.024
  });
});
