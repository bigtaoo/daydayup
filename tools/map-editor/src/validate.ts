// Structural, save-blocking validation for the two content shapes this editor
// produces (design/09 RoomPiece, design/15 ArenaMap). Hand-written type guards,
// no schema-library dependency — matches this repo's existing style (no
// validation library appears anywhere in client/server either). Pure functions,
// no DOM/Pixi — kept trivially unit-testable.
import type { RoomPiece } from '@dd/engine';
import type { ArenaMap } from '@dd/engine/content/arenas';

export interface ValidationIssue {
  message: string;
}

function isPositiveInt(n: number): boolean {
  return Number.isInteger(n) && n > 0;
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
