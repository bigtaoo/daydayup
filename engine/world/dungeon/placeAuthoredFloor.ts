/**
 * Hand-authored floor placement (design/05 "Hand-authored PvE floors", 2026-08-05),
 * split out of dungeon.ts (CLAUDE.md "500-line file convention", form ①).
 */
import type { RoomPiece } from '../../content/rooms';
import type { Door, RoomId } from '../../content/arenas';
import type { DungeonFloorMap, PlacedRoom } from './types';
import { ENTRANCE_INSET_GRID } from './placementConstants';
import { entranceFromDoor } from './entranceGeometry';

/**
 * Place an already-authored floor (design/05 "Hand-authored PvE floors") — a
 * sibling to `placeFloor`, not a variant of it: every door's `passageGrid` is
 * already fully authored, so there is no PRNG draw here at all (unlike
 * `placeFloor`'s `pickDoorAnchor`). Resolves each room's `pieceId` against
 * `library` (throws if missing — fail loud, matches `generateFloor`'s own
 * missing-capstone check) and computes each non-entrance room's `entranceGrid`
 * from whichever connecting door reaches it FIRST in `doors` array order (same
 * "first door wins" tie-break `placeFloor` already uses for a fork's merge
 * room), inset into the room along whichever axis the door's passage is
 * narrower on (`entranceFromDoor`) — generalizing `ENTRANCE_INSET_GRID`'s
 * existing west-only inset, which only worked because a generated floor's spine
 * is always west→east; a hand-authored floor's doors can sit on any of a room's
 * four walls, matching PvP's own map-editor door tool. `rooms[0]`'s own
 * `entranceGrid` instead comes from its own authored player spawn point (or a
 * size/2 fallback) — the same "first room reads its own spawn" rule
 * `placeFloor` uses, generalized to an arbitrary (not-necessarily-zero)
 * `offsetYGrid` since a hand-authored entrance room need not sit at the origin.
 * Returns the exact same `{placed, doors}` shape `placeFloor` does, so
 * `buildFloorGeometry` and every system downstream of it (`DoorSystem`,
 * `RoomBuilder`, `EventReactor`, the minimap adapter) need zero changes.
 */
export function placeAuthoredFloor(
  map: DungeonFloorMap,
  library: readonly RoomPiece[],
): { placed: PlacedRoom[]; doors: Door[] } {
  if (map.rooms.length === 0) throw new Error(`placeAuthoredFloor: '${map.id}' has no rooms`);

  const placed: PlacedRoom[] = map.rooms.map((r) => {
    const piece = library.find((p) => p.id === r.pieceId);
    if (!piece) throw new Error(`placeAuthoredFloor: '${map.id}' room '${r.id}' references unknown piece '${r.pieceId}'`);
    return { id: r.id, piece, offsetXGrid: r.offsetXGrid, offsetYGrid: r.offsetYGrid, entranceGrid: { x: 0, y: 0 } };
  });

  const byId = new Map(placed.map((r) => [r.id, r] as const));
  const first = placed[0]!;
  const entranceSet = new Set<RoomId>([first.id]); // first.entranceGrid is set below, from its own spawn, never from a door

  for (const door of map.doors) {
    const a = byId.get(door.roomA);
    const b = byId.get(door.roomB);
    if (!a || !b) {
      throw new Error(`placeAuthoredFloor: '${map.id}' door references unknown room ('${door.roomA}'/'${door.roomB}')`);
    }
    for (const target of [b, a]) {
      if (entranceSet.has(target.id)) continue;
      target.entranceGrid = entranceFromDoor(target, door.passageGrid);
      entranceSet.add(target.id);
    }
  }

  const sp = first.piece.spawns.player[0];
  first.entranceGrid = sp
    ? { x: first.offsetXGrid + sp.x, y: first.offsetYGrid + sp.y }
    : { x: first.offsetXGrid + ENTRANCE_INSET_GRID, y: first.offsetYGrid + first.piece.sizeGrid.h / 2 };

  return { placed, doors: map.doors.slice() };
}
