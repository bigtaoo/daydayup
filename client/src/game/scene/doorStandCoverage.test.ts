/// <reference types="node" />
/**
 * Does the STANDING door fixture (2026-08-20, `doorRender.ts`) actually work on the shipped
 * content — and does the rule that decides its height ever fire at all?
 *
 * The risk this file exists for is the one `wallComposition.test.ts`'s header names and this repo
 * has already shipped once: a geometric predicate that reads correctly, passes its unit tests on
 * hand-built fixtures, and silently matches NOTHING in the real level (`wallGeometry`'s old
 * `w > h` guard left 1 wall standing where 32 should). `doorFlankTier` is exactly that shape — it
 * asks whether a run abuts the passage along the gap, and if the answer were always "no" every
 * door would quietly fall back to `wallTier` and the kerb-clearance guarantee below would be
 * vacuous. So this sweeps the REAL five shipped floors through the REAL pipeline
 * (`placeAuthoredFloor` → `buildFloorGeometry` → `wallTier` → `mergeWallRuns` → `doorFlankTier`,
 * RoomBuilder's own sequence) and asserts both the invariant AND that both of its branches occur.
 *
 * Measured when written: 24 doors across the five shipped floors, every one of them flanked (zero
 * fallbacks) — 13 standing at `WALL_H_PERIMETER` (a 64x128 passage through a room boundary, travel
 * east-west) and 11 at `WALL_H_KERB` (a 128x64 passage through the low boundary between two
 * vertically stacked rooms, travel north-south). The kerb case is not an edge case: it is nearly
 * half the doors in the game.
 */
import { describe, it, expect } from 'vitest';
import {
  buildFloorGeometry,
  EMBER_L1_FLOORS,
  EMBER_L1_ROOMS,
  placeAuthoredFloor,
  toFpAabbGrid,
  toFpGrid,
  type RoomPiece,
} from '@dd/engine';
import { fpToPx } from '../coords';
import { wallHeight, wallTier, WALL_H_KERB, WALL_H_PERIMETER, type RectPx, type WallTier } from './wallGeometry';
import { blockCapTop, doorFlankTier, mergeWallRuns, wallJoins, type WallRun } from './wallRuns';
import { faceCrownFraction } from './wallTone';

const FLOOR_INDICES = Object.keys(EMBER_L1_FLOORS).map(Number);

interface FloorGeo {
  runs: WallRun[];
  doorRects: RectPx[];
}

/** One shipped floor converted exactly the way `RoomBuilder.build` converts it at runtime. */
function floorGeo(index: number): FloorGeo {
  const map = EMBER_L1_FLOORS[index]!;
  const { placed, doors } = placeAuthoredFloor(map, EMBER_L1_ROOMS as readonly RoomPiece[]);
  const geo = buildFloorGeometry(placed, doors);
  const roomsPx: RectPx[] = placed.map((r) => ({
    x: fpToPx(toFpGrid(r.offsetXGrid)),
    y: fpToPx(toFpGrid(r.offsetYGrid)),
    w: fpToPx(toFpGrid(r.piece.sizeGrid.w)),
    h: fpToPx(toFpGrid(r.piece.sizeGrid.h)),
  }));
  const doorRects: RectPx[] = doors.map((d) => {
    const aabb = toFpAabbGrid(d.passageGrid);
    return { x: fpToPx(aabb.x), y: fpToPx(aabb.y), w: fpToPx(aabb.w), h: fpToPx(aabb.h) };
  });
  // A locked door's passage is folded into `walls` by DoorSystem at runtime and skipped by
  // RoomBuilder by reference identity; `buildFloorGeometry` here gives the carved (unlocked)
  // wall set already, which is the same list RoomBuilder's wall loop sees.
  const runs = mergeWallRuns(
    geo.walls.map((wall) => {
      const rect: RectPx = { x: fpToPx(wall.x), y: fpToPx(wall.y), w: fpToPx(wall.w), h: fpToPx(wall.h) };
      return { rect, tier: wallTier(rect, roomsPx) };
    }),
  );
  return { runs, doorRects };
}

/** Every run that touches `door` along the gap — the same adjacency `doorFlankTier` uses,
 *  restated here independently so the assertion is not just the implementation echoed back. */
function flanking(door: RectPx, runs: readonly WallRun[]): WallRun[] {
  const overlap = (a0: number, a1: number, b0: number, b1: number): number =>
    Math.min(a1, b1) - Math.max(a0, b0);
  return runs.filter((run) => {
    const r = run.rect;
    const ox = overlap(door.x, door.x + door.w, r.x, r.x + r.w);
    const oy = overlap(door.y, door.y + door.h, r.y, r.y + r.h);
    const touchesX = Math.abs(r.x + r.w - door.x) <= 1 || Math.abs(r.x - (door.x + door.w)) <= 1;
    const touchesY = Math.abs(r.y + r.h - door.y) <= 1 || Math.abs(r.y - (door.y + door.h)) <= 1;
    return (oy > 1 && touchesX) || (ox > 1 && touchesY);
  });
}

describe('a door stands at the height of the wall it is cut into — on the real shipped floors', () => {
  it('every door is flanked, never taller than its shortest flank, and both tiers occur', () => {
    let doors = 0;
    let fellBack = 0;
    const tiers = new Map<WallTier, number>();
    for (const index of FLOOR_INDICES) {
      const { runs, doorRects } = floorGeo(index);
      for (const door of doorRects) {
        doors++;
        const tier = doorFlankTier(door, runs);
        if (tier === null) {
          fellBack++;
          continue;
        }
        tiers.set(tier, (tiers.get(tier) ?? 0) + 1);
        // The clearance guarantee: a doorway may never stand taller than the wall it interrupts,
        // whichever side is shorter. A kerb is low because a room's floor lies immediately north
        // of it (`wallGeometry.framesFloorFromSouth`) and anything tall there stands between the
        // camera and the player — a door is no more entitled to that space than the wall is.
        const flanks = flanking(door, runs);
        expect(flanks.length).toBeGreaterThan(0);
        for (const f of flanks) {
          expect(wallHeight(tier)).toBeLessThanOrEqual(wallHeight(f.tier));
        }
      }
    }
    // The sweep only means anything if the predicate matches real geometry at all...
    expect(doors).toBeGreaterThan(0);
    expect(fellBack).toBe(0);
    // ...and if both answers actually occur in the shipped content. A rule that only ever returns
    // `perimeter` here would leave the kerb case — the one with a real clearance consequence —
    // untested by this sweep no matter how many doors it walked.
    expect(tiers.get('perimeter') ?? 0).toBeGreaterThan(0);
    expect(tiers.get('kerb') ?? 0).toBeGreaterThan(0);
  });

  it('a door never climbs over the crown of the wall it is set into', () => {
    // A block's cap reaches one height + its own depth north of its footprint, which for a door
    // set in a DEEP wall (a passage through a room boundary is 64+ px deep) would put its stone
    // over the crown course of the run north of it — the artifact `wallJoins`' tuck exists for.
    // Doors get their own joins pass in `RoomBuilder.buildDoors`, so this checks the result the
    // renderer actually uses, not the unclipped geometry.
    let tucked = 0;
    for (const index of FLOOR_INDICES) {
      const { runs, doorRects } = floorGeo(index);
      const doorRuns: WallRun[] = doorRects.map((rect) => ({
        rect,
        tier: doorFlankTier(rect, runs) ?? 'interior',
      }));
      const joins = wallJoins([...runs, ...doorRuns], faceCrownFraction('fire')).slice(runs.length);
      for (const [i, run] of doorRuns.entries()) {
        const height = wallHeight(run.tier);
        const capTop = blockCapTop(run.rect, height, joins[i]!);
        const reachNorth = -capTop - run.rect.h; // px of art north of the footprint's own north edge
        if (reachNorth < height) tucked++;
        // Never more than one height north of its own footprint — the same bound a wall block
        // has, and the reason a doorway cannot bury the room's back wall.
        expect(reachNorth).toBeLessThanOrEqual(height + 0.01);
        expect(capTop).toBeLessThanOrEqual(-height); // never an inverted cap
      }
    }
    // The clip has to actually fire somewhere in the shipped content, or this test is only
    // re-proving the unclipped bound. It fires on a passage through a room BOUNDARY (deeper than
    // the wall stands tall, whole north edge buried in the run beside it); a door in a stacked-room
    // kerb has open floor north of it and correctly does not tuck, which is why this is a count
    // over all five floors rather than a per-door assertion.
    expect(tucked).toBeGreaterThan(0);
  });

  it('the two tier heights are the ones a wall uses, not a door-only constant', () => {
    // Cheap but load-bearing: the fixture's height comes from `wallHeight`, so a future change to
    // the wall tiers moves the doors with them by construction.
    expect(wallHeight('perimeter')).toBe(WALL_H_PERIMETER);
    expect(wallHeight('kerb')).toBe(WALL_H_KERB);
  });
});
