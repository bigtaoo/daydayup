// Split out of RoomBuilder (design/01 "walls, pillars and characters show a small front
// face"): the pure decision of WHICH wall segments may stand up, kept Pixi-free so it is
// testable without a canvas. RoomBuilder owns the drawing; this file owns the rule.

/** A wall/room footprint in world px (already through `fpToPx`). */
export interface RectPx {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** How tall a standing wall is drawn, in world px. Deliberately the same number as
 *  `RoomBuilder`'s pillar height so a wall and a pillar in one room read as one world. */
export const WALL_HEIGHT = 70;

/** Tolerance (world px) for "this wall's south edge IS the room's south edge". A wall is
 *  authored flush with its room's bounds, so anything short of a full grid cell is slack
 *  for the fixed-point → px conversion, not a real offset. */
const SOUTH_EDGE_TOLERANCE = 4;

/**
 * True when this wall may be drawn standing (front face + raised top cap) rather than
 * flat on the ground. Two independent tests, both learned from looking at the result
 * rather than from the geometry:
 *
 * **1. It must be an east-west run** (`w > h`). A standing wall is projected UPWARD on
 * screen from its own south edge (`screen.y = gy - z`, design/01), which means its top
 * cap lands `WALL_HEIGHT` px north of its footprint. For a shallow east-west wall that
 * is exactly right — cap, coping and face stack into a wall you can see the front of. For
 * a long north-south run (a room's east/west side) it is technically the same correct
 * projection but reads as a defect: the wall is 32 px wide and 400+ px long, so almost all
 * of what you see is the cap band sitting 70 px off its own footprint, with a single
 * stray lit coping edge down at the south end. Those stay flat, which is also how the
 * genre draws them — you see a room's back wall standing and its side walls in plan.
 *
 * **2. It must not be the room's own south perimeter.** Standing that one up puts 70 px of
 * stone between the camera and the player — hiding the thing the camera is framing.
 *
 * What passes both: a room's north wall (the money shot), and interior east-west stubs
 * (`ember_hall`'s north jetty, `ember_cross`'s side jetties), which then occlude what is
 * behind them exactly as a pillar already does.
 *
 * `rooms` is the floor's room rects (`GameState.dungeonRoomRects`/`arenaRoomRects`,
 * converted to px). Modes that populate neither (flat `EngineConfig.floors`) pass the
 * world rect as the single room, which gives the identical answer for a one-room world.
 */
export function wallRises(wall: RectPx, rooms: readonly RectPx[]): boolean {
  if (wall.w <= wall.h) return false;
  const cx = wall.x + wall.w / 2;
  const cy = wall.y + wall.h / 2;
  const room = rooms.find((r) => cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h);
  // A wall belonging to no known room (a corridor segment stitched between rooms, or a
  // mode with no room model at all) has no south-edge relationship to check — let it
  // stand, since the interesting case for those is exactly the same "you see its face".
  if (!room) return true;
  return wall.y + wall.h < room.y + room.h - SOUTH_EDGE_TOLERANCE;
}
