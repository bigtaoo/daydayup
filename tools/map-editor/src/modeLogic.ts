// Pure mode-transition decision logic pulled out of main.ts's untestable
// entry-point shell — main.ts does `document.getElementById(...)` casts at module
// scope and fires `void init()` (a real Platform/canvas mount) the instant it's
// imported, so none of its logic is unit-testable without triggering that (mirrors
// client/src/bootError.ts's same "leaf module carved out of an untestable shell"
// precedent). Nothing in this file touches the DOM, a canvas instance, or any other
// side effect — main.ts calls these to decide *what* to do, then applies the result
// to the real objects itself.

export type Mode = 'roomLibrary' | 'arena' | 'dungeonFloor';
export type ArenaView = { kind: 'map' } | { kind: 'room'; roomId: string };

export type VisibleHost = 'room' | 'arena' | 'dungeonFloor';

/** Which of the three mounted canvases (RoomCanvas / ArenaCanvas / DungeonFloorCanvas)
 *  should be on screen for the given mode/arenaView combination — main.ts's setMode
 *  and syncArenaView both reduce to this single decision. */
export function visibleHost(mode: Mode, arenaView: ArenaView): VisibleHost {
  if (mode === 'roomLibrary') return 'room';
  if (mode === 'dungeonFloor') return 'dungeonFloor';
  // mode === 'arena': the shared RoomCanvas doubles as the drilled-in PvP room editor.
  return arenaView.kind === 'map' ? 'arena' : 'room';
}

/** True when the shared RoomCanvas (as opposed to the arena-map or dungeon-floor
 *  canvas) is the one on screen — either the PvE Room Library itself, or a PvP room
 *  drilled into from the arena map. Determines which tool row renderTopbar offers. */
export function onRoomCanvas(mode: Mode, arenaView: ArenaView): boolean {
  return mode === 'roomLibrary' || (mode === 'arena' && arenaView.kind === 'room');
}

export interface RoomToolDescriptor<T extends string> {
  id: T;
  label: string;
}

/** Filters the full ROOM_TOOLS list down to what's valid for the room canvas's
 *  current owner: PvP rooms (arena, non-PvE) have no per-room player spawn
 *  (design/15 — that lives once at ArenaMap.spawns instead), and PvE RoomPiece has
 *  neither a cellTraits nor a lootMarkers field. */
export function roomToolsForMode<T extends string>(
  mode: Mode,
  allTools: readonly RoomToolDescriptor<T>[],
): RoomToolDescriptor<T>[] {
  const isPve = mode === 'roomLibrary';
  return allTools.filter((t) => {
    if (t.id === 'playerSpawn' && !isPve) return false;
    if ((t.id === 'cellTrait' || t.id === 'lootMarker') && isPve) return false;
    return true;
  });
}
