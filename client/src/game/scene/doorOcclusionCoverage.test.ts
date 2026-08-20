/// <reference types="node" />
/**
 * Does a door's own passage EVER get painted over by a wall run's cap, anywhere on the shipped
 * level-1 floors? Sibling to `occlusionCoverage.test.ts` (same rationale, same real pipeline,
 * same "an independent oracle, not the rule under test" discipline) but for the bug the x-ray
 * sweep there could never have found: it only ever swept the PLAYER's position, and a door
 * isn't a position the player stands at — it's a fixture that sits in one place forever, with
 * no x-ray of its own to fall back on (`RoomBuilder.buildDoors` puts it on `layers.ground`,
 * always behind the Y-sorted `entities` a wall run stands on).
 *
 * Live report, screenshot attached, a run circled: *"门不能被高墙挡住了。门应该是随时清晰可见的"* — a
 * door must not be blocked by a tall wall, it should be clearly visible at all times. Fixed at
 * the geometry (`wallRuns.bordersDoorNorth` + `WallJoins.doorClip`, see `design/01-rendering.md`
 * and `RoomBuilder.build`) rather than by fading anything, so this file's job is the same one
 * `occlusionCoverage.test.ts` does for the player: prove the fix reaches every door on every
 * shipped floor, not just the one fixture `RoomBuilder.test.ts` hand-built to exercise it.
 *
 * THE ORACLE: plain rectangle overlap between a door's passage rect and a wall run's rendered
 * box (`left/right/top/sortY` — the exact art extent `RoomBuilder` hands the occlusion x-ray),
 * computed independently of `bordersDoorNorth`. Reusing `blockCapTop`/`wallJoins` themselves is
 * not circular here for the same reason `occlusionCoverage.test.ts` reuses them: what's under
 * test is coverage over REAL shipped content, not whether two copies of the formula agree.
 */
import { describe, it, expect } from 'vitest';
import {
  EMBER_L1_FLOORS,
  EMBER_L1_ROOMS,
  buildFloorGeometry,
  placeAuthoredFloor,
  toFpAabbGrid,
  toFpGrid,
  type RoomPiece,
} from '@dd/engine';
import { fpToPx } from '../coords';
import { wallHeight, wallTier, type RectPx } from './wallGeometry';
import { blockCapTop, bordersDoorNorth, mergeWallRuns, wallJoins, type WallJoins, type WallRun } from './wallRuns';
import { faceCrownFraction } from './wallTone';

interface Block {
  rect: RectPx;
  deep: boolean; // r.h > its own tier height — the same gate `blockCapTop` clips on
  box: { left: number; right: number; top: number; sortY: number };
}

interface FloorDoors {
  index: number;
  blocks: Block[];
  doors: RectPx[];
}

/** One floor, through the SAME sequence `RoomBuilder.build` runs: `placeAuthoredFloor` →
 *  `buildFloorGeometry` (the real door-gap carve) → `wallTier` → `mergeWallRuns` → `wallJoins`,
 *  with `bordersDoorNorth`'s `doorClip` folded in exactly as `RoomBuilder.build` does it → the
 *  occluder-shaped box (`blockCapTop`). */
function buildFloor(index: number): FloorDoors {
  const map = EMBER_L1_FLOORS[index]!;
  const { placed, doors } = placeAuthoredFloor(map, EMBER_L1_ROOMS as readonly RoomPiece[]);
  // The exact same call `SpawnSystem`/`RoomBuilder` build a live room from — this is what carves
  // each door's gap through the walls it overlaps (`carveDoorGaps`, design/05), leaving a run
  // bordering a door with its edge flush at the door's boundary rather than overlapping it. A
  // locked door's passage stands right back in as a generic wall rect (mirrored via `doorAabbs`
  // in `RoomBuilder.build`, not needed here since this file never renders one as a wall).
  const geo = buildFloorGeometry(placed, doors);

  const doorRectsPx: RectPx[] = doors.map((d) => {
    const aabb = toFpAabbGrid(d.passageGrid);
    return { x: fpToPx(aabb.x), y: fpToPx(aabb.y), w: fpToPx(aabb.w), h: fpToPx(aabb.h) };
  });

  const roomsPx: RectPx[] = placed.map((r) => ({
    x: fpToPx(toFpGrid(r.offsetXGrid)),
    y: fpToPx(toFpGrid(r.offsetYGrid)),
    w: fpToPx(toFpGrid(r.piece.sizeGrid.w)),
    h: fpToPx(toFpGrid(r.piece.sizeGrid.h)),
  }));

  const wallsPx: RectPx[] = geo.walls.map((w) => ({
    x: fpToPx(w.x), y: fpToPx(w.y), w: fpToPx(w.w), h: fpToPx(w.h),
  }));

  const runs: WallRun[] = mergeWallRuns(wallsPx.map((rect) => ({ rect, tier: wallTier(rect, roomsPx) })));
  const joins: WallJoins[] = wallJoins(runs, faceCrownFraction('fire')); // level 1 is ember
  for (const [i, run] of runs.entries()) {
    if (bordersDoorNorth(run.rect, doorRectsPx)) joins[i] = { ...joins[i]!, doorClip: true };
  }

  const blocks: Block[] = runs.map((run, i) => {
    const height = wallHeight(run.tier);
    const sortY = run.rect.y + run.rect.h;
    return {
      rect: run.rect,
      deep: run.rect.h > height,
      box: {
        left: run.rect.x,
        right: run.rect.x + run.rect.w,
        top: sortY + blockCapTop(run.rect, height, joins[i]),
        sortY,
      },
    };
  });

  return { index, blocks, doors: doorRectsPx };
}

const FLOORS: FloorDoors[] = Object.keys(EMBER_L1_FLOORS).map(Number).map(buildFloor);

/** Plain AABB overlap — the independent oracle, no reference to `bordersDoorNorth`. */
function overlaps(a: { left: number; right: number; top: number; sortY: number }, d: RectPx): boolean {
  return a.left < d.x + d.w && d.x < a.right && a.top < d.y + d.h && d.y < a.sortY;
}

describe('door occlusion coverage — the shipped level-1 floors, swept', () => {
  it('is actually looking at all five floors, and they actually contain doors', () => {
    // The guard every test of this class needs: a pipeline change that silently produced zero
    // doors (or zero deep runs next to one) would make every assertion below vacuously true.
    expect(FLOORS).toHaveLength(5);
    const totalDoors = FLOORS.reduce((n, f) => n + f.doors.length, 0);
    expect(totalDoors).toBeGreaterThan(10);
    const doorAdjacentDeepRuns = FLOORS.flatMap((f) =>
      f.blocks.filter((b) => b.deep && bordersDoorNorth(b.rect, f.doors)),
    );
    expect(doorAdjacentDeepRuns.length).toBeGreaterThan(0);
  });

  it('no DEEP run\'s cap ever overlaps a door passage — the case the fix targets', () => {
    const covered = FLOORS.flatMap(({ index, blocks, doors }) =>
      blocks
        .filter((b) => b.deep)
        .flatMap((b) => doors.filter((d) => overlaps(b.box, d)).map((d) => `floor ${index} door (${d.x},${d.y})`)),
    );
    expect(covered).toEqual([]);
  });

  it('reports the residual: a SHALLOW run beside a door still spills (documented, not silent)', () => {
    // `blockCapTop`'s doorClip guard is gated on `r.h > height`, same as `tuckNorth` — a run no
    // deeper than it is tall has no cap left to clip without erasing it. This is the "doors have
    // no x-ray" gap `design/01-rendering.md` names as still open, measured on real content rather
    // than asserted away: as long as it stays small and does not silently grow, it is tracked
    // backlog, not a regression.
    const covered = FLOORS.flatMap(({ index, blocks, doors }) =>
      blocks
        .filter((b) => !b.deep)
        .flatMap((b) => doors.filter((d) => overlaps(b.box, d)).map((d) => `floor ${index} door (${d.x},${d.y})`)),
    );
    // Not asserted to zero — that would be the general fix this entry explicitly defers, and
    // this file's job is to measure real content, not assume it. Measured today: 12 hits across
    // all five floors (some doors counted twice — a shallow run on each side), against 24 doors
    // total. Ceiling set just above that, so a regression that made this common (rather than the
    // rare edge it is today) still fails, without pinning to a number one unrelated room edit
    // would flip.
    expect(covered.length).toBeLessThanOrEqual(16);
  });
});
