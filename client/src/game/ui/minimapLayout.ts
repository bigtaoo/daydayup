import type { ArenaMap, RoomId } from '@dd/engine/content/arenas';
import type { ZoneState } from '@dd/engine';

// Pure minimap math (design/10 "room progress"), decoupled from Pixi so it's unit-
// testable the same way the engine's own content converters are (content/arenas.ts
// buildArenaGeometry). PvP-only, and PERMANENTLY so — not a staging gap. PvE's
// ROADMAP 1.3 dungeon wiring has been live since 2026-07-24 (an earlier version of
// this comment was stale on that point), but PvE loads exactly ONE room live at a
// time, hot-swapping its geometry on every transition — there is no co-resident
// multi-room `ArenaMap`-shaped layout for PvE to ever feed into `computeMinimapLayout`
// (PvP's map is co-resident by design, ROADMAP 4.2b). PvE's own "real minimap" is a
// different, honest shape for its actual data — a progress TRACK, not a spatial map
// — see `client/src/game/ui/floorProgressMath.ts`/`FloorProgress.ts`.

export interface MinimapRoomLayout {
  id: RoomId;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MinimapDoorLayout {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface MinimapLayout {
  rooms: MinimapRoomLayout[];
  doors: MinimapDoorLayout[];
}

/** Fit every room's `rectGrid` into `box` (aspect-preserving, centred) — a pure
 * coordinate transform, same offset/scale for rooms and the doors built from them. */
export function computeMinimapLayout(map: ArenaMap, box: { w: number; h: number }): MinimapLayout {
  const { w: mapW, h: mapH } = map.sizeGrid;
  const scale = mapW > 0 && mapH > 0 ? Math.min(box.w / mapW, box.h / mapH) : 0;
  const offX = (box.w - mapW * scale) / 2;
  const offY = (box.h - mapH * scale) / 2;

  const roomsById = new Map<RoomId, MinimapRoomLayout>();
  const rooms = map.rooms.map((r) => {
    const layout: MinimapRoomLayout = {
      id: r.id,
      x: offX + r.rectGrid.x * scale,
      y: offY + r.rectGrid.y * scale,
      w: r.rectGrid.w * scale,
      h: r.rectGrid.h * scale,
    };
    roomsById.set(r.id, layout);
    return layout;
  });

  const doors: MinimapDoorLayout[] = [];
  for (const door of map.doors) {
    const a = roomsById.get(door.roomA);
    const b = roomsById.get(door.roomB);
    if (!a || !b) continue; // malformed door (unknown room id) — content bug, skip rather than throw
    doors.push({ x1: a.x + a.w / 2, y1: a.y + a.h / 2, x2: b.x + b.w / 2, y2: b.y + b.h / 2 });
  }
  return { rooms, doors };
}

export type RoomStatus = 'safe' | 'closing' | 'danger';

/** A room's current zone read, for minimap tinting. No `zone` yet (the first tick
 * before ZoneSystem draws the eye, or simply not an arena match) → nothing is unsafe.
 * `closing` only carries meaning during the 'warn' phase (ZoneSystem) — the announced
 * telegraph before those rooms actually go poison at the next 'hold'. */
export function roomStatus(zone: ZoneState | undefined, roomId: RoomId): RoomStatus {
  if (!zone) return 'safe';
  if (zone.phase === 'warn' && zone.closing.includes(roomId)) return 'closing';
  return zone.safe.includes(roomId) ? 'safe' : 'danger';
}
