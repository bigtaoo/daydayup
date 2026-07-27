// Pure PvE dungeon-progress math (design/10 "a real PvE minimap"), decoupled from
// Pixi like minimapLayout.ts. NOT the same shape as that file's PvP room-graph
// layout: PvE loads exactly one room "live" at a time, hot-swapping its geometry on
// every transition (ROADMAP 1.3), so there is no co-resident multi-room map with
// real x/y positions to fit into a box — the earlier "blocked on multi-room floor
// wiring" note turned out to be stale (that wiring has been live since 2026-07-24),
// but the actual PvP-style spatial minimap still has no PvE data to draw from, by
// design. What PvE DOES have is `GameState.floorStages`/`roomIndex`: a known-upfront
// STAGE COUNT for the current floor (`world/dungeon.ts generateFloor`'s own
// guarantee: the last stage is always the single capstone extraction/boss room) and
// how far into it the run has gotten — a linear/branching PROGRESS TRACK, not a map.

export type StageStatus = 'done' | 'current' | 'upcoming';

export interface FloorProgressStep {
  index: number;
  status: StageStatus;
  // The floor's final stage (dungeon.ts: always the extraction/boss capstone room,
  // known upfront regardless of which room a branching choice eventually resolves to).
  capstone: boolean;
}

/** `stageCount` = `state.floorStages.length` (0 for a non-dungeon config — flat
 * `EngineConfig.floors` or a PvP arena — the caller hides the widget entirely then,
 * same convention as roomStatus's "no zone → nothing is unsafe"). `roomIndex` =
 * `state.roomIndex` (-1 before the first room of a fresh floor loads). */
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
