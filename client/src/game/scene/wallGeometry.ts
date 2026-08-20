// Split out of RoomBuilder (design/01 "walls, pillars and characters show a small front
// face"): the pure decision of HOW TALL each wall segment stands, kept Pixi-free so it is
// testable without a canvas. `wallRender.ts` owns the drawing; this file owns the rule.

/** A wall/room footprint in world px (already through `fpToPx`). */
export interface RectPx {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The three heights a wall can stand at, in world px.
 *
 * Height VARIETY is the point (2026-08-18, user report: *"墙看起来还是没有高度感，就像一张图
 * 贴在地上"*). Before this pass every standing wall used one flat 70, and a room where
 * everything vertical is exactly the same height gives the eye no relative measure — it
 * reads as one more texture on the floor rather than as architecture. So a room's boundary
 * now genuinely towers over the blocks inside it.
 *
 * - `WALL_H_PERIMETER` — a wall on the room's own boundary (north/east/west). The tallest
 *   thing in the room, and what makes the room feel enclosed.
 * - `WALL_H_INTERIOR` — a free-standing block or stub inside the room. Deliberately still
 *   the number the pillars use (`RoomBuilder.buildPillars`), so a block and a pillar
 *   standing side by side agree on how tall "tall" is.
 * - `WALL_H_KERB` — a wall with a room's FLOOR immediately north of it. It cannot have a real
 *   height: it sits between the camera and the player it is framing, and anything tall there
 *   hides the character. A low kerb still reads as a raised lip and still casts a shadow, and
 *   is provably safe, and the operative number is the CLEARANCE rather than the wall's depth:
 *   the player cannot overlap the wall, so their ground point stays `PLAYER_BASE.solidRadius`
 *   (16 px) north of the kerb's own north edge, and a 22 px lip therefore reaches at most 6 px
 *   up a body drawn 20-48 px tall — under the fraction `occlusion.ts` fades on, whatever the
 *   wall's thickness happens to be (`occlusion.test.ts` pins that arithmetic). Note
 *   this is not "the room's south boundary": where two rooms stack vertically the boundary is
 *   two walls, authored by two rooms, and BOTH are kerbs — see `wallTier`.
 */
export const WALL_H_PERIMETER = 104;
export const WALL_H_INTERIOR = 70;
export const WALL_H_KERB = 22;

/** The tallest a wall can be — what `GameLoop.cameraFrame` has to grow the framed room rect
 *  by so a north wall's face isn't cut off the top of the viewport. */
export const MAX_WALL_HEIGHT = WALL_H_PERIMETER;

/** Kept for the pillars, which share the interior wall height by design (see above). */
export const WALL_HEIGHT = WALL_H_INTERIOR;

/** Tolerance (world px) for "this wall's edge IS the room's edge". A wall is authored flush
 *  with its room's bounds, so anything short of a full grid cell is slack for the
 *  fixed-point → px conversion, not a real offset. */
const EDGE_TOLERANCE = 4;

export type WallTier = 'perimeter' | 'interior' | 'kerb';

/**
 * Which tier this wall segment stands at.
 *
 * **Every wall now stands.** Until 2026-08-18 this function was a boolean `wallRises` that
 * additionally required an east-west run (`w > h`), on the grounds that a long north-south
 * wall "reads as a defect — nearly all you see is its cap band sitting 70 px off its own
 * footprint". That exclusion was the single biggest reason walls still looked painted on:
 * level-1's shipped rooms are almost entirely disqualified by it (`ember_l1_gallery`'s east
 * and west sides are 1x16 grid runs, `ember_l1_kiln`'s four interior blocks are 2x2 SQUARES,
 * so `w <= h` for every one of them) and a player could walk a whole room seeing nothing
 * stand up but its north edge. The real fix was not to hide those walls but to draw the
 * volume properly — `wallRender.ts` gives every block a shaded side face and a cast shadow
 * on the floor, which is what re-anchors a displaced cap to its own footprint. A wall's
 * orientation now changes nothing about whether it rises.
 *
 * `rooms` is the floor's room rects (`GameState.dungeonRoomRects`/`arenaRoomRects`,
 * converted to px). Modes that populate neither (flat `EngineConfig.floors`) pass the world
 * rect as the single room, which gives the identical answer for a one-room world.
 *
 * **The kerb test runs over EVERY room, not just the one this wall stands in** (2026-08-20).
 * Until then the whole function keyed off the single room the wall's CENTRE fell in, so
 * "am I a south boundary?" could only ever be asked about that one room — and on a floor
 * with two vertically stacked rooms, the wall a player looks south across is not one wall
 * but two: the upper room's own south wall (its last grid row) and, one row further south,
 * the lower room's north wall. The first was correctly a kerb; the second answered "I am my
 * room's north edge" and stood at full `WALL_H_PERIMETER`, one row south of the exact floor
 * the kerb exists to keep clear. Its art rises `WALL_H_PERIMETER` px above its own north
 * edge, so it covered a measured 72 px of the upper room's floor — on all five shipped
 * floors, 24 runs of it (`occlusionCoverage.test.ts` swept it out). `occlusion.ts`'s x-ray
 * then had to dissolve it to keep the player visible, which is work a correct tier does not
 * need doing.
 *
 * So the rule is now stated the way the design intent always meant it: a wall is a kerb when
 * a room's FLOOR lies immediately north of it, whoever authored the wall — see
 * `framesFloorFromSouth`. That is one predicate covering both halves of a shared boundary,
 * and it strictly generalizes the old `onSouth` check (a room's own south wall is the case
 * where the room north of the wall is the wall's own room).
 */
export function wallTier(wall: RectPx, rooms: readonly RectPx[]): WallTier {
  // Kerb first, and over every room: the answer must not depend on which room claims the
  // wall's centre, because a shared boundary's two halves fall in two different rooms.
  if (rooms.some((room) => framesFloorFromSouth(wall, room))) return 'kerb';

  const cx = wall.x + wall.w / 2;
  const cy = wall.y + wall.h / 2;
  const room = rooms.find((r) => cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h);
  // A wall belonging to no known room (a corridor segment stitched between rooms, or a mode
  // with no room model at all) has no edge relationship to check. Treated as perimeter: a
  // corridor IS a boundary on both sides, and it is never the thing the camera is framing.
  if (!room) return 'perimeter';

  const onNorth = wall.y <= room.y + EDGE_TOLERANCE;
  const onWest = wall.x <= room.x + EDGE_TOLERANCE;
  const onEast = wall.x + wall.w >= room.x + room.w - EDGE_TOLERANCE;
  return onNorth || onWest || onEast ? 'perimeter' : 'interior';
}

/**
 * Does `room`'s floor lie immediately north of this wall — i.e. would anything tall here
 * stand between the camera and a player standing on that floor?
 *
 * Two shapes qualify, and they are the two halves of a boundary between vertically adjacent
 * rooms (`ember_l1` floor 0's `r4_forge`/`r5_extraction`, and six more pairs across the five
 * shipped floors):
 *
 *   (a) the wall IS that room's own south boundary — it sits inside the room with its south
 *       edge on the room's, which is the case the original `onSouth` check covered;
 *   (b) the wall ABUTS that boundary from the far side — its NORTH edge is the room's south
 *       bound, so the only thing between it and that room's floor is the room's own south
 *       wall, one grid row thick. `WALL_H_KERB + one row` still clears the floor; nothing
 *       taller does.
 *
 * Horizontal overlap has to be a real overlap, not a shared corner: two rooms side by side
 * touch along a whole edge, and a room's east wall must not be dropped to a kerb because the
 * room beyond it happens to end at that wall's north edge.
 *
 * Granularity is per authored rect, which is why nothing has to be split apart afterwards:
 * every room authors its own four perimeter walls (`world/rooms/ember.ts perimeterWalls`), so
 * a boundary reaches this function as two rects that get their own answers, and `RoomBuilder`
 * tiers before it merges — two different tiers simply never merge (`mergeWallRuns`). On floor
 * 3 that is what keeps `r1_furnace`'s north wall at full height while `r2_bastion`'s, which
 * really does have `r3_crucible` above it, drops: under the old rule the two had merged into
 * one 24-cell perimeter run. What stays approximate is a single rect only PARTLY covered by
 * the room above (`r2_kiln`'s north wall overhangs `r1_alcove` by one cell at each end): the
 * whole rect drops. Splitting it would put a 104 px stub beside a 22 px kerb at a join that is
 * already buried in the room's own west/east corner — a worse artifact than the uniform low
 * run, for 32 px of wall.
 */
function framesFloorFromSouth(wall: RectPx, room: RectPx): boolean {
  const overlapX = Math.min(wall.x + wall.w, room.x + room.w) - Math.max(wall.x, room.x);
  if (overlapX <= EDGE_TOLERANCE) return false;
  const south = room.y + room.h;
  if (wall.y >= room.y - EDGE_TOLERANCE && Math.abs(wall.y + wall.h - south) <= EDGE_TOLERANCE) return true;
  return Math.abs(wall.y - south) <= EDGE_TOLERANCE;
}

/** World-px height for a tier. */
export function wallHeight(tier: WallTier): number {
  switch (tier) {
    case 'perimeter':
      return WALL_H_PERIMETER;
    case 'interior':
      return WALL_H_INTERIOR;
    case 'kerb':
      return WALL_H_KERB;
  }
}
