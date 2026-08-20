// Structural, save-blocking validation for the two content shapes this editor
// produces (design/09 RoomPiece, design/15 ArenaMap). Hand-written type guards,
// no schema-library dependency — matches this repo's existing style (no
// validation library appears anywhere in client/server either). Pure functions,
// no DOM/Pixi — kept trivially unit-testable.
import type { RoomPiece, DungeonFloorMap } from '@dd/engine';
import type { ArenaMap } from '@dd/engine/content/arenas';

export interface ValidationIssue {
  message: string;
}

function isPositiveInt(n: number): boolean {
  return Number.isInteger(n) && n > 0;
}

/** A passage rect must land on whole grid cells. `solids` and `sizeGrid` have been
 * held to this since the first validator; a `passageGrid` never was, and a
 * half-cell one is not a cosmetic slip: `carveDoorGaps` cuts a correspondingly
 * misaligned hole and whatever is left of the wall run past it inherits the
 * offset. Four wall runs in shipped level-1 content stood 16 px deep that way
 * (`ENGINE_VERSION` 44) — the worst case for the standing-wall art, since a cap
 * band lands on a third of the depth every wall tone was measured on. The door
 * tool itself only ever produces whole cells; this catches a value typed into the
 * Inspector's numeric `passageGrid` fields by hand. */
function isGridAlignedRect(r: { x: number; y: number; w: number; h: number }): boolean {
  return Number.isInteger(r.x) && Number.isInteger(r.y) && isPositiveInt(r.w) && isPositiveInt(r.h);
}

function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  // Strict inequalities: two rects sharing only a boundary edge (the normal
  // shape of two arena rooms a Door connects) are NOT an overlap.
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function validateRoomPiece(piece: RoomPiece): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!piece.id.trim()) issues.push({ message: 'Room piece must have a non-empty id.' });
  if (!isPositiveInt(piece.sizeGrid.w) || !isPositiveInt(piece.sizeGrid.h)) {
    issues.push({ message: 'sizeGrid.w/h must be positive integers.' });
  }
  if (piece.spawns.player.length < 1) {
    issues.push({ message: 'A RoomPiece needs at least one player spawn.' });
  }
  piece.solids.forEach((s, i) => {
    if (!isPositiveInt(s.w) || !isPositiveInt(s.h)) {
      issues.push({ message: `solids[${i}] must have positive integer w/h.` });
    }
  });
  (piece.pillars ?? []).forEach((p, i) => {
    if (!(p.radius > 0)) issues.push({ message: `pillars[${i}].radius must be positive.` });
  });

  const enemyCount = piece.spawns.enemy.length;
  (piece.encounter?.entries ?? []).forEach((entry, i) => {
    if (entry.spawnPoint < 0 || entry.spawnPoint >= enemyCount) {
      issues.push({
        message: `encounter.entries[${i}].spawnPoint (${entry.spawnPoint}) has no matching enemy spawn (only ${enemyCount} placed).`,
      });
    }
    if (!isPositiveInt(entry.count)) issues.push({ message: `encounter.entries[${i}].count must be a positive integer.` });
  });

  return issues;
}

export function validateArenaMap(map: ArenaMap): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!isPositiveInt(map.sizeGrid.w) || !isPositiveInt(map.sizeGrid.h)) {
    issues.push({ message: 'ArenaMap.sizeGrid.w/h must be positive integers.' });
  }

  const seenIds = new Set<string>();
  for (const room of map.rooms) {
    if (!room.id.trim()) issues.push({ message: 'Every ArenaRoom needs a non-empty id.' });
    if (seenIds.has(room.id)) issues.push({ message: `Duplicate room id "${room.id}".` });
    seenIds.add(room.id);
    if (!isPositiveInt(room.rectGrid.w) || !isPositiveInt(room.rectGrid.h)) {
      issues.push({ message: `Room "${room.id}" rectGrid.w/h must be positive integers.` });
    }
  }

  // No two rooms may overlap — the room-membership point-in-rect test
  // (design/15) and the zone/BFS model both assume disjoint room rects.
  for (let i = 0; i < map.rooms.length; i++) {
    for (let j = i + 1; j < map.rooms.length; j++) {
      const a = map.rooms[i]!;
      const b = map.rooms[j]!;
      if (rectsOverlap(a.rectGrid, b.rectGrid)) {
        issues.push({ message: `Rooms "${a.id}" and "${b.id}" overlap.` });
      }
    }
  }

  for (const door of map.doors) {
    if (!seenIds.has(door.roomA)) issues.push({ message: `Door references unknown room "${door.roomA}".` });
    if (!seenIds.has(door.roomB)) issues.push({ message: `Door references unknown room "${door.roomB}".` });
    if (door.roomA === door.roomB) issues.push({ message: `Door cannot connect room "${door.roomA}" to itself.` });
  }

  for (const eye of map.eyeCandidates) {
    if (!seenIds.has(eye.roomId)) issues.push({ message: `Eye candidate references unknown room "${eye.roomId}".` });
  }

  for (const room of map.rooms) {
    const enemyCount = room.spawns?.length ?? 0;
    (room.encounter?.entries ?? []).forEach((entry, i) => {
      if (entry.spawnPoint < 0 || entry.spawnPoint >= enemyCount) {
        issues.push({
          message: `Room "${room.id}" encounter.entries[${i}].spawnPoint (${entry.spawnPoint}) has no matching enemy spawn (only ${enemyCount} placed).`,
        });
      }
    });
  }

  return issues;
}

/** Whether `passage` sits within the actual touching band between `a` and `b` —
 * mirrors `DungeonFloorCanvas.tryConnectDoor`'s own touch computation, but as a
 * static check (a hand-edited `passageGrid` value, not one the door tool itself
 * just computed, can drift from a real shared wall). */
function doorSitsOnSharedBoundary(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
  passage: { x: number; y: number; w: number; h: number },
): boolean {
  const vTouch = a.x + a.w === b.x || b.x + b.w === a.x;
  if (vTouch) {
    const boundaryX = a.x + a.w === b.x ? b.x : a.x;
    if (Math.abs(passage.x + passage.w / 2 - boundaryX) > passage.w) return false;
    const overlapY0 = Math.max(a.y, b.y);
    const overlapY1 = Math.min(a.y + a.h, b.y + b.h);
    return passage.y >= overlapY0 && passage.y + passage.h <= overlapY1;
  }
  const hTouch = a.y + a.h === b.y || b.y + b.h === a.y;
  if (hTouch) {
    const boundaryY = a.y + a.h === b.y ? b.y : a.y;
    if (Math.abs(passage.y + passage.h / 2 - boundaryY) > passage.h) return false;
    const overlapX0 = Math.max(a.x, b.x);
    const overlapX1 = Math.min(a.x + a.w, b.x + b.w);
    return passage.x >= overlapX0 && passage.x + passage.w <= overlapX1;
  }
  return false; // the two rooms don't even share a boundary
}

/**
 * Save-time gate for a hand-authored PvE floor (design/05 "Hand-authored PvE
 * floors", 2026-08-05) — mirrors `validateArenaMap`'s shape (structural,
 * save-blocking, no engine dependency beyond the types) plus the two checks a
 * PvE floor specifically needs that PvP's `ArenaMap` doesn't: reachability from
 * the entrance room (a PvE floor's progression genuinely depends on it, unlike
 * PvP's simultaneously-relevant zone rooms) and the capstone-must-be-last
 * convention `ExtractionSystem`/`SpawnSystem` already assume
 * (`engine/systems/ExtractionSystem.ts`'s `dungeonRoomRuntime[length - 1]`,
 * `engine/systems/SpawnSystem.ts`'s `placed[0]`). `library` is whatever's
 * currently open in the "PvE Room Library" tab — the same resolution scope
 * `DungeonFloorCanvas` itself uses, not a claim about the eventual runtime
 * library.
 */
export function validateDungeonFloorMap(map: DungeonFloorMap, library: readonly RoomPiece[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (map.rooms.length === 0) {
    issues.push({ message: 'A dungeon floor needs at least one room.' });
    return issues;
  }

  const seenIds = new Set<string>();
  const rects = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const room of map.rooms) {
    if (!room.id.trim()) issues.push({ message: 'Every room needs a non-empty id.' });
    if (seenIds.has(room.id)) issues.push({ message: `Duplicate room id "${room.id}".` });
    seenIds.add(room.id);
    const piece = library.find((p) => p.id === room.pieceId);
    if (!piece) {
      issues.push({ message: `Room "${room.id}" references unknown piece "${room.pieceId}" (open it in the Room Library tab).` });
      continue;
    }
    rects.set(room.id, { x: room.offsetXGrid, y: room.offsetYGrid, w: piece.sizeGrid.w, h: piece.sizeGrid.h });
  }

  const ids = map.rooms.map((r) => r.id);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = rects.get(ids[i]!);
      const b = rects.get(ids[j]!);
      if (a && b && rectsOverlap(a, b)) issues.push({ message: `Rooms "${ids[i]}" and "${ids[j]}" overlap.` });
    }
  }

  for (const door of map.doors) {
    if (!seenIds.has(door.roomA)) issues.push({ message: `Door references unknown room "${door.roomA}".` });
    if (!seenIds.has(door.roomB)) issues.push({ message: `Door references unknown room "${door.roomB}".` });
    if (door.roomA === door.roomB) issues.push({ message: `Door cannot connect room "${door.roomA}" to itself.` });
    if (!isGridAlignedRect(door.passageGrid)) {
      issues.push({ message: `Door between "${door.roomA}" and "${door.roomB}" has a passageGrid off the grid — x/y must be whole cells and w/h positive whole cells.` });
    }
    const a = rects.get(door.roomA);
    const b = rects.get(door.roomB);
    if (a && b && !doorSitsOnSharedBoundary(a, b, door.passageGrid)) {
      issues.push({ message: `Door between "${door.roomA}" and "${door.roomB}" does not sit on a real shared wall.` });
    }
  }

  // Reachability from the entrance room (rooms[0]) via the door graph.
  const adjacency = new Map<string, string[]>();
  for (const id of ids) adjacency.set(id, []);
  for (const door of map.doors) {
    if (adjacency.has(door.roomA) && adjacency.has(door.roomB)) {
      adjacency.get(door.roomA)!.push(door.roomB);
      adjacency.get(door.roomB)!.push(door.roomA);
    }
  }
  const entranceId = ids[0]!;
  const reached = new Set<string>([entranceId]);
  const queue = [entranceId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const next of adjacency.get(cur) ?? []) {
      if (!reached.has(next)) {
        reached.add(next);
        queue.push(next);
      }
    }
  }
  for (const id of ids) {
    if (!reached.has(id)) issues.push({ message: `Room "${id}" is not reachable from the entrance room "${entranceId}".` });
  }

  // Capstone convention: the LAST room must resolve to an extraction/boss piece —
  // ExtractionSystem/SpawnSystem read placement order, not an authored flag.
  const lastRoom = map.rooms[map.rooms.length - 1]!;
  const lastPiece = library.find((p) => p.id === lastRoom.pieceId);
  if (lastPiece && lastPiece.role !== 'extraction' && lastPiece.role !== 'boss') {
    issues.push({
      message: `The last room ("${lastRoom.id}") must use an extraction/boss RoomPiece — the engine reads placement order, not an authored flag, to find the capstone.`,
    });
  }

  return issues;
}
