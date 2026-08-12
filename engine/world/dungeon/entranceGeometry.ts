/**
 * Shared entrance-point geometry, split out of dungeon.ts (CLAUDE.md "500-line
 * file convention", form ①). A leaf helper: used by both ./placeFloorGraph2d.ts
 * and ./placeAuthoredFloor.ts (their doors can sit on any of a room's four
 * walls, unlike ./placeFloor.ts's west-only spine, which computes its own inline
 * entrance instead of calling this).
 */
import type { AabbGrid } from '../../content/rooms';
import type { PlacedRoom } from './types';
import { ENTRANCE_INSET_GRID } from './placementConstants';

/** A point just inside `room`, off `passageGrid`'s door — generalizes
 * `pickDoorAnchor`'s spine-only west-inset convention to an arbitrary wall. The
 * passage's narrower dimension identifies which axis to inset along (a
 * vertical passage — narrower in X — sits on an east/west wall, so the inset is
 * along X; a horizontal passage sits on a north/south wall, so the inset is
 * along Y); whichever side of `room`'s own center the passage falls on picks
 * the inset direction (west vs east, or north vs south). Ties (a square
 * passage, or a center exactly on the room's own center) resolve to the
 * vertical/west-ish branch — an arbitrary but deterministic choice, same class
 * as any other tie-break in this module. */
export function entranceFromDoor(room: PlacedRoom, passageGrid: AabbGrid): { x: number; y: number } {
  const cx = passageGrid.x + passageGrid.w / 2;
  const cy = passageGrid.y + passageGrid.h / 2;
  if (passageGrid.w <= passageGrid.h) {
    const roomCenterX = room.offsetXGrid + room.piece.sizeGrid.w / 2;
    const x =
      cx <= roomCenterX ? room.offsetXGrid + ENTRANCE_INSET_GRID : room.offsetXGrid + room.piece.sizeGrid.w - ENTRANCE_INSET_GRID;
    return { x, y: cy };
  }
  const roomCenterY = room.offsetYGrid + room.piece.sizeGrid.h / 2;
  const y =
    cy <= roomCenterY ? room.offsetYGrid + ENTRANCE_INSET_GRID : room.offsetYGrid + room.piece.sizeGrid.h - ENTRANCE_INSET_GRID;
  return { x: cx, y };
}
