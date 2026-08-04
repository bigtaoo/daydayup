// Pure PvE dungeon-progress math (design/10 "a real PvE minimap"), decoupled from
// Pixi like minimapLayout.ts. NOT the same shape as that file's PvP room-graph
// layout — PvE floors ARE co-resident now too (design/05 "Room & door model",
// 2026-08-04: every room of a floor is placed and stitched at once, matching PvP's
// `ArenaMap`), but this widget deliberately stays a linear PROGRESS TRACK rather than
// switching to the spatial `Minimap`: a PvE floor's rooms sit on a single generated
// west→east spine (`world/dungeon.ts placeFloor`), so a room-count + "how far in"
// track already tells the whole story with less screen space than a room-graph map
// would, for no real loss of information. `stageCount`/`roomIndex` below are derived
// from `GameState.dungeonRooms.length` and the local player's own `roomId` (looked up
// via `dungeonRoomIndexById`) by the caller (`HudView`) — there is no longer a single
// global "current room" field on `GameState` itself, since rooms are all live at once
// and "current" is inherently per-player.

export type StageStatus = 'done' | 'current' | 'upcoming';

export interface FloorProgressStep {
  index: number;
  status: StageStatus;
  // The floor's final stage (dungeon.ts: always the extraction/boss capstone room,
  // known upfront regardless of which room a branching choice eventually resolves to).
  capstone: boolean;
}

/** `stageCount` = `state.dungeonRooms.length` (0 for a non-dungeon config — flat
 * `EngineConfig.floors` or a PvP arena — the caller hides the widget entirely then,
 * same convention as roomStatus's "no zone → nothing is unsafe"). `roomIndex` = the
 * local player's room index (`dungeonRoomIndexById.get(p.roomId)`), or -1 before a
 * floor has placed / before that lookup resolves (the same one-tick activation lag
 * every room has right after a fresh floor is placed). */
export function computeFloorProgress(stageCount: number, roomIndex: number): FloorProgressStep[] {
  const steps: FloorProgressStep[] = [];
  for (let i = 0; i < stageCount; i++) {
    steps.push({
      index: i,
      status: i < roomIndex ? 'done' : i === roomIndex ? 'current' : 'upcoming',
      capstone: i === stageCount - 1,
    });
  }
  return steps;
}
