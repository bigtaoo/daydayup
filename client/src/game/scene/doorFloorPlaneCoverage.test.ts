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
import { DOOR_H, wallTier, type RectPx } from './wallGeometry';
import { doorLeafFrame } from './doorLeaf';
import { mergeWallRuns } from './wallRuns';
import {
  doorFloorPlane,
  doorSpan,
  drawGlow,
  drawSpill,
  floorArcSpans,
  GLOW_POOL,
  GLOW_POOL_SQUASH,
  ringTravel,
  strokeFloorArc,
  thresholdPlane,
  type DoorFloorPlane,
} from './doorLights';

const FLOOR_INDICES = Object.keys(EMBER_L1_FLOORS).map(Number);

/**
 * The widest floor ring any door draws, as a multiple of the plane's `span`: `doorFx.drawBurst`
 * grows one to `0.3 + 1.35`. Swept as a RANGE below rather than asserted at this one radius, so a
 * ring that is legal at full size but not halfway there cannot pass.
 */
const MAX_RING = 1.65;

/** The shipped leaf art after its alpha trim (`door_locked_raw.png`, 147x217 — the same pair
 *  `doorRender.test.ts` fits its fixtures to) and the height `RoomBuilder` builds EVERY door at
 *  (`DOOR_H`, not the flanking run's height — that only decides whether a door draws a cap). The
 *  two together are what makes `drawH` below the real drawn height of a shipped door rather than a
 *  number invented for this sweep: 64 px doorways draw a 94.5 px leaf, 128 px ones crop to 104. */
const ART_W = 147;
const ART_H = 217;

/** What a shipped door of this width actually draws its leaf at — `buildDoorBlock`'s own
 *  `leafHeight(r.w, DOOR_H, leaf)`, which the floor plane is now centred and sized on. */
function drawnLeafH(openingW: number): number {
  return doorLeafFrame(openingW, DOOR_H, ART_W, ART_H).drawH;
}

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

/** Every `ellipse` in `g`, as `[cx, cy, rx, ry]` — the pool FILLS, which are ellipse calls rather
 *  than the stroked segments `pathPoints` reads. `drawGlow` also lays a wash rect over the leaf, so
 *  the filter is what separates the pool from it. */
function poolEllipses(g: Graphics): number[][] {
  type Ins = { data: { path?: { instructions: { action: string; data: number[] }[] } } };
  return (g.context.instructions as unknown as Ins[]).flatMap((ins) =>
    (ins.data.path?.instructions ?? []).filter((i) => i.action === 'ellipse').map((i) => i.data.slice(0, 4)),
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
    return floor.doors.map((door) => ({
      index,
      floor,
      door,
      plane: doorFloorPlane(door, drawnLeafH(door.w)),
    }));
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
        const rx = plane.span * m;
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
        const rx = plane.span * m;
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
        const plane = doorFloorPlane(door, drawnLeafH(door.w));
        const ends: [number, number][] =
          plane.floor === 'sides'
            ? [
                toWorld(door, plane.cx - plane.span * reach, plane.cy),
                toWorld(door, plane.cx + plane.span * reach, plane.cy),
              ]
            : [toWorld(door, plane.cx, plane.cy + plane.span * reach * GLOW_POOL_SQUASH)];
        for (const [x, y] of ends) {
          const where = `floor ${index} door ${door.x},${door.y} ${door.w}x${door.h} at (${x.toFixed(1)},${y.toFixed(1)})`;
          expect(runs.find((run) => inside(run, x, y)), `${where}: pool end inside a wall`).toBeUndefined();
          expect(rooms.some((room) => inside(room, x, y)), `${where}: pool end outside every room`).toBe(true);
        }
      }
    }
  });

  it('still exercises BOTH orientations — the sweep is worthless if the content stopped having one', () => {
    const kinds = FLOOR_INDICES.flatMap((index) =>
      floorPx(index).doors.map((d) => doorFloorPlane(d, drawnLeafH(d.w)).floor),
    );
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

/** The two shapes every shipped passage has, as `doorFloorPlaneCoverage` measures them above: 13
 *  are 64x128 (a hole in a north-south wall) and 11 are 128x64. */
const SIDES: RectPx = { x: 0, y: 0, w: 64, h: 128 };
const SOUTH: RectPx = { x: 0, y: 0, w: 128, h: 64 };

describe('the plane itself', () => {
  it('reads the travel axis off the passage the same way the worn floor patch does', () => {
    // `floorRender.drawDoorWear` elongates the worn patch along the passage's SHORT axis, because a
    // passage rect is a hole in a wall: short axis = the wall's thickness = the way you cross it.
    // Same discriminator here, so the two floor-level door decals cannot disagree about which way
    // a doorway faces.
    expect(doorFloorPlane(SIDES, drawnLeafH(SIDES.w))).toEqual({
      cx: 32,
      cy: -drawnLeafH(64) / 2,
      floor: 'sides',
      span: doorSpan(64, drawnLeafH(64)),
    });
    expect(doorFloorPlane(SOUTH, drawnLeafH(SOUTH.w))).toEqual({
      cx: 64,
      cy: 0,
      floor: 'south',
      span: doorSpan(128, drawnLeafH(128)),
    });
  });

  it('centres a sides ring on the DRAWN opening, not on the passage it is cut through', () => {
    // The reported bug (2026-09-04): `cy` was half the PASSAGE's 128 px depth up-screen, and the
    // arch standing on that threshold is 94.5 px tall — so the ring sat 17 px above the middle of
    // the fixture the eye reads as the door, on all 13 of these. *"位置有点偏上了...你能将其放在门的
    // 中心吗"*. The old value is asserted too: without it this case passes against the old code.
    const plane = doorFloorPlane(SIDES, drawnLeafH(SIDES.w));
    expect(drawnLeafH(64)).toBeCloseTo(94.5, 1); // 217 rows of leaf art fitted to a 64 px opening
    expect(plane.cy).toBeCloseTo(-47.24, 2);
    expect(plane.cy).not.toBeCloseTo(-SIDES.h / 2, 6);
    // An arch TALLER than the hole it stands in cannot push its decals out the far side of it.
    expect(doorFloorPlane({ x: 0, y: 0, w: 64, h: 64 }, 400).cy).toBe(-32);
  });

  it('sizes every ring by the drawn door, at the reach the live report asked for', () => {
    // The other half of that report — *"有的门大，有的小，最好那个圈能跟随门的大小进行缩放"* — and
    // what was actually wrong: the rings WERE proportional (a multiple of the opening's width, so
    // the 64 px and 128 px doorways got the same multiple), they were just far too big to read as
    // belonging to a door, at 2.7 widths across. Both shipped shapes now land near the 1.4 the
    // reporter picked, and the widest ring is measured against the drawn WIDTH — the thing on
    // screen — not against the span it is computed from.
    for (const [door, width] of [
      [SIDES, 64],
      [SOUTH, 128],
    ] as const) {
      const plane = doorFloorPlane(door, drawnLeafH(width));
      const across = (2 * plane.span * GLOW_POOL[0]!) / width;
      expect(across, `${width} px doorway: widest pool ring, in door widths`).toBeGreaterThan(1.25);
      expect(across).toBeLessThan(1.55);
      // The pre-2026-09-04 rule, for the same door: `openingW` itself as the multiple.
      expect((2 * width * GLOW_POOL[0]!) / width).toBeCloseTo(2.7, 6);
    }
    // A door cropped SHORTER than it is wide is sized by the drawn box, not by its width alone —
    // the 128 px doorways crop 189 px of leaf to the wall's 104 and come in ~10% under a square
    // one. A TALLER-than-wide door clamps back to its width: the opening is what light comes out
    // of, not the wall above it.
    expect(doorSpan(128, 104)).toBeLessThan(doorSpan(128, 128));
    expect(doorSpan(64, 94.5)).toBe(doorSpan(64, 64));
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
    const plane = doorFloorPlane(SIDES, drawnLeafH(SIDES.w));
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
    // radius, centred on the drawn opening rather than on the threshold, and the lobes stop short
    // of the ellipse's own extreme y — `+-ry` is reached at the top and bottom of the ellipse, which is
    // exactly where the wall stands.
    const ys = pts.map(([, y]) => y);
    const reach = 64 * GLOW_POOL_SQUASH * Math.sin(Math.acos(plane.cx / 64));
    expect(Math.min(...ys)).toBeCloseTo(plane.cy - reach, 6);
    expect(Math.max(...ys)).toBeCloseTo(plane.cy + reach, 6);
    expect(reach).toBeLessThan(64 * GLOW_POOL_SQUASH);
  });

  it('draws the graduated pool as the plane own ellipse family, and both states share it', () => {
    // The nine `GLOW_POOL` fills are the layer the report was actually looking at (the stroked
    // pulse is two thin arcs; the pool is what reads as light on the floor), and NOTHING asserted
    // their geometry before 2026-09-04 — `doorRender.test.ts` matches them by digest against a
    // Graphics built by calling the same production function, so the centre, the radii and the
    // squash all cancel out of that comparison. A mutation battery over this pass found three
    // survivors here at once: all nine rings at one radius, the pool ignoring `plane.cy`, and the
    // foreshortening dropped (a hoop standing in the air).
    const plane = doorFloorPlane(SIDES, drawnLeafH(SIDES.w));
    const glow = new Graphics();
    drawGlow(glow, SIDES.w, drawnLeafH(SIDES.w), plane);
    const ell = poolEllipses(glow);
    expect(ell).toHaveLength(GLOW_POOL.length);
    ell.forEach(([cx, cy, rx, ry], i) => {
      expect(cx).toBeCloseTo(plane.cx, 6);
      expect(cy).toBeCloseTo(plane.cy, 6); // the drawn arch's middle, not the passage's
      expect(rx).toBeCloseTo(plane.span * GLOW_POOL[i]!, 6);
      expect(ry).toBeCloseTo(rx! * GLOW_POOL_SQUASH, 6); // on the floor, not standing up in the air
    });
    // Widest first and strictly graduated: nine rings at one radius is one ring with a hard edge,
    // which is what `GLOW_POOL`'s own doc says the first version looked like.
    const radii = ell.map((e) => e[2]!);
    for (let i = 1; i < radii.length; i++) expect(radii[i]!).toBeLessThan(radii[i - 1]!);
    // "One symbol, colour says which state" — the two states' pools are the same nine ellipses.
    const spill = new Graphics();
    drawSpill(spill, SIDES.w, drawnLeafH(SIDES.w), plane);
    expect(poolEllipses(spill)).toEqual(ell);
  });

  it('gives the no-rect fallback plane a real span, not a zero one', () => {
    // `thresholdPlane(w)`'s defaulted `drawH`. `drawGlow`/`drawSpill` fall back to it when a caller
    // has no passage rect (their own default parameter), and a zero there collapses all nine pool
    // rings onto a point with nothing else going red.
    expect(thresholdPlane(64).span).toBe(doorSpan(64, 64));
    expect(thresholdPlane(64).span).toBeGreaterThan(0);
    const g = new Graphics();
    drawGlow(g, 64, 94);
    expect(poolEllipses(g)[0]![2]).toBeCloseTo(thresholdPlane(64).span * GLOW_POOL[0]!, 6);
  });

  it('never travels a ring INWARD, however short the arch standing over it is', () => {
    // `ringTravel`'s end guard, which no shipped door can exercise: a `sides` ring starts at the
    // wall's face (32 px here) and a door whose leaf is cropped far shorter than the passage is
    // wide has a span whose 1.3x lands INSIDE that. The outward pulse would then run from 32 px
    // down to 16, travelling the wrong way and drawing nothing while it did. `RoomBuilder` builds
    // every door at `DOOR_H` so no floor reaches it — but `buildDoorBlock` is exported and takes
    // any height, which is what makes this a fixture rather than a sweep.
    const stub = doorFloorPlane(SIDES, 8);
    expect(stub.span * 1.3).toBeLessThan(stub.cx); // the case is real, not hypothetical
    expect(ringTravel(stub, 0.35, 1.3, 0)).toBe(stub.cx);
    expect(ringTravel(stub, 0.35, 1.3, 1)).toBeGreaterThanOrEqual(ringTravel(stub, 0.35, 1.3, 0));
  });

  it('spends a sides pulse travelling over FLOOR, not growing inside the wall', () => {
    // `ringTravel`'s clamp. A `sides` ring draws nothing while it is narrower than the wall's own
    // half-thickness, and at the 0.55 reach a 64 px door's whole 0.35..1.3 sweep would finish
    // inside those 32 px — the pulse the previous pass made visible would have gone straight back
    // out. Starting the travel at the wall's face keeps "emerges from the doorway" and spends the
    // sweep on floor: measured, 20 of 21 samples draw, against 9 for the unclamped multiple.
    const plane = doorFloorPlane(SIDES, drawnLeafH(SIDES.w));
    const steps = Array.from({ length: 21 }, (_, i) => i / 20);
    const drawn = (rx: (t: number) => number): number =>
      steps.filter((t) => floorArcSpans(plane, rx(t)).length > 0).length;
    expect(drawn((t) => ringTravel(plane, 0.35, 1.3, t))).toBeGreaterThanOrEqual(19);
    expect(drawn((t) => plane.span * (0.35 + 0.95 * t))).toBeLessThan(10);
    // The reach is unchanged by the clamp — it moves the START of the journey, not its end.
    expect(ringTravel(plane, 0.35, 1.3, 1)).toBeCloseTo(plane.span * 1.3, 6);
    // ...and a `south` plane, whose floor starts at the centre, is not clamped at all.
    const south = doorFloorPlane(SOUTH, drawnLeafH(SOUTH.w));
    expect(ringTravel(south, 0.35, 1.3, 0)).toBeCloseTo(south.span * 0.35, 6);
  });
});
