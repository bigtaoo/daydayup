/**
 * `wallVoidEdge` — where a wall block's east/west side ends at nothing.
 *
 * The predicate is the whole reason the return can be drawn OUTSIDE a block's own footprint
 * without inventing stone over a neighbour, so these cases are mostly about the boundary
 * between "void" and "somebody else's": a room's floor, another wall, and the block itself.
 * The counts on real content live in `arenaWallCoverage.test.ts` / `wallComposition.test.ts`
 * — a predicate that reads correctly and matches nothing is this repo's own recorded failure
 * mode (`wallGeometry`'s old `w > h` guard).
 */
import { describe, it, expect } from 'vitest';
import { voidEdges, NO_VOID_EDGES } from './wallVoidEdge';
import type { RectPx } from './wallGeometry';

/** Two rooms side by side, and an empty slot east of them — the shape of `arena_launch`'s
 *  slot grid, which is where this rule fires. */
const ROOM_A: RectPx = { x: 0, y: 0, w: 320, h: 320 };
const ROOM_B: RectPx = { x: 320, y: 0, w: 320, h: 320 };
const FLOORS = [ROOM_A, ROOM_B];

/** A's east perimeter wall, flush with its own room bound — so B's floor starts at its edge. */
const A_EAST: RectPx = { x: 288, y: 0, w: 32, h: 320 };
/** B's west perimeter wall, the other half of that shared boundary. */
const B_WEST: RectPx = { x: 320, y: 0, w: 32, h: 320 };
/** B's east perimeter wall — beyond it is the empty slot. */
const B_EAST: RectPx = { x: 608, y: 0, w: 32, h: 320 };
const STONE = [A_EAST, B_WEST, B_EAST];

describe('voidEdges', () => {
  it('reports nothing where a neighbour carries the picture on', () => {
    // A's east wall has B's own west wall against it and A's floor behind it. Neither side is
    // a free edge, and drawing a return on either would put stone over a floor.
    expect(voidEdges(A_EAST, STONE, FLOORS)).toEqual(NO_VOID_EDGES);
    expect(voidEdges(B_WEST, STONE, FLOORS)).toEqual(NO_VOID_EDGES);
  });

  it('reports the whole side where the next slot is empty', () => {
    const v = voidEdges(B_EAST, STONE, FLOORS);
    expect(v.east).toEqual([{ from: 0, to: 320, gap: Infinity }]);
    expect(v.west).toEqual([]); // B's own floor
  });

  it('excludes the block itself, so callers may pass one flat list of every wall', () => {
    // The probe is strictly outside the rect, which is what makes a reference comparison
    // unnecessary — and passing the whole list IS how `RoomBuilder` calls it.
    expect(voidEdges(B_EAST, STONE, FLOORS)).toEqual(voidEdges(B_EAST, [B_EAST], FLOORS));
  });

  it('splits a side that is part neighbour and part void', () => {
    // `arena_launch`'s east-west runs meet an empty slot END-ON: 32 px of a 64 px side. A
    // boolean answer would either paint over the neighbour or drop the case entirely, and the
    // case it drops is exactly the "end head" the whole finding is about.
    const below: RectPx = { x: 640, y: 160, w: 320, h: 160 };
    const v = voidEdges(B_EAST, STONE, [...FLOORS, below]);
    expect(v.east).toEqual([{ from: 0, to: 160, gap: Infinity }]);
  });

  it('is unmoved by a neighbour that only shares a corner', () => {
    // Touching at a point is not covering: a room whose north-west corner lands exactly on the
    // wall's south-east one leaves the whole side free.
    const corner: RectPx = { x: 640, y: 320, w: 320, h: 320 };
    expect(voidEdges(B_EAST, STONE, [...FLOORS, corner]).east).toEqual([
      { from: 0, to: 320, gap: Infinity },
    ]);
  });

  it('sees STONE that no floor covers, which is the case content has not reached yet', () => {
    // Two walls standing against each other clear of every painted floor. Nothing shipped does
    // this — dropping `stone` from the coverage test leaves all six maps' sweeps green — but it
    // is not redundancy: without it a wall abutting a neighbour over unpainted ground reads as
    // free and paints a return onto that neighbour's stone. So the term stays and the trigger is
    // made reachable here, rather than the term being deleted because today's maps happen not to
    // exercise it.
    const lone: RectPx = { x: 900, y: 0, w: 32, h: 320 };
    const against: RectPx = { x: 932, y: 0, w: 32, h: 320 };
    expect(voidEdges(lone, [lone, against], FLOORS).east).toEqual([]);
    expect(voidEdges(lone, [lone], FLOORS).east).toEqual([{ from: 0, to: 320, gap: Infinity }]);
  });

  it('is not split in two by a neighbour that touches at a single y', () => {
    // A rect whose whole overlap with this side is one point covers nothing, and must not cut the
    // span at that point: two abutting returns in place of one would each measure their own gap,
    // draw their own arris, and meet at a seam down the middle of one continuous surface — the
    // same artifact `wallJoins` exists to keep out of a corner.
    const pinch: RectPx = { x: 640, y: 160, w: 320, h: 0 };
    expect(voidEdges(B_EAST, STONE, [...FLOORS, pinch]).east).toEqual([
      { from: 0, to: 320, gap: Infinity },
    ]);
  });

  it('reads the FLOOR the ground layer paints, not the room rects', () => {
    // The fallback case: a mode with no usable room model paints the whole world box, so there
    // is no interior void at all and no side of any wall is free. Passing room rects here
    // instead would report void across a floor the player is standing on.
    const box: RectPx = { x: 0, y: 0, w: 1600, h: 1600 };
    expect(voidEdges(B_EAST, STONE, [box])).toEqual(NO_VOID_EDGES);
  });

  it('treats the world\'s own outer edge as the same rule', () => {
    // The map's outer silhouette is not a special case — it is this predicate answering the
    // same question at the boundary, which is why one rule covers both.
    const westmost: RectPx = { x: 0, y: 0, w: 32, h: 320 };
    expect(voidEdges(westmost, [westmost], FLOORS).west).toEqual([
      { from: 0, to: 320, gap: Infinity },
    ]);
  });
});

describe('the gap a return has to reach into', () => {
  it('is Infinity where nothing bounds the void — the map\'s own outer edge', () => {
    expect(voidEdges(B_EAST, STONE, FLOORS).east[0]!.gap).toBe(Infinity);
  });

  it('measures to the nearest solid or floor beyond the edge', () => {
    // The number the renderer clamps its reach by: two walls facing each other across this
    // may each take half of it and no more.
    const far: RectPx = { x: 704, y: 0, w: 320, h: 320 };
    expect(voidEdges(B_EAST, STONE, [...FLOORS, far]).east[0]!.gap).toBe(64);
    // Westward, off a wall standing clear of both rooms — B_EAST's own west side is B's floor.
    const outlier: RectPx = { x: 800, y: 0, w: 32, h: 320 };
    const near: RectPx = { x: 720, y: 0, w: 48, h: 320 };
    expect(voidEdges(outlier, [outlier, near], FLOORS).west[0]!.gap).toBe(32);
  });

  it('is measured per SPAN, not per side', () => {
    // A side split by a partial neighbour looks out on two different voids, and each half
    // gets its own answer — one bounded, one not.
    const below: RectPx = { x: 640, y: 200, w: 320, h: 40 };
    const beyond: RectPx = { x: 720, y: 260, w: 320, h: 60 };
    const east = voidEdges(B_EAST, STONE, [...FLOORS, below, beyond]).east;
    expect(east.map((s2) => [s2.from, s2.to, s2.gap])).toEqual([
      [0, 200, Infinity],
      [240, 320, 80],
    ]);
  });
});
