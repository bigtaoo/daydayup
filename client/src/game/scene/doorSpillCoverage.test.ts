/// <reference types="node" />
/**
 * Measures the gap `wallRuns.blockCapTop`'s `doorClip` used to leave open (ROADMAP "A door
 * could be blocked by a tall wall", 2026-08-20; design/01 "A long north-south run whose north
 * END is open floor"): `doorClip` only clipped a run whose footprint was DEEPER than it stood
 * tall (`r.h > height`) — a SHALLOW run (a common shape: most of `carveDoorGaps`'s stub walls
 * flanking a door opening are exactly this) was left unclipped, spilling its whole cap onto the
 * door anyway. That was recorded as an open question rather than fixed — *"that residual case
 * is the general doors-have-no-x-ray problem above, not this clip's to solve"* — without anyone
 * measuring whether the shipped floors actually reach it.
 *
 * `wallComposition.test.ts`'s own header names exactly this trap: this repo has already shipped
 * a silent-because-unmeasured version of it once (`wallGeometry`'s old `w > h` guard left 1 wall
 * standing where 32 should, because level-1's rooms are almost entirely `w <= h`). This sweep
 * found the shallow case firing **12 times across all five shipped floors** — not hypothetical.
 * A second layer was under it: even clipping the CAP to zero (`blockCapTop`'s own fix) left the
 * block's FACE — drawn at a fixed tier height regardless of `r.h` — still reaching `height - r.h`
 * px past the run's own footprint edge, since the face was never touched by the cap-only clip.
 * `effectiveWallHeight` closes that second layer by shrinking the height fed to BOTH the face and
 * the cap for a `doorClip`ped shallow run. See both functions' own doc comments for the measured
 * numbers (a 32 px-deep PERIMETER stub spilled 72 px of pure face with the cap-only clip alone).
 *
 * Real floors through the real pipeline (`placeAuthoredFloor` → `buildFloorGeometry` →
 * `wallTier` → `mergeWallRuns`, RoomBuilder's own sequence up to the point `bordersDoorNorth` is
 * evaluated), checking the invariant the fix promises — the block's rendered art (face AND cap)
 * never reaches past the run's own north edge, and the cap is never inverted — against every
 * door-bordering run that pipeline actually produces, not a hand-picked fixture.
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
import { wallHeight, wallTier, type RectPx } from './wallGeometry';
import {
  blockCapTop,
  bordersDoorNorth,
  effectiveWallHeight,
  mergeWallRuns,
  NO_JOINS,
  type WallRun,
} from './wallRuns';

const FLOOR_INDICES = Object.keys(EMBER_L1_FLOORS).map(Number);

/** Every merged run on one shipped floor that borders a door to its north, plus the door
 *  rects themselves converted the same way `RoomBuilder` converts `s.dungeonDoors` at runtime
 *  (`toFpAabbGrid` then `fpToPx`, per field). */
function doorBorderingRuns(index: number): WallRun[] {
  const map = EMBER_L1_FLOORS[index]!;
  const { placed, doors } = placeAuthoredFloor(map, EMBER_L1_ROOMS as readonly RoomPiece[]);
  const geo = buildFloorGeometry(placed, doors);
  const roomsPx: RectPx[] = placed.map((r) => ({
    x: fpToPx(toFpGrid(r.offsetXGrid)),
    y: fpToPx(toFpGrid(r.offsetYGrid)),
    w: fpToPx(toFpGrid(r.piece.sizeGrid.w)),
    h: fpToPx(toFpGrid(r.piece.sizeGrid.h)),
  }));
  const runs = mergeWallRuns(
    geo.walls.map((wall) => {
      const rect: RectPx = { x: fpToPx(wall.x), y: fpToPx(wall.y), w: fpToPx(wall.w), h: fpToPx(wall.h) };
      return { rect, tier: wallTier(rect, roomsPx) };
    }),
  );
  const doorRectsPx: RectPx[] = doors.map((d) => {
    const aabb = toFpAabbGrid(d.passageGrid);
    return { x: fpToPx(aabb.x), y: fpToPx(aabb.y), w: fpToPx(aabb.w), h: fpToPx(aabb.h) };
  });
  return runs.filter((run) => bordersDoorNorth(run.rect, doorRectsPx));
}

describe('a run beside a door never spills onto it — shallow or deep, on the real shipped floors', () => {
  it('clips flush with its own north edge (face AND cap) and never produces an inverted cap', () => {
    let doorBorders = 0;
    let shallow = 0;
    for (const index of FLOOR_INDICES) {
      for (const run of doorBorderingRuns(index)) {
        doorBorders++;
        const tierHeight = wallHeight(run.tier);
        if (run.rect.h <= tierHeight) shallow++;
        const joins = { ...NO_JOINS, doorClip: true };
        // The SAME two calls `RoomBuilder.build` makes: `effectiveWallHeight` first (it may
        // shrink the height itself for a shallow run), then `blockCapTop` fed that result —
        // never the raw tier height, or this would only re-prove `blockCapTop` in isolation
        // and miss the exact gap `effectiveWallHeight` exists to close.
        const height = effectiveWallHeight(run.rect, tierHeight, joins);
        const capTop = blockCapTop(run.rect, height, joins);
        const faceTop = run.rect.y + run.rect.h - height; // the face's own top, independent of any cap
        const worldTop = run.rect.y + run.rect.h + capTop; // the cap's top — always <= faceTop
        // Never spills north of the run's own footprint edge, onto the door standing there —
        // checked against the FACE's own reach, not just the cap's, since a shallow run's face
        // alone used to be the residual spill once the cap-only clip already handled the cap.
        expect(faceTop).toBeGreaterThanOrEqual(run.rect.y);
        expect(worldTop).toBeGreaterThanOrEqual(run.rect.y);
        // Never an inverted cap (capH = -height - capTop would be negative above this line).
        expect(capTop).toBeLessThanOrEqual(-height);
      }
    }
    // The sweep only means something if it actually exercises both shapes — a future content
    // rewrite that stopped placing any wall beside a door (or only ever deep ones) would make
    // this pass on zero real coverage, the exact silent-pass failure mode
    // `wallComposition.test.ts` was written against.
    expect(doorBorders).toBeGreaterThan(0);
    expect(shallow).toBeGreaterThan(0);
  });
});
