/// <reference types="node" />
/**
 * The five wall-content sweeps, run against the map a PvP match actually builds.
 *
 * **WHY THIS FILE EXISTS.** `wallComposition.test.ts`, `occlusionCoverage.test.ts`,
 * `doorStandCoverage.test.ts`, `doorSpillCoverage.test.ts` and `doorOcclusionCoverage.test.ts`
 * are this repo's answer to a failure mode it has shipped: a geometric predicate that reads
 * correctly, passes its unit tests on hand-built fixtures, and silently matches NOTHING in the
 * real level (`wallGeometry`'s old `w > h` guard left 1 wall standing where 32 should). Each of
 * them answers it by sweeping REAL content through the REAL pipeline.
 *
 * Every one of them sweeps `EMBER_L1_FLOORS` — the five PvE floors — and nothing else. The
 * arena had no walls at all until `arena_launch` was authored (2026-08-25), so there was
 * nothing to sweep; now there is, and it is a different shape of content by an order of
 * magnitude: 60 rooms against a PvE floor's 5-8, 25 distinct footprints, 492 authored wall
 * rects, rooms adjacent on both axes (a PvE floor has 11 stacked boundaries in total; this map
 * has 44), 124 pillars, and 74 authored passages. A rule tuned on 27 runs of level 1 can be
 * vacuous, or wrong, or merely out of headroom here without anything else noticing.
 *
 * So: `arena_launch` through `buildArenaGeometry` → `wallTier` → `mergeWallRuns` → `wallJoins`
 * (`RoomBuilder.build`'s own sequence for an arena, which is the same sequence minus the door
 * fixtures — see the door section below, where that difference IS the finding), then the same
 * questions the five files ask of the PvE floors. Offline, deterministic, ~1s.
 *
 * **What this pass found** (full account in ROADMAP's "The Seven Districts"):
 *
 *   1. The three DOOR sweeps have no subject at all here. `GameState` populates `dungeonDoors`
 *      only in dungeon mode, so an arena builds zero door fixtures and `RoomBuilder`'s
 *      `doorRectsPx` is empty — `bordersDoorNorth` never fires, `doorClip`/`effectiveWallHeight`
 *      never run, and 36 of the map's 74 authored passages are completely buried under the cap
 *      of the wall run standing south of them. Measured, with the fix's own invariants checked
 *      against arena geometry: wiring the passages takes that to 10 partly covered, worst 40 px.
 *   2. `occludes` fires for 4 blocks at once at exactly one spot — a 2x2 pillar cluster — where
 *      `occlusionCoverage.test.ts` asserts at most 2. Walls alone still never exceed 2.
 *   3. The arena hides the player three times as often as a PvE floor (11.6% of standable floor
 *      fully hidden vs 3.3%), and takes the deep fade 7x as often (1.37% vs 0.2%).
 *   4. The shading float budget has half the headroom it does in PvE: the worst arena block is
 *      208 floats against a PvE worst of 120, which is over `wallComposition.test.ts`'s own
 *      `< AUTO_BATCH_VERTEX_LIMIT / 2` bound. Still batchable (the line is 400), but the bound
 *      that guards it was measured on the wrong content.
 *   5. One PvE case genuinely does not occur here (a room boundary only PARTLY covered by the
 *      room above, which `wallTier` answers per rect and `mergeWallRuns` then refuses to merge).
 *      Asserted as absent WITH its precondition, so "0" reads as a fact about the map rather
 *      than as a sweep that stopped looking.
 *
 * Deliberately NOT here, and the reason this file exists before a browser is opened: whether any
 * of it LOOKS right. This is the list of places to point a camera at.
 */
import { describe, it, expect } from 'vitest';
import { GraphicsContextSystem } from 'pixi.js';
import { createGameState, PLAYER_BASE } from '@dd/engine';
import { ARENA_CATALOG, ARENA_IDS, type ArenaId } from '../match/arenaCatalog';
import { fpToPx, PX_PER_GRID } from '../coords';
import {
  WALL_H_KERB,
  WALL_HEIGHT,
  wallHeight,
  wallTier,
  type RectPx,
  type WallTier,
} from './wallGeometry';
import {
  NO_JOINS,
  blockCapTop,
  bordersDoorNorth,
  doorFlankTier,
  effectiveWallHeight,
  mergeWallRuns,
  wallJoins,
  type WallJoins,
  type WallRun,
} from './wallRuns';
import { faceCrownFraction } from './wallTone';
import { roomRectsPx } from './groundLayer';
import { pillarArtExtent } from './pillarRender';
import { needsDeepFade, occludes, type Occluder } from './occlusion';
import { drawBlockShading } from './wallRender';
import { AUTO_BATCH_VERTEX_LIMIT } from '../../perf/drawAttribution';
import { readRampFill, resetShadeRampCache, shadeRampCacheSize } from '../../render/shadeRamp';

/** An arena has no `dungeonConfig`, so `RoomBuilder` builds it with the neutral element —
 *  and the crown line a corner stops under is per element (`FACE_CROWN_ROWS`). Passing fire's
 *  here, as the PvE sweeps correctly do, would test a floor the game never draws. */
const ARENA_ELEMENT = 'neutral';
const CROWN = faceCrownFraction(ARENA_ELEMENT);

/** The drawn character, in world px — the same three numbers `occlusionCoverage.test.ts` uses
 *  (the shipped rig's own measurements, pinned off the real skin by `Actor.test.ts`). */
const BODY_H = 32;
const HALF_W = 12.96;
const CLEARANCE = fpToPx(PLAYER_BASE.solidRadius);
/** Sweep step in world px — a quarter of a grid cell, as in the PvE sweep. */
const STEP = 8;
const HIDDEN_FRACTION = 0.5;

interface Block {
  box: Occluder;
  tier: WallTier | 'pillar';
  /** The block's own footprint, for the "where does a perimeter run fire from" check. */
  rect: RectPx;
}

interface Arena {
  id: ArenaId;
  runs: WallRun[];
  joins: WallJoins[];
  blocks: Block[];
  /** Room rects in world px, with their authored ids — the ids are what makes a finding a place
   *  a camera can be pointed at rather than a coordinate. */
  rooms: Array<RectPx & { id: string }>;
  /** The raw (pre-merge) wall rects, which is what the player collides with. */
  walls: RectPx[];
  pillars: Array<{ gx: number; gy: number; r: number }>;
  /** Every authored passage, in world px. NOT what the client renders — see the door section. */
  passages: Array<RectPx & { i: number; a: string; b: string }>;
}

/**
 * One catalog arena, taken through `RoomBuilder.build`'s own sequence for an arena.
 *
 * Built from a REAL `GameState` rather than from `buildArenaGeometry` directly, because what
 * `RoomBuilder` reads is `s.walls`/`s.arenaRoomRects`/`s.obstacles` — the same reason
 * `floorCoverage.test.ts`'s arena half does it this way. The one thing this harness cannot get
 * from `RoomBuilder` is the door list, and that is the point: there isn't one (see below).
 */
function buildArena(id: ArenaId): Arena {
  const map = ARENA_CATALOG[id];
  const s = createGameState({ seed: 1, worldW: 1, worldH: 1, waves: [], arena: map });
  // Through `roomRectsPx`, the dispatch `RoomBuilder.build` actually calls, rather than by
  // reading `s.arenaRoomRects` here. That branch (`dungeonRoomRects` if any, else the arena's,
  // else the world box) is the arena's entry into the whole wall stack, and a sweep that steps
  // around it measures the pipeline while leaving the call site untested — the exact gap the
  // 2026-08-26 floor-partition battery found the hard way (`cellExtent(s.worldH, s.worldW)`, the
  // world's axes swapped at the call site, survived the entire suite). The authored ids come
  // alongside, index-aligned, and the guard below pins that they really are.
  const roomsPx: RectPx[] = roomRectsPx(s, fpToPx(s.worldW), fpToPx(s.worldH));
  const rooms = roomsPx.map((r, i) => ({ ...r, id: s.arenaRoomRects[i]?.id ?? `(unnamed ${i})` }));
  const walls: RectPx[] = s.walls.map((w) => ({
    x: fpToPx(w.x), y: fpToPx(w.y), w: fpToPx(w.w), h: fpToPx(w.h),
  }));
  // Tier FIRST, then merge same-tier neighbours — `RoomBuilder`'s order, and load-bearing
  // (`mergeWallRuns`: a cross-tier merge would give a kerb a perimeter's height).
  const runs = mergeWallRuns(walls.map((rect) => ({ rect, tier: wallTier(rect, roomsPx) })));
  const joins = wallJoins(runs, CROWN);
  const pillars = s.obstacles.map((o) => ({ gx: fpToPx(o.gx), gy: fpToPx(o.gy), r: fpToPx(o.radius) }));

  const blocks: Block[] = runs.map((run, i) => {
    const height = wallHeight(run.tier);
    const sortY = run.rect.y + run.rect.h;
    return {
      tier: run.tier,
      rect: run.rect,
      box: {
        left: run.rect.x,
        right: run.rect.x + run.rect.w,
        top: sortY + blockCapTop(run.rect, height, joins[i]),
        sortY,
        foldY: sortY - height,
      },
    };
  });
  for (const p of pillars) {
    const art = pillarArtExtent(p.r * 2 + 16, WALL_HEIGHT); // RoomBuilder's own bodyW/height
    blocks.push({
      tier: 'pillar',
      rect: { x: p.gx - p.r, y: p.gy - p.r, w: p.r * 2, h: p.r * 2 },
      box: { left: p.gx - art.halfW, right: p.gx + art.halfW, top: p.gy + art.top, sortY: p.gy, foldY: p.gy },
    });
  }
  // `Door.passageGrid` is absolute (unlike a room's `solids`, which are room-relative — see
  // `content/arenas.ts`), so it converts straight to px through the grid size.
  const passages = map.doors.map((d, i) => ({
    i,
    a: d.roomA,
    b: d.roomB,
    x: d.passageGrid.x * PX_PER_GRID,
    y: d.passageGrid.y * PX_PER_GRID,
    w: d.passageGrid.w * PX_PER_GRID,
    h: d.passageGrid.h * PX_PER_GRID,
  }));
  return { id, runs, joins, blocks, rooms, walls, pillars, passages };
}

const ARENAS: Arena[] = ARENA_IDS.map(buildArena);
/** The map a real PvP match builds, and the only one in the catalog with any stone in it —
 *  `landing_basic` is the wall-less `?arenaDemo=1` fixture. */
const LAUNCH = ARENAS.find((a) => a.id === 'arena_launch')!;

const overlapsX = (a: RectPx, b: RectPx): boolean =>
  Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.75;

/** The screen-y band a block's art occupies, in world px — mirrors `buildWallBlock`, as
 *  `wallComposition.test.ts` does. */
function artBand(run: WallRun, joins: WallJoins): [number, number] {
  const h = wallHeight(run.tier);
  const south = run.rect.y + run.rect.h;
  const top = joins.tuckNorth ? south + Math.min(-h, -run.rect.h - joins.tuckLiftPx) : run.rect.y - h;
  return [top, south];
}

/* ------------------------------------------------------------------ the content reaches the code */

describe('the arena reaches the wall pipeline at all', () => {
  it('builds the launch map into standing geometry, at the scale the map claims', () => {
    // The guard every sweep of this class needs, and here it is also the load-bearing claim of
    // the pass: this content had never been through these functions. Numbers pinned rather than
    // merely non-zero, because they are what every measurement below is a fraction OF; a content
    // edit moving them is the notification that those fractions were re-measured.
    expect(LAUNCH.rooms).toHaveLength(60);
    // `roomRectsPx` really returned the arena's 60 authored rooms, in order — not the world box
    // it falls back to for a mode with no room model, and not the dungeon list.
    const map = ARENA_CATALOG.arena_launch;
    expect(LAUNCH.rooms.map((r) => r.id)).toEqual(map.rooms.map((r) => r.id));
    for (const [i, r] of LAUNCH.rooms.entries()) {
      const authored = map.rooms[i]!.rectGrid;
      expect([r.x / PX_PER_GRID, r.y / PX_PER_GRID, r.w / PX_PER_GRID, r.h / PX_PER_GRID], r.id)
        .toEqual([authored.x, authored.y, authored.w, authored.h]);
    }
    expect(LAUNCH.walls).toHaveLength(492);
    expect(LAUNCH.runs).toHaveLength(294); // 492 authored rects merge to 294 drawn blocks
    expect(LAUNCH.pillars).toHaveLength(124);
    expect(LAUNCH.passages).toHaveLength(74);
  });

  it('gives every tier real subjects — none of the three is dead on this map', () => {
    // `wallTier` has three answers and an arena exercises them differently from a PvE floor:
    // rooms adjacent on BOTH axes means every horizontal boundary is a kerb pair, while a PvE
    // floor has a handful. If any of the three went to zero the sweeps below would still pass.
    const tiers = new Map<WallTier, number>();
    for (const r of LAUNCH.runs) tiers.set(r.tier, (tiers.get(r.tier) ?? 0) + 1);
    expect(tiers.get('perimeter')).toBeGreaterThan(50); // measured 124
    expect(tiers.get('interior')).toBeGreaterThan(50); // measured 106 — the interior kits
    expect(tiers.get('kerb')).toBeGreaterThan(20); // measured 64
    // ...and the map is still mostly tall walls rather than a plain of kerbs.
    expect(tiers.get('kerb')!).toBeLessThan(LAUNCH.runs.length / 2);
  });

  it('and the wall-less demo fixture really is wall-less, so its silence below is expected', () => {
    // `landing_basic` is three rooms with `solids: []`. It stays in the loop-driven assertions
    // (a future catalog map is then covered the day it lands) and it must not be mistaken for
    // content this file swept.
    const demo = ARENAS.find((a) => a.id === 'landing_basic')!;
    expect(demo.runs).toHaveLength(0);
    expect(ARENAS).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ wallComposition, on the arena */

describe('arena walls — every block agrees with its neighbours', () => {
  it('has deep runs that tuck, and every tuck lifts by a real neighbour height', () => {
    const deepMeetingWall = LAUNCH.runs.filter(
      (r, i) => r.rect.h > wallHeight(r.tier) && LAUNCH.joins[i]!.north.length > 0,
    );
    expect(deepMeetingWall.length).toBeGreaterThan(20); // measured 79
    const tucked = LAUNCH.joins.filter((j) => j.tuckNorth);
    expect(tucked.length).toBeGreaterThan(10); // measured 24
    // Every tuck's lift is a NEIGHBOUR's height less its crown, never a constant: with two tiers
    // able to stand north of a tucking run, two distinct lifts have to appear or the shortest-
    // neighbour choice in `tuckLift` is untested by this content.
    const lifts = new Set(tucked.map((j) => j.tuckLiftPx));
    expect(lifts.size).toBeGreaterThanOrEqual(2);
    for (const lift of lifts) {
      expect([wallHeight('perimeter'), wallHeight('interior'), WALL_H_KERB].map((h) => h * (1 - CROWN)))
        .toContain(lift);
    }
  });

  it('never lets a clip open a hole: the neighbour that authorised a tuck covers the band', () => {
    // The whole safety argument for clipping, on this map's geometry rather than on paper. A tuck
    // removes the band `[r.y - height, r.y - height + lift]`; the neighbour that authorised it
    // must already paint every pixel of it, or the floor shows through the corner.
    let checked = 0;
    LAUNCH.runs.forEach((run, i) => {
      const joins = LAUNCH.joins[i]!;
      if (!joins.tuckNorth) return;
      const [clippedTop] = artBand(run, joins);
      const fullTop = run.rect.y - wallHeight(run.tier);
      expect(clippedTop).toBeGreaterThan(fullTop); // something WAS removed
      const covered = LAUNCH.runs.some((other, j) => {
        if (other === run || !overlapsX(other.rect, run.rect)) return false;
        if (Math.abs(other.rect.y + other.rect.h - run.rect.y) > 0.75) return false;
        const [oTop, oBottom] = artBand(other, LAUNCH.joins[j]!);
        return oTop <= fullTop + 0.001 && oBottom >= clippedTop - 0.001;
      });
      expect(covered, `run at ${run.rect.x},${run.rect.y}`).toBe(true);
      checked++;
    });
    expect(checked, 'tucked runs actually exercised').toBeGreaterThan(10);
  });

  it('never lets a tucked run cross its neighbour\'s CROWN course, at the arena\'s own crown', () => {
    // The same line the fourth wall report was about, asked with `neutral`'s crown fraction
    // instead of fire's — the swatches disagree (`FACE_CROWN_ROWS`), so an arena tuck stops at a
    // different row than a PvE one and nothing had checked the arena's.
    let pairs = 0;
    LAUNCH.runs.forEach((run, i) => {
      const joins = LAUNCH.joins[i]!;
      if (!joins.tuckNorth) return;
      const [top] = artBand(run, joins);
      for (const other of LAUNCH.runs) {
        if (other === run || !overlapsX(other.rect, run.rect)) continue;
        if (Math.abs(other.rect.y + other.rect.h - run.rect.y) > 0.75) continue;
        if (wallHeight(other.tier) < wallHeight(run.tier)) continue;
        const oh = wallHeight(other.tier);
        expect(top).toBeGreaterThanOrEqual(run.rect.y - oh + oh * CROWN - 0.001); // stops under it
        expect(top).toBeLessThan(run.rect.y - 0.001); // ...and still covers brick
        pairs++;
      }
    });
    expect(pairs, 'tuck/neighbour pairs on this map').toBeGreaterThan(10);
  });

  it('routes every south-edge join to exactly one of `south` / `tuckedSouth`', () => {
    for (const a of ARENAS) {
      a.runs.forEach((run, i) => {
        const joins = a.joins[i]!;
        for (const [x0, x1] of [...joins.south, ...joins.tuckedSouth]) {
          expect(x1).toBeGreaterThan(x0);
          expect(x0).toBeGreaterThanOrEqual(-0.001);
          expect(x1).toBeLessThanOrEqual(run.rect.w + 0.001);
        }
        for (const [a0, a1] of joins.south) {
          for (const [b0, b1] of joins.tuckedSouth) {
            expect(Math.min(a1, b1) - Math.max(a0, b0), `${a.id} overlapping join`).toBeLessThanOrEqual(0.75);
          }
        }
      });
    }
    // Both lists have to be populated somewhere on this map, or the routing is untested here.
    expect(LAUNCH.joins.filter((j) => j.south.length > 0).length).toBeGreaterThan(10); // 75
    expect(LAUNCH.joins.filter((j) => j.tuckedSouth.length > 0).length).toBeGreaterThan(5); // 17
  });

  it('reports a north join only where a TALL ENOUGH neighbour really touches', () => {
    let joins = 0;
    LAUNCH.runs.forEach((run, i) => {
      for (const [x0, x1] of LAUNCH.joins[i]!.north) {
        expect(x0).toBeGreaterThanOrEqual(-0.001);
        expect(x1).toBeLessThanOrEqual(run.rect.w + 0.001);
        const mid = run.rect.x + (x0 + x1) / 2;
        // A join is a licence to delete an edge cue: something must be there, and it must be at
        // least as TALL as this block.
        const toucher = LAUNCH.runs.find(
          (o) =>
            o !== run &&
            Math.abs(o.rect.y + o.rect.h - run.rect.y) <= 0.75 &&
            mid >= o.rect.x - 0.75 &&
            mid <= o.rect.x + o.rect.w + 0.75 &&
            wallHeight(o.tier) >= wallHeight(run.tier),
        );
        expect(toucher, `north join at ${run.rect.x},${run.rect.y} with no tall enough neighbour`).toBeDefined();
        joins++;
      }
    });
    expect(joins, 'north joins actually exercised').toBeGreaterThan(50); // measured 139
  });

  it("leaves a SHORTER neighbour's step alone, on arena content", () => {
    // The height filter, which on this map has ten times the PvE content behind it: every kerb
    // pair on a horizontal boundary stands north of the next room's interior blocks.
    let pairs = 0;
    LAUNCH.runs.forEach((run, i) => {
      for (const other of LAUNCH.runs) {
        if (other === run || !overlapsX(other.rect, run.rect)) continue;
        if (Math.abs(other.rect.y + other.rect.h - run.rect.y) > 0.75) continue;
        if (wallHeight(other.tier) >= wallHeight(run.tier)) continue;
        pairs++;
        const buried = LAUNCH.joins[i]!.north.some(([x0, x1]) => {
          const lo = Math.max(run.rect.x + x0, other.rect.x);
          const hi = Math.min(run.rect.x + x1, other.rect.x + other.rect.w);
          return hi - lo > 0.75;
        });
        expect(buried, `short neighbour buried an edge at ${run.rect.x},${run.rect.y}`).toBe(false);
      }
    });
    expect(pairs, 'short-northern-neighbour pairs on this map').toBeGreaterThan(20); // measured 64
  });
});

describe('arena walls — nothing tall stands on the floor of the room to its north', () => {
  interface Boundary {
    above: RectPx & { id: string };
    below: RectPx & { id: string };
    at: number;
    x0: number;
    x1: number;
  }

  /** Every stacked-room boundary, enumerated from the ROOM RECTS — rooms cannot merge, so a
   *  boundary counted here cannot disappear because the drawing changed (the mistake
   *  `wallComposition.test.ts` records making). */
  function boundaries(a: Arena): Boundary[] {
    const out: Boundary[] = [];
    for (const above of a.rooms) {
      for (const below of a.rooms) {
        if (above === below) continue;
        if (Math.abs(above.y + above.h - below.y) > 0.75) continue;
        const x0 = Math.max(above.x, below.x);
        const x1 = Math.min(above.x + above.w, below.x + below.w);
        if (x1 - x0 <= 0.75) continue;
        out.push({ above, below, at: above.y + above.h, x0, x1 });
      }
    }
    return out;
  }

  it('keeps every stacked room boundary CLEAR of the floor above it — the tier bug, swept', () => {
    // What `wallTier` got wrong until 2026-08-20, stated as the invariant rather than as a tier
    // name. The arena has 44 of these boundaries against the five PvE floors' 11, and unlike a
    // PvE floor its rooms stack in COLUMNS: a district is a run of vertically adjacent rooms, so
    // this is the map's most common shape rather than an occasional pairing.
    let checked = 0;
    for (const b of boundaries(LAUNCH)) {
      const alongBoundary = (r: RectPx): boolean =>
        Math.min(r.x + r.w, b.x1) - Math.max(r.x, b.x0) > 0.75;
      // Where the upper room's walkable floor actually stops, read out of the content rather than
      // assumed to be one grid row.
      const band0 = LAUNCH.runs.filter(
        (r) => alongBoundary(r.rect) && r.rect.y < b.at - 0.75 && r.rect.y + r.rect.h > b.at - 0.75,
      );
      expect(band0.length, `boundary ${b.above.id}/${b.below.id} has stone along it`).toBeGreaterThan(0);
      const limit = Math.max(...band0.map((r) => r.rect.y));
      const band = LAUNCH.runs.filter(
        (r) => alongBoundary(r.rect) && r.rect.y >= limit - 0.75 && r.rect.y <= b.below.y + 0.75,
      );
      expect(band.length, `boundary ${b.above.id}/${b.below.id} has blocks`).toBeGreaterThan(0);
      for (const run of band) {
        const [top] = artBand(run, LAUNCH.joins[LAUNCH.runs.indexOf(run)]!);
        // One kerb's worth of intrusion is the bound, not zero — a kerb on the upper room's own
        // south edge already reaches `WALL_H_KERB` onto its floor, and that is the case design/01
        // calls provably safe. An `interior` (70) or `perimeter` (104) tier here would not be.
        expect(top, `${b.above.id}/${b.below.id}: run ${run.rect.x},${run.rect.y} (${run.tier})`)
          .toBeGreaterThanOrEqual(limit - WALL_H_KERB - 0.001);
        checked++;
      }
    }
    expect(boundaries(LAUNCH).length, 'stacked-room boundaries on this map').toBe(44);
    expect(checked, 'blocks checked along them').toBeGreaterThan(50); // measured 95
  });

  it('has no PARTLY-covered boundary at all — the PvE case that does not occur here', () => {
    // `wallComposition.test.ts` covers the opposite finding on the PvE floors: `r5_bastion` and
    // `r4_furnace` author one collinear north boundary with a room above only half of it, so the
    // two halves get DIFFERENT tiers and then refuse to merge. That case has zero instances here,
    // and it would be easy to record that as "the rule is dead on the arena" — it is not. The
    // arena's rooms are a slot lattice with fixed column widths, so two vertically adjacent rooms
    // share their FULL width and a boundary is either wholly covered or absent.
    //
    // So the absence is asserted together with its precondition. Without the second half, a
    // future map that did break the lattice would silently stop being checked for the case, which
    // is exactly how a sweep stops meaning anything.
    for (const b of boundaries(LAUNCH)) {
      expect(b.x1 - b.x0, `${b.above.id}/${b.below.id} is a partial overlap`).toBe(
        Math.min(b.above.w, b.below.w),
      );
      expect(b.above.x).toBe(b.below.x);
      expect(b.above.w).toBe(b.below.w);
    }
    const collinearWithKerb = LAUNCH.runs
      .filter((a) => a.tier === 'perimeter')
      .filter((a) =>
        LAUNCH.runs.some(
          (b) =>
            b.tier === 'kerb' &&
            Math.abs(b.rect.y - a.rect.y) <= 0.75 &&
            Math.abs(b.rect.h - a.rect.h) <= 0.75 &&
            (Math.abs(b.rect.x - (a.rect.x + a.rect.w)) <= 0.75 ||
              Math.abs(a.rect.x - (b.rect.x + b.rect.w)) <= 0.75),
        ),
      );
    expect(collinearWithKerb).toEqual([]);
  });
});

/* ------------------------------------------------------------------ the shading still batches */

/** Pixi's own batching decision, run for real against the smallest fake renderer
 *  `GraphicsContextSystem` will accept — same construction as `wallComposition.test.ts`. */
function contextSystem(): GraphicsContextSystem {
  const renderer = {
    uid: 1,
    limits: { maxBatchableTextures: 16 },
    gc: { addResourceHash: () => undefined, now: 0 },
  } as never;
  return new GraphicsContextSystem(renderer);
}

describe('arena walls — the shading still batches, with less room to spare', () => {
  it('keeps every arena block under Pixi\'s auto-batch line — and reports the real headroom', () => {
    // The 2026-08-24 draw-call pass is worth 50 of the frame's 102 draw calls and rests entirely
    // on every block's shading geometry staying under Pixi's 400-float auto-batch line. That is a
    // property of CONTENT: the fill count depends on tier, cap depth, how many spans the joins
    // split the block into, and whether it tucks. `wallComposition.test.ts` measured the worst
    // shipped PvE block at 120 floats and set its guard at `< AUTO_BATCH_VERTEX_LIMIT / 2`.
    //
    // The arena's worst block is 208 — a 672x64 KERB whose joins split it into three south spans.
    // That is over the PvE guard and would have failed it, while still being comfortably batchable.
    // Recorded as its own number rather than by loosening the other file's: the guard that matters
    // is Pixi's line, and the guard that INFORMS is how much of it real content is already using.
    const sys = contextSystem();
    let blocks = 0;
    let worstFloats = 0;
    let worstFills = 0;
    let worstWhere = '';
    for (const a of ARENAS) {
      for (const [i, run] of a.runs.entries()) {
        const g = drawBlockShading(run.rect, wallHeight(run.tier), a.joins[i]!);
        const gpu = sys.updateGpuContext(g.context);
        const floats = gpu.geometryData.vertices.length;
        expect(
          gpu.isBatchable,
          `${a.id} run ${i} (${run.rect.w}x${run.rect.h}, ${run.tier}, ${floats} floats)`,
        ).toBe(true);
        blocks++;
        if (floats > worstFloats) {
          worstFloats = floats;
          worstWhere = `${a.id} ${run.tier} ${run.rect.w}x${run.rect.h}`;
        }
        worstFills = Math.max(worstFills, g.context.instructions.length);
      }
    }
    expect(blocks).toBeGreaterThan(200); // the sweep has to be a sweep
    expect(worstFloats, `worst block: ${worstWhere}`).toBeLessThan(AUTO_BATCH_VERTEX_LIMIT);
    // Measured 208/23. Bounded so a cue that pushes arena content past ~65% of the line fails
    // here first, which is where it would actually break — not at 50% of a PvE-sized block.
    expect(worstFloats).toBeLessThanOrEqual(260);
    expect(worstFills).toBeLessThan(30);
  });

  it('draws every arena cue as a SAMPLED ramp, off the same handful of shared textures', () => {
    // The structural half of the draw-call argument: a float budget alone does not hold it (one
    // cue reverted to 5 stepped rects costs +32 floats and survives any headroom), and the blocks
    // only land in ONE batch if they all sample the same few textures. Both re-asked on arena
    // geometry, because a profile that varied with SIZE would bake a texture per block shape and
    // the arena has an order of magnitude more distinct shapes than a PvE floor.
    resetShadeRampCache();
    let fills = 0;
    let strokes = 0;
    for (const a of ARENAS) {
      for (const [i, run] of a.runs.entries()) {
        const g = drawBlockShading(run.rect, wallHeight(run.tier), a.joins[i]!);
        for (const ins of g.context.instructions as ReadonlyArray<{ action: string; data: { style?: unknown } }>) {
          if (ins.action === 'stroke') {
            strokes++;
            continue;
          }
          expect(ins.action, `${a.id} run ${i}`).toBe('fill');
          expect(
            readRampFill(ins.data.style),
            `${a.id} run ${i} (${run.rect.w}x${run.rect.h}) has a flat fill, not a ramp`,
          ).not.toBeNull();
          fills++;
        }
      }
    }
    expect(fills).toBeGreaterThan(1000); // measured 3333 over 294 blocks
    expect(strokes).toBeGreaterThan(0); // the fold is still drawn
    expect(shadeRampCacheSize()).toBeGreaterThan(0);
    expect(shadeRampCacheSize()).toBeLessThanOrEqual(6); // 3 profiles, as in PvE
  });
});

/* ------------------------------------------------------------------ occlusionCoverage, on the arena */

/** Can the player's body stand centred here? Conservative on purpose, as in the PvE sweep:
 *  anything this accepts is somewhere the player can genuinely be. */
function standable(a: Arena, gx: number, gy: number): boolean {
  for (const w of a.walls) {
    if (gx + CLEARANCE > w.x && gx - CLEARANCE < w.x + w.w && gy + CLEARANCE > w.y && gy - CLEARANCE < w.y + w.h) {
      return false;
    }
  }
  for (const p of a.pillars) {
    const reach = p.r + CLEARANCE;
    if ((gx - p.gx) ** 2 + (gy - p.gy) ** 2 < reach ** 2) return false;
  }
  return a.rooms.some((r) => gx > r.x && gx < r.x + r.w && gy > r.y && gy < r.y + r.h);
}

/** THE ORACLE — what fraction of the drawn body is behind stone here, from rectangle overlap
 *  between the two things that are actually drawn, with no reference to `occludes`. Rows are
 *  unioned so two blocks over the same rows (an L corner, a pillar cluster) cannot double-count.
 *  `fired` empty ⇒ nothing has faded, i.e. the "before" picture. */
function hiddenRows(gx: number, gy: number, cands: readonly Block[], fired: readonly Block[]): number {
  const focus = { x: gx, y: gy, halfW: HALF_W, bodyH: BODY_H };
  const bodyTop = gy - BODY_H;
  const rows = new Set<number>();
  for (const b of cands) {
    if (b.box.sortY <= gy) continue; // sorts behind the character — cannot cover them
    if (gx + HALF_W <= b.box.left || gx - HALF_W >= b.box.right) continue;
    // A block that is not firing stays opaque over all of its art; a firing one keeps everything
    // from its cap/face fold down, unless it also took the deep pass, which leaves nothing.
    let opaqueTop = b.box.top;
    if (fired.includes(b)) opaqueTop = needsDeepFade(b.box, focus) ? b.box.sortY : b.box.foldY;
    for (let y = Math.ceil(Math.max(bodyTop, opaqueTop)); y < Math.min(gy, b.box.sortY); y++) rows.add(y);
  }
  return rows.size / BODY_H;
}

interface Sample {
  gx: number;
  gy: number;
  room: string;
  covered: number;
  hiddenAfter: number;
  fired: Block[];
}

/**
 * Every standable position on `a`, with what the oracle and the rule each say about it.
 *
 * The arena is 3872x3040 px, so the candidate grid is 15x a PvE floor's. Blocks are bucketed by
 * x first: a body is 26 px wide, so only the blocks whose art spans the sample's own column can
 * possibly cover it, and the sweep goes from ~30M block tests to ~1M. The bucket width is checked
 * against `HALF_W` below rather than assumed.
 */
function sweep(a: Arena): Sample[] {
  const BUCKET = 128;
  const width = Math.max(...a.rooms.map((r) => r.x + r.w)) + BUCKET;
  const nBuckets = Math.ceil(width / BUCKET) + 1;
  const buckets: Block[][] = Array.from({ length: nBuckets }, () => []);
  for (const b of a.blocks) {
    const from = Math.max(0, Math.floor((b.box.left - HALF_W) / BUCKET));
    const to = Math.min(nBuckets - 1, Math.floor((b.box.right + HALF_W) / BUCKET));
    for (let i = from; i <= to; i++) buckets[i]!.push(b);
  }
  const out: Sample[] = [];
  const focus = { x: 0, y: 0, halfW: HALF_W, bodyH: BODY_H };
  const minX = Math.min(...a.rooms.map((r) => r.x));
  const maxX = Math.max(...a.rooms.map((r) => r.x + r.w));
  const minY = Math.min(...a.rooms.map((r) => r.y));
  const maxY = Math.max(...a.rooms.map((r) => r.y + r.h));
  for (let gy = minY; gy <= maxY; gy += STEP) {
    for (let gx = minX; gx <= maxX; gx += STEP) {
      if (!standable(a, gx, gy)) continue;
      focus.x = gx;
      focus.y = gy;
      const cands = buckets[Math.min(nBuckets - 1, Math.floor(gx / BUCKET))]!;
      const fired = cands.filter((b) => occludes(b.box, focus));
      out.push({
        gx,
        gy,
        room: a.rooms.find((r) => gx > r.x && gx < r.x + r.w && gy > r.y && gy < r.y + r.h)?.id ?? '(none)',
        covered: hiddenRows(gx, gy, cands, []),
        hiddenAfter: hiddenRows(gx, gy, cands, fired),
        fired,
      });
    }
  }
  return out;
}

const SWEPT: Sample[] = sweep(LAUNCH);

describe('arena occlusion coverage — the launch map, swept', () => {
  it('is looking at a real amount of floor, and the x-ray bucketing cannot miss a block', () => {
    expect(SWEPT.length).toBeGreaterThan(60_000); // measured 72,686 standable samples
    expect(LAUNCH.blocks.length).toBeGreaterThan(300); // 294 runs + 124 pillars
    // The optimisation this sweep needs to be affordable, checked rather than assumed: a body is
    // only 2*HALF_W wide, so a block outside the sample's own 128 px column can never reach it.
    expect(HALF_W * 2).toBeLessThan(128);
    // A brute-force cross-check on one band of the map: same answers with no bucketing at all.
    const band = SWEPT.filter((s) => s.gy === 1000);
    expect(band.length).toBeGreaterThan(100);
    for (const s of band) {
      const all = LAUNCH.blocks.filter((b) => occludes(b.box, { x: s.gx, y: s.gy, halfW: HALF_W, bodyH: BODY_H }));
      expect(all.length, `bucketing lost a block at ${s.gx},${s.gy}`).toBe(s.fired.length);
    }
  });

  it('EVERY hidden spot fires the x-ray — no blind spot on the arena either', () => {
    // The bug, generalised. One position that reaches this list is one more screenshot.
    const missed = SWEPT.filter((s) => s.covered >= HIDDEN_FRACTION && s.fired.length === 0).map(
      (s) => `${s.room} at (${s.gx}, ${s.gy}) covered ${(s.covered * 100) | 0}%`,
    );
    expect(missed).toEqual([]);
  });

  it('never fires where the character is not covered at all', () => {
    const spurious = SWEPT.filter((s) => s.covered === 0 && s.fired.length > 0).map(
      (s) => `${s.room} at (${s.gx}, ${s.gy})`,
    );
    expect(spurious).toEqual([]);
  });

  it('every block it fires for is one really covering the character', () => {
    for (const s of SWEPT) {
      for (const b of s.fired) {
        expect(b.box.sortY, `${s.room} at (${s.gx}, ${s.gy})`).toBeGreaterThan(s.gy);
        expect(b.box.top).toBeLessThan(s.gy);
        expect(s.gx + HALF_W).toBeGreaterThan(b.box.left);
        expect(s.gx - HALF_W).toBeLessThan(b.box.right);
      }
    }
  });

  it('a KERB never fires, from anywhere on this map either', () => {
    // The claim `MIN_COVER_FRACTION` exists for, re-asked on a map where kerbs are the shape of
    // every horizontal room boundary rather than an occasional pairing: 64 kerb runs, and the
    // player walks along one at the south edge of nearly every room.
    const kerbs = SWEPT.filter((s) => s.fired.some((b) => b.tier === 'kerb')).map(
      (s) => `${s.room} at (${s.gx}, ${s.gy})`,
    );
    expect(kerbs).toEqual([]);
    expect(LAUNCH.blocks.some((b) => b.tier === 'kerb')).toBe(true);
  });

  it('a PERIMETER run fires only from BEYOND its own end, never from the room floor it bounds', () => {
    // What stops a room's own boundary fading while the player walks along it. On the arena the
    // "beyond its own end" ground is a door passage between two rooms — 74 of them.
    const hits = SWEPT.flatMap((s) => s.fired.filter((b) => b.tier === 'perimeter').map((b) => ({ s, b })));
    expect(hits.length).toBeGreaterThan(100); // measured 3255
    const insideFootprint = hits
      .filter((h) => h.s.gy >= h.b.rect.y)
      .map((h) => `${h.s.room} at (${h.s.gx}, ${h.s.gy})`);
    expect(insideFootprint).toEqual([]);
  });

  it('fades at most TWO wall blocks at once — but four PILLARS at one spot', () => {
    // `occlusionCoverage.test.ts` asserts at most 2 blocks fade together, so that a room never
    // dissolves. Walls alone hold that here (an L corner is two and the arena adds no third).
    // PILLARS do not: an interior kit that places a 2x2 colonnade cluster puts four pillar arts
    // over one character standing in its middle. Exactly one sample of 72,686 reaches four, and
    // 583 reach two — so this is a specific piece of authored furniture, not a general property,
    // and a pillar fades WHOLE where a wall keeps its face. Whether it reads as four columns
    // going hazy or as a hole in the room is a camera question, which is why the number is
    // recorded here with the shape that produces it rather than smoothed into a looser bound.
    const worstWalls = Math.max(...SWEPT.map((s) => s.fired.filter((b) => b.tier !== 'pillar').length));
    expect(worstWalls).toBeLessThanOrEqual(2);
    const worstAll = Math.max(...SWEPT.map((s) => s.fired.length));
    expect(worstAll).toBe(4);
    const four = SWEPT.filter((s) => s.fired.length >= 4);
    expect(four).toHaveLength(1);
    expect(four[0]!.fired.every((b) => b.tier === 'pillar')).toBe(true);
    // ...and it is a cluster, not a fan: all four sit within one grid cell of the sample.
    for (const b of four[0]!.fired) {
      expect(Math.abs(b.rect.x - four[0]!.gx)).toBeLessThan(PX_PER_GRID * 3);
      expect(Math.abs(b.rect.y - four[0]!.gy)).toBeLessThan(PX_PER_GRID * 3);
    }
  });

  it('leaves the character more than half visible everywhere, and always keeps the head', () => {
    // The acceptance criterion the whole x-ray is judged on, re-measured on content that triggers
    // it three times as often as a PvE floor. Worst case here 43.8% still hidden — the same worst
    // case the PvE sweep reports, which is what a shared bound looks like when it is really the
    // geometry's own limit rather than a property of one level.
    const worst = SWEPT.filter((s) => s.hiddenAfter > 0.5)
      .slice(0, 8)
      .map((s) => `${s.room} at (${s.gx}, ${s.gy}) still ${(s.hiddenAfter * 100) | 0}% hidden`);
    expect(worst).toEqual([]);
    expect(Math.max(...SWEPT.map((s) => s.hiddenAfter))).toBeLessThan(HIDDEN_FRACTION);
    // Which half survives is not a detail: a body is drawn upward from its ground point, so what
    // a block covers is always the BOTTOM of it.
    const headless = SWEPT.filter((s) => s.covered >= 1 && s.hiddenAfter > 0 && s.hiddenAfter >= s.covered).map(
      (s) => `${s.room} at (${s.gx}, ${s.gy})`,
    );
    expect(headless).toEqual([]);
  });

  it('takes the deep pass rarely — but seven times as often as a PvE floor', () => {
    // The fallback that drops a block's front FACE as well as its cap, which reveals whatever is
    // behind the wall. `occlusionCoverage.test.ts` measured 0.2% of the PvE floor and bounds it
    // under 2% so that "walls dissolve near me" never becomes the normal reading. The arena is at
    // 1.37% — inside that bound, and close enough to it that the bound is now doing work.
    const deep = SWEPT.filter((s) =>
      s.fired.some((b) => needsDeepFade(b.box, { x: s.gx, y: s.gy, halfW: HALF_W, bodyH: BODY_H })),
    );
    expect(deep.length).toBeGreaterThan(0); // reachable content, not dead code
    expect(deep.length / SWEPT.length).toBeLessThan(0.02);
    expect(deep.length / SWEPT.length).toBeGreaterThan(0.005); // measured 1.37%, PvE 0.2%
  });

  it('reports how much of this map hides the player at all — three times a PvE floor', () => {
    // The number the pass is judged by, kept in the suite rather than only in a commit message:
    // 16.7% of standable floor leaves the player at least half hidden and 11.6% leaves them
    // COMPLETELY invisible before the x-ray, against 5.4% and 3.3% on the five PvE floors. The
    // arena is denser (124 pillars, 25 interior kits, colonnade rooms whose whole point is
    // cover), so more of it is behind stone by design — what this bounds is the sweep, not the
    // level: zero would mean the x-ray has become dead weight, and half the floor would mean the
    // measurement is wrong rather than the map.
    const half = SWEPT.filter((s) => s.covered >= HIDDEN_FRACTION).length / SWEPT.length;
    const full = SWEPT.filter((s) => s.covered >= 1).length / SWEPT.length;
    expect(half).toBeGreaterThan(0.05);
    expect(half).toBeLessThan(0.3);
    expect(full).toBeGreaterThan(0.03);
    expect(full).toBeLessThan(0.25);
    // And where it is concentrated, because that is the camera list: the worst room is a small
    // colonnade cell whose pillars cover 61% of its own standable floor, and one room has none.
    const perRoom = new Map<string, { n: number; full: number }>();
    for (const s of SWEPT) {
      const rec = perRoom.get(s.room) ?? { n: 0, full: 0 };
      rec.n++;
      if (s.covered >= 1) rec.full++;
      perRoom.set(s.room, rec);
    }
    const ranked = [...perRoom]
      .filter(([id]) => id !== '(none)')
      .map(([id, r]) => ({ id, frac: r.full / r.n }))
      .sort((a, b) => b.frac - a.frac);
    expect(ranked[0]!.frac).toBeGreaterThan(0.4); // cisterns_r1c3, 61.5%
    expect(ranked[ranked.length - 1]!.frac).toBeLessThan(0.05); // kilns_r1c4, 0%
    expect(perRoom.size).toBeGreaterThan(50); // the sweep reached nearly every room
  });
});

/* --------------------------------------------- the three DOOR sweeps, which have no subject here */

describe('arena doors — the rules that never run, and what that costs', () => {
  // `doorStandCoverage`, `doorSpillCoverage` and `doorOcclusionCoverage` all sweep the same
  // subject: `RoomBuilder`'s `doorRectsPx`, built from `s.dungeonDoors`. `GameState` populates
  // that list only in dungeon mode (`config.dungeon`), so in an arena it is EMPTY — the client
  // builds no door fixture, `bordersDoorNorth` is asked about an empty list and always answers
  // no, and `doorClip`/`effectiveWallHeight`/`doorFlankTier` never execute. The map's 74 doors
  // are holes in the stone with nothing standing in them.
  //
  // That is a finding, not an invariant, so this block does three separate things: state the
  // structural fact, MEASURE what it costs on real geometry, and check that the fix's own
  // promises hold on arena geometry — so wiring the passages is a change with a known result
  // rather than a hope. Nothing here asserts that the current state is correct.

  it('the map authors 74 passages and the client renders no door at all', () => {
    const s = createGameState({ seed: 1, worldW: 1, worldH: 1, waves: [], arena: ARENA_CATALOG.arena_launch });
    expect(s.dungeonDoors).toHaveLength(0);
    expect(s.arenaMap?.doors).toHaveLength(74);
    // The passages are reachable from the client without any engine change — `s.arenaMap` is the
    // map itself — which is what makes the fix below a `RoomBuilder` edit rather than a plumbing
    // project. `passageGrid` is absolute (a room's `solids` are not), so it needs no offset.
    expect(s.arenaMap?.doors[0]!.passageGrid).toBeDefined();
  });

  it('every authored passage really is a hole in the stone, inside a room rect', () => {
    // The premise the rest of this block rests on, and the one the predecessor map failed: on
    // `arena_prototype_60` the doors were logical-only. Here a passage overlapping a solid would
    // mean `perimeterSolids` did not carve it, and a passage outside every room rect would mean
    // the per-room floor (2026-08-26) paints no floor under it.
    for (const p of LAUNCH.passages) {
      const blocked = LAUNCH.walls.find(
        (w) =>
          Math.min(p.x + p.w, w.x + w.w) - Math.max(p.x, w.x) > 0.75 &&
          Math.min(p.y + p.h, w.y + w.h) - Math.max(p.y, w.y) > 0.75,
      );
      expect(blocked, `passage ${p.i} (${p.a}->${p.b}) is walled off`).toBeUndefined();
      const cx = p.x + p.w / 2;
      const cy = p.y + p.h / 2;
      expect(
        LAUNCH.rooms.some((r) => cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h),
        `passage ${p.i} (${p.a}->${p.b}) has no floor under it`,
      ).toBe(true);
    }
  });

  it('measures what stands over those passages today: 36 of 74 completely buried', () => {
    // The cost, on the same geometry `doorOcclusionCoverage.test.ts` measures for PvE — where the
    // answer is 0 deep runs over a door and a documented residual of 12 shallow ones. Here the
    // rule that produces that 0 never runs, so a passage is covered by whatever stands south of
    // it: a 96 px-tall gap in a north-south perimeter wall sits entirely inside the 104 px of art
    // the run below it paints upward.
    //
    // NOT asserted to zero, and not asserted to stay at 36 either. This is tracked backlog with a
    // measured fix (next test) — the ceiling is set just above today's number so a regression that
    // made it universal fails, while wiring the fix makes this test fail LOUDLY and demand
    // rewriting, which is the correct behaviour for a measurement of a known gap.
    const cover = (p: RectPx): { px: number; kind: string } => {
      let px = 0;
      let kind = '';
      for (const b of LAUNCH.blocks) {
        if (b.box.sortY <= p.y) continue;
        const ox = Math.min(b.box.right, p.x + p.w) - Math.max(b.box.left, p.x);
        const oy = Math.min(b.box.sortY, p.y + p.h) - Math.max(b.box.top, p.y);
        if (ox > 0.75 && oy > 0.75 && oy > px) {
          px = oy;
          kind = b.tier;
        }
      }
      return { px, kind };
    };
    const measured = LAUNCH.passages.map((p) => ({ p, ...cover(p) }));
    const buried = measured.filter((m) => m.px >= m.p.h - 0.75);
    const partly = measured.filter((m) => m.px > 0 && m.px < m.p.h - 0.75);
    expect(buried.length).toBeGreaterThan(20); // measured 36 — the finding
    expect(buried.length).toBeLessThanOrEqual(40);
    expect(partly.length).toBeLessThanOrEqual(30); // measured 22
    // It is WALL art doing it, not the pillars: 50 of the 58 covered passages are worst-covered
    // by a run, which is what makes `bordersDoorNorth` the fix rather than a kit edit.
    expect(measured.filter((m) => m.px > 0 && m.kind !== 'pillar').length).toBeGreaterThan(40);
  });

  it('...and the fix that never ran would hold on this geometry: 58 covered passages -> 10', () => {
    // `bordersDoorNorth` + `doorClip` + `effectiveWallHeight`, fed the passages the client does
    // not currently give them. Two things are checked, and the second is the one that matters:
    //
    //  1. the fix's own invariant — a clipped run's art (face AND cap) never reaches north of its
    //     own footprint, and its cap is never inverted — on 44 real arena runs rather than on the
    //     five PvE floors' 12. 21 of those 44 are the SHALLOW case `effectiveWallHeight` exists
    //     for (a run whose footprint is shallower than its tier stands, whose FACE alone spills
    //     once the cap is clipped); PvE has 12 in total.
    //  2. what it would be worth here: the residual drops from 58 covered passages (36 of them
    //     fully) to 10 partly covered, worst 40 px.
    const passageRects: RectPx[] = LAUNCH.passages.map((p) => ({ x: p.x, y: p.y, w: p.w, h: p.h }));
    const bordering = LAUNCH.runs.filter((r) => bordersDoorNorth(r.rect, passageRects));
    expect(bordering.length).toBeGreaterThan(20); // measured 44 — the rule DOES match this content
    let shallow = 0;
    for (const run of bordering) {
      const tierHeight = wallHeight(run.tier);
      if (run.rect.h <= tierHeight) shallow++;
      const joins = { ...NO_JOINS, doorClip: true };
      // The same two calls in the same order `RoomBuilder.build` makes them: the height first
      // (it may shrink), then the cap fed that result — never the raw tier height.
      const height = effectiveWallHeight(run.rect, tierHeight, joins);
      const capTop = blockCapTop(run.rect, height, joins);
      expect(run.rect.y + run.rect.h - height).toBeGreaterThanOrEqual(run.rect.y - 0.001); // face
      expect(run.rect.y + run.rect.h + capTop).toBeGreaterThanOrEqual(run.rect.y - 0.001); // cap
      expect(capTop).toBeLessThanOrEqual(-height); // never an inverted cap
    }
    expect(shallow).toBeGreaterThan(10); // measured 21 of 44

    const clipped = LAUNCH.runs.map((run, i) => {
      const joins = bordersDoorNorth(run.rect, passageRects)
        ? { ...LAUNCH.joins[i]!, doorClip: true }
        : LAUNCH.joins[i]!;
      const height = effectiveWallHeight(run.rect, wallHeight(run.tier), joins);
      const sortY = run.rect.y + run.rect.h;
      return { rect: run.rect, top: sortY + blockCapTop(run.rect, height, joins), sortY };
    });
    let covered = 0;
    let worst = 0;
    for (const p of passageRects) {
      let px = 0;
      for (const b of clipped) {
        if (b.sortY <= p.y) continue;
        const ox = Math.min(b.rect.x + b.rect.w, p.x + p.w) - Math.max(b.rect.x, p.x);
        const oy = Math.min(b.sortY, p.y + p.h) - Math.max(b.top, p.y);
        if (ox > 0.75 && oy > 0.75) px = Math.max(px, oy);
      }
      if (px > 0) covered++;
      worst = Math.max(worst, px);
    }
    expect(covered).toBeLessThanOrEqual(12); // measured 10, from 58
    expect(worst).toBeLessThanOrEqual(48); // measured 40 px, from 104
  });

  it('and `doorFlankTier` would answer for every one of them, at all three tiers', () => {
    // `doorStandCoverage.test.ts`'s subject: the height a door fixture stands at is the SHORTEST
    // wall it is cut into. Never exercised on the arena, and the arena is where its two branches
    // are most unbalanced — 36 of the 74 passages are flanked by kerbs (a horizontal boundary
    // between two vertically stacked rooms), which is the case with the clearance consequence.
    const tiers = LAUNCH.passages.map((p) => doorFlankTier({ x: p.x, y: p.y, w: p.w, h: p.h }, LAUNCH.runs));
    expect(tiers.filter((t) => t === null)).toEqual([]); // nothing falls back
    for (const tier of ['perimeter', 'interior', 'kerb'] as const) {
      expect(tiers.filter((t) => t === tier).length, `${tier} flanks`).toBeGreaterThan(5);
    }
    // The clearance guarantee the choice exists for: a doorway may never stand taller than the
    // wall it interrupts, whichever side is shorter.
    for (const [i, p] of LAUNCH.passages.entries()) {
      const tier = tiers[i]!;
      for (const run of LAUNCH.runs) {
        const r = run.rect;
        const ox = Math.min(p.x + p.w, r.x + r.w) - Math.max(p.x, r.x);
        const oy = Math.min(p.y + p.h, r.y + r.h) - Math.max(p.y, r.y);
        const touchesX = Math.abs(r.x + r.w - p.x) <= 1 || Math.abs(r.x - (p.x + p.w)) <= 1;
        const touchesY = Math.abs(r.y + r.h - p.y) <= 1 || Math.abs(r.y - (p.y + p.h)) <= 1;
        if ((oy > 1 && touchesX) || (ox > 1 && touchesY)) {
          expect(wallHeight(tier), `passage ${p.i} over a shorter flank`).toBeLessThanOrEqual(wallHeight(run.tier));
        }
      }
    }
  });
});
