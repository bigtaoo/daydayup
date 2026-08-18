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
 * - `WALL_H_KERB` — the room's SOUTH boundary only. It cannot have a real height: it sits
 *   between the camera and the player it is framing, and anything tall there hides the
 *   character. A low kerb still reads as a raised lip and still casts a shadow, and is
 *   provably safe — the player's own collision radius keeps their ground point at least a
 *   wall thickness north of the south edge, so a kerb this short can never reach them.
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
 */
export function wallTier(wall: RectPx, rooms: readonly RectPx[]): WallTier {
  const cx = wall.x + wall.w / 2;
  const cy = wall.y + wall.h / 2;
  const room = rooms.find((r) => cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h);
  // A wall belonging to no known room (a corridor segment stitched between rooms, or a mode
  // with no room model at all) has no edge relationship to check. Treated as perimeter: a
  // corridor IS a boundary on both sides, and it is never the thing the camera is framing.
  if (!room) return 'perimeter';

  const onSouth = wall.y + wall.h >= room.y + room.h - EDGE_TOLERANCE;
  if (onSouth) return 'kerb';

  const onNorth = wall.y <= room.y + EDGE_TOLERANCE;
  const onWest = wall.x <= room.x + EDGE_TOLERANCE;
  const onEast = wall.x + wall.w >= room.x + room.w - EDGE_TOLERANCE;
  return onNorth || onWest || onEast ? 'perimeter' : 'interior';
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
