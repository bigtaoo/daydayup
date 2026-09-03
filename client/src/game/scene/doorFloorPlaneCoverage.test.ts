/// <reference types="node" />
/**
 * `doorLights.DoorFloorPlane` (2026-09-03d) — where a door's floor-level decals are allowed to lie,
 * measured against the five shipped floors rather than against a fixture.
 *
 * **The bug this exists for.** Every floor-level door layer (both states' pools, `doorFx`'s
 * travelling pulse, the lock-change burst) was drawn from the threshold SOUTHWARD, on the
 * assumption that the ground in front of a doorway is room floor. For a door cut through a
 * NORTH-SOUTH wall it is not: it is the same wall continuing, whose block Y-sorts after the door
 * (`Entity.zIndex` is the ground y and the run's is its own south edge) and paints straight over
 * the decal. Reported from a live frame as a light ring with its middle bitten out — two arcs
 * flanking the doorway and nothing between them.
 *
 * **Why a content sweep and not a fixture.** Nothing about one hand-written passage rect can tell
 * you whether the shipped floors put a wall there, and this repo has already shipped a
 * silent-because-unmeasured version of exactly that mistake (`wallComposition.test.ts`'s header,
 * and `doorSpillCoverage.test.ts` — which measured this same `bordersDoorNorth` relationship 12
 * times over for a different symptom, the run's cap swallowing the door's ART, without anyone
 * asking what else was under that cap). So the sweep walks every door on every floor through
 * `RoomBuilder`'s own pipeline, and the last two cases below pin that it still exercises both
 * orientations and that the pre-plane geometry really did fail here — a fix whose test cannot fail
 * against the old code is measuring nothing.
 */
import { describe, it, expect } from 'vitest';
import { Graphics } from 'pixi.js';
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
import { wallTier, type RectPx } from './wallGeometry';
import { mergeWallRuns } from './wallRuns';
import {
  doorFloorPlane,
  floorArcSpans,
  GLOW_POOL,
  GLOW_POOL_SQUASH,
  strokeFloorArc,
  thresholdPlane,
  type DoorFloorPlane,
} from './doorLights';

const FLOOR_INDICES = Object.keys(EMBER_L1_FLOORS).map(Number);

/**
 * The widest floor ring any door draws, as a multiple of the drawn opening width: `doorFx.drawBurst`
 * grows one to `0.3 + 1.35`. Swept as a RANGE below rather than asserted at this one radius, so a
 * ring that is legal at full size but not halfway there cannot pass.
 */
const MAX_RING = 1.65;

/** One shipped floor, through `RoomBuilder.build`'s own sequence: merged wall runs, the door
 *  passage rects, and the room rects (which include their own perimeter walls). */
function floorPx(index: number): { runs: RectPx[]; doors: RectPx[]; rooms: RectPx[] } {
  const map = EMBER_L1_FLOORS[index]!;
  const { placed, doors } = placeAuthoredFloor(map, EMBER_L1_ROOMS as readonly RoomPiece[]);
  const geo = buildFloorGeometry(placed, doors);
  const rooms: RectPx[] = placed.map((r) => ({
    x: fpToPx(toFpGrid(r.offsetXGrid)),
    y: fpToPx(toFpGrid(r.offsetYGrid)),
    w: fpToPx(toFpGrid(r.piece.sizeGrid.w)),
    h: fpToPx(toFpGrid(r.piece.sizeGrid.h)),
  }));
  const runs = mergeWallRuns(
    geo.walls.map((wall) => {
      const rect: RectPx = { x: fpToPx(wall.x), y: fpToPx(wall.y), w: fpToPx(wall.w), h: fpToPx(wall.h) };
      return { rect, tier: wallTier(rect, rooms) };
    }),
  ).map((run) => run.rect);
  const doorRects: RectPx[] = doors.map((d) => {
    const a = toFpAabbGrid(d.passageGrid);
    return { x: fpToPx(a.x), y: fpToPx(a.y), w: fpToPx(a.w), h: fpToPx(a.h) };
  });
  return { runs, doors: doorRects, rooms };
}

const inside = (r: RectPx, x: number, y: number): boolean =>
  x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h;

/** Local fixture coords → world px. `buildDoorBlock` places the container on the passage's SOUTH
 *  edge (`seg.place(r.x, r.y + r.h)`), and a floor decal is drawn at z = 0, so local y is a ground
 *  offset from that line — the same mapping the Y-sort uses. */
const toWorld = (door: RectPx, x: number, y: number): [number, number] => [door.x + x, door.y + door.h + y];

/** Every point of every stroked subpath in `g`, read back off the geometry rather than recomputed —
 *  the question is what the fixture DRAWS, and `strokeFloorArc` is the thing under test. */
function pathPoints(g: Graphics): [number, number][] {
  type Ins = { data: { path?: { instructions: { action: string; data: number[] }[] } } };
  return (g.context.instructions as unknown as Ins[]).flatMap((ins) =>
    (ins.data.path?.instructions ?? [])
      .filter((i) => i.action === 'moveTo' || i.action === 'lineTo')
      .map((i) => [i.data[0]!, i.data[1]!] as [number, number]),
  );
}

/** The ring `doorFx` would stroke at this radius, on this plane, in world px. */
function ringWorld(door: RectPx, plane: DoorFloorPlane, rx: number): [number, number][] {
  const g = new Graphics();
  strokeFloorArc(g, plane, rx, 0xffffff, 2, 1);
  return pathPoints(g).map(([x, y]) => toWorld(door, x, y));
}

/** What share of a ring's sampled points land inside a wall run, and what share land outside every
 *  room (over void, where no floor is drawn at all). Shares, not counts: the two plane kinds sample
 *  a different number of points. */
function buriedShare(floor: ReturnType<typeof floorPx>, door: RectPx, plane: DoorFloorPlane, rx: number) {
  const all = ringWorld(door, plane, rx);
  const share = (n: number): number => n / all.length;
  return {
    points: all.length,
    inWall: share(all.filter(([x, y]) => floor.runs.some((run) => inside(run, x, y))).length),
    offFloor: share(all.filter(([x, y]) => !floor.rooms.some((room) => inside(room, x, y))).length),
  };
}

/** Every shipped door, with the floor it stands on and the plane it gets. */
function everyDoor(): { index: number; floor: ReturnType<typeof floorPx>; door: RectPx; plane: DoorFloorPlane }[] {
  return FLOOR_INDICES.flatMap((index) => {
    const floor = floorPx(index);
    return floor.doors.map((door) => ({ index, floor, door, plane: doorFloorPlane(door) }));
  });
}

describe('a door floor plane puts its decals on floor, on every shipped door', () => {
  it('strokes not one point of a sides door ring into stone or over the void, at any radius', () => {
    // The reported bug, as a number. A `sides` ring is born narrower than the wall it comes out of
    // (`floorArcSpans` draws nothing while `rx <= cx`), so the interesting radii are the ones just
    // past that — hence a swept range rather than the widest ring alone.
    let doorsChecked = 0;
    let points = 0;
    for (const { index, floor, door, plane } of everyDoor()) {
      if (plane.floor !== 'sides') continue;
      for (let m = 0.3; m <= MAX_RING + 1e-9; m += 0.05) {
        const rx = door.w * m;
        const seen = buriedShare(floor, door, plane, rx);
        if (seen.points === 0) continue; // still inside the wall's own thickness: nothing drawn
        const where = `floor ${index} door ${door.x},${door.y} ${door.w}x${door.h} ring ${rx.toFixed(1)}`;
        expect(seen.inWall, `${where}: share inside a wall run`).toBe(0);
        expect(seen.offFloor, `${where}: share over the void`).toBe(0);
        points += seen.points;
      }
      doorsChecked++;
    }
    expect(doorsChecked).toBe(13); // every north-south-wall door on every shipped floor
    expect(points).toBeGreaterThan(5_000);
  });

  it('leaves a threshold door ring exactly where it was, ends on the wall line included', () => {
    // The 11 east-west-wall doors always read correctly and every swept constant in `doorLights.ts`
    // came from one, so the fix must not move them by a pixel. What it must also not do is pretend
    // they are perfect: a southern half-ellipse TERMINATES on the wall line it is cut into, so its
    // last samples sit inside the flanking runs' own footprints, and at the burst's widest it
    // reaches past the room's floor edge. Measured across the five floors, per point: at most 19%
    // of a ring inside stone and at most 29% over void. Bounded rather than fixed — clipping a
    // decal that legitimately spans TWO rooms needs the room rects threaded into the fixture, a
    // different pass; the bound is here so the residual cannot grow unnoticed.
    let doorsChecked = 0;
    for (const { index, floor, door, plane } of everyDoor()) {
      if (plane.floor !== 'south') continue;
      for (const m of [0.5, 1, 1.35, MAX_RING]) {
        const rx = door.w * m;
        const now = buriedShare(floor, door, plane, rx);
        const before = buriedShare(floor, door, thresholdPlane(door.w), rx);
        const where = `floor ${index} door ${door.x},${door.y} ring ${rx.toFixed(1)}`;
        expect(now, `${where}: moved by the plane`).toEqual(before);
        expect(now.inWall, `${where}: share inside a wall run`).toBeLessThanOrEqual(0.2);
        expect(now.offFloor, `${where}: share over the void`).toBeLessThanOrEqual(0.3);
      }
      doorsChecked++;
    }
    expect(doorsChecked).toBe(11);
  });

  it('lands the graduated pool on real room floor, not only on the fixture own stone', () => {
    // The nine pool FILLS are deliberately not cut back to the floor — at 0.035 alpha a ring
    // crossing the leaf reads as bloom coming off the doorway, which is the latitude
    // `doorLights.fillFloorPool` documents. What has to be true is that the pool REACHES floor:
    // its widest ring's two extremes along the travel axis are on ground the player walks on.
    const reach = GLOW_POOL[0]!;
    for (const index of FLOOR_INDICES) {
      const { runs, doors, rooms } = floorPx(index);
      for (const door of doors) {
        const plane = doorFloorPlane(door);
        const ends: [number, number][] =
          plane.floor === 'sides'
            ? [
                toWorld(door, plane.cx - door.w * reach, plane.cy),
                toWorld(door, plane.cx + door.w * reach, plane.cy),
              ]
            : [toWorld(door, plane.cx, door.w * reach * GLOW_POOL_SQUASH)];
        for (const [x, y] of ends) {
          const where = `floor ${index} door ${door.x},${door.y} ${door.w}x${door.h} at (${x.toFixed(1)},${y.toFixed(1)})`;
          expect(runs.find((run) => inside(run, x, y)), `${where}: pool end inside a wall`).toBeUndefined();
          expect(rooms.some((room) => inside(room, x, y)), `${where}: pool end outside every room`).toBe(true);
        }
      }
    }
  });

  it('still exercises BOTH orientations — the sweep is worthless if the content stopped having one', () => {
    const kinds = FLOOR_INDICES.flatMap((index) => floorPx(index).doors.map((d) => doorFloorPlane(d).floor));
    expect(kinds.filter((k) => k === 'sides')).toHaveLength(13); // the 64x128 passages
    expect(kinds.filter((k) => k === 'south')).toHaveLength(11); // the 128x64 ones
  });

  it('measures the pre-plane geometry FAILING on those doors, so this fix is not a no-op', () => {
    // The inverse run: the same rings, on the old threshold-only plane. Without it the cases above
    // would pass just as happily against the code that shipped the bug.
    //
    // Measured, per point: the old plane put 29-33% of a `sides` ring inside stone at rx = w, and
    // 86-90% of it at rx = w/2 — most of a ring, on 13 of the 24 shipped doors, which is why the
    // live frame showed two arcs flanking the doorway and nothing between them.
    let broken = 0;
    for (const { floor, door, plane } of everyDoor()) {
      if (plane.floor !== 'sides') continue;
      const old = thresholdPlane(door.w);
      expect(buriedShare(floor, door, old, door.w).inWall).toBeGreaterThan(0.25);
      expect(buriedShare(floor, door, old, door.w / 2).inWall).toBeGreaterThan(0.8);
      expect(buriedShare(floor, door, plane, door.w).inWall).toBe(0);
      broken++;
    }
    expect(broken).toBe(13);
  });
});

describe('the plane itself', () => {
  it('reads the travel axis off the passage the same way the worn floor patch does', () => {
    // `floorRender.drawDoorWear` elongates the worn patch along the passage's SHORT axis, because a
    // passage rect is a hole in a wall: short axis = the wall's thickness = the way you cross it.
    // Same discriminator here, so the two floor-level door decals cannot disagree about which way
    // a doorway faces.
    expect(doorFloorPlane({ x: 0, y: 0, w: 64, h: 128 })).toEqual({ cx: 32, cy: -64, floor: 'sides' });
    expect(doorFloorPlane({ x: 0, y: 0, w: 128, h: 64 })).toEqual({ cx: 64, cy: 0, floor: 'south' });
  });

  it('keeps the threshold plane on exactly the southern half, sampled as it always was', () => {
    // The `south` plane is the pre-plane behaviour and has to stay byte-identical: 11 shipped doors
    // use it and every swept number in `doorLights.ts` (the ramp's alpha, the pool's +14.4 luma)
    // was measured on it.
    expect(floorArcSpans(thresholdPlane(64), 100)).toEqual([[0, Math.PI]]);
    const g = new Graphics();
    strokeFloorArc(g, thresholdPlane(64), 100, 0xffffff, 2, 1);
    const pts = pathPoints(g);
    expect(pts).toHaveLength(21); // one span, 20 segments
    for (const [, y] of pts) expect(y).toBeGreaterThanOrEqual(0);
  });

  it('draws a sides ring as two lobes clear of the wall, and nothing while it is still inside it', () => {
    const plane = doorFloorPlane({ x: 0, y: 0, w: 64, h: 128 });
    expect(floorArcSpans(plane, 20)).toHaveLength(0); // narrower than the wall's own half-thickness
    const g = new Graphics();
    strokeFloorArc(g, plane, 64, 0xffffff, 2, 1);
    const pts = pathPoints(g);
    expect(pts).toHaveLength(42); // two spans
    // Every point clear of the wall's own column, and both sides represented.
    for (const [x] of pts) expect(Math.abs(x - plane.cx)).toBeGreaterThanOrEqual(plane.cx - 1e-9);
    expect(pts.some(([x]) => x > plane.cx)).toBe(true);
    expect(pts.some(([x]) => x < plane.cx)).toBe(true);
    // ...and it is a ring on the FLOOR, not a hoop standing in the air: the spread is the SQUASHED
    // radius, centred on the passage rather than on the threshold, and the lobes stop short of the
    // ellipse's own extreme y — `+-ry` is reached at the top and bottom of the ellipse, which is
    // exactly where the wall stands.
    const ys = pts.map(([, y]) => y);
    const reach = 64 * GLOW_POOL_SQUASH * Math.sin(Math.acos(plane.cx / 64));
    expect(Math.min(...ys)).toBeCloseTo(plane.cy - reach, 6);
    expect(Math.max(...ys)).toBeCloseTo(plane.cy + reach, 6);
    expect(reach).toBeLessThan(64 * GLOW_POOL_SQUASH);
  });
});
