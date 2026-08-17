/**
 * PvE room-graph navigation — the pure half of the level simulator's bot
 * (`PveBotController`), split out so it is testable without driving a whole run
 * (CLAUDE.md form ①: independent free functions, no shared state).
 *
 * Everything here reads the SAME co-resident room/door state the engine itself
 * maintains (design/05 "Room & door model"): `dungeonRoomRects` for room bounds,
 * `dungeonDoors` for the connectivity graph plus each passage's pre-converted Fp
 * AABB, `dungeonRoomRuntime` (index-aligned via `dungeonRoomIndexById`) for
 * activation/live-enemy flags. No procedural knowledge of a floor's authored shape
 * is assumed, so this navigates a hand-authored floor (`world/dungeons/ember/`) and
 * a procedurally-placed one identically.
 *
 * Units are Fp throughout (grid × FP_SCALE) — the same units actors carry — so
 * nothing here converts to px or back.
 */
import type { GameState } from '@dd/engine';

export interface Vec {
  x: number;
  y: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function rectCentre(r: Rect): Vec {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

export function pointInRect(x: number, y: number, r: Rect): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

/** The room whose rect contains this point, or undefined while inside a door
 *  passage / outside the floor entirely (the caller keeps its last known room —
 *  see `PveBotController.currentRoom`). Array order decides ties, matching the
 *  engine's own room-order determinism convention. */
export function roomIdAt(s: GameState, x: number, y: number): string | undefined {
  for (const r of s.dungeonRoomRects) if (pointInRect(x, y, r.rect)) return r.id;
  return undefined;
}

export function roomRect(s: GameState, id: string): Rect | undefined {
  return s.dungeonRoomRects.find((r) => r.id === id)?.rect;
}

/** Runtime row for a room id (activation / live-enemy flags), via the engine's own
 *  O(1) id→index map. */
export function roomRuntime(s: GameState, id: string) {
  const idx = s.dungeonRoomIndexById.get(id);
  return idx === undefined ? undefined : s.dungeonRoomRuntime[idx];
}

/** This floor's capstone (extraction/boss) room id — always the LAST placed room,
 *  the same single-index convention `ExtractionSystem.capstoneCleared` relies on. */
export function capstoneRoomId(s: GameState): string | undefined {
  return s.dungeonRooms[s.dungeonRooms.length - 1]?.id;
}

/** Room id → the ids it shares a door with. Rebuilt per call: a floor has a handful
 *  of doors, and caching it would have to be invalidated on every DESCEND. */
export function adjacency(s: GameState): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    const list = adj.get(a);
    if (list) list.push(b);
    else adj.set(a, [b]);
  };
  for (const d of s.dungeonDoors) {
    link(d.door.roomA, d.door.roomB);
    link(d.door.roomB, d.door.roomA);
  }
  return adj;
}

/** The passage centre between two adjacent rooms, or undefined if no door joins
 *  them. `passageAabb` is the engine's own pre-converted Fp rect (design/05 —
 *  converted once at placement, never re-derived at match time). */
export function doorCentre(s: GameState, a: string, b: string): Vec | undefined {
  for (const d of s.dungeonDoors) {
    const { roomA, roomB } = d.door;
    if ((roomA === a && roomB === b) || (roomA === b && roomB === a)) return rectCentre(d.passageAabb);
  }
  return undefined;
}

/**
 * Breadth-first room path from `from` to the nearest room satisfying `isGoal`,
 * inclusive of both ends (`[from]` when `from` itself is the goal). Null when no
 * such room is reachable. Neighbour order follows door array order, so the path
 * is deterministic for a given floor — the whole point of using BFS over the
 * authored door graph rather than a distance heuristic.
 */
export function bfsPath(s: GameState, from: string, isGoal: (id: string) => boolean): string[] | null {
  if (isGoal(from)) return [from];
  const adj = adjacency(s);
  const prev = new Map<string, string>([[from, from]]);
  const queue = [from];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head]!;
    for (const next of adj.get(cur) ?? []) {
      if (prev.has(next)) continue;
      prev.set(next, cur);
      if (isGoal(next)) {
        const path = [next];
        let step = next;
        while (step !== from) {
          step = prev.get(step)!;
          path.unshift(step);
        }
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}
