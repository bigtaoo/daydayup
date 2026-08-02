/**
 * ArenaMap — the PvP map-editor's output contract (design/15, ROADMAP 4.2c), and the
 * "co-resident multi-room world" half of ROADMAP 4.2b: unlike a PvE floor's rooms
 * (visited SEQUENTIALLY — `SpawnSystem.loadRoom` swaps one room's geometry in at a
 * time, `content/rooms.ts`), every `ArenaRoom` in an `ArenaMap` is placed at its own
 * offset (`rectGrid.x/y`) and stitched into ONE simultaneously-live world — the zone,
 * cross-door fights, and free roaming all depend on every room staying resident at
 * once. `buildArenaGeometry` below is the pure converter that does the stitching,
 * reusing `content/rooms.ts roomGeometry` per room (same solids/pillars vocabulary).
 *
 * This module only defines the shape + pure converters/helpers (matching
 * content/rooms.ts's own scope) — no GameState import, so content/state can depend on
 * this without a cycle. `ZoneSystem`/`EnvironmentSystem` (ROADMAP 4.2d) read
 * `doors`/`eyeCandidates`/`cellTraits`; `SpawnSystem` (ROADMAP 4.3) reads
 * `encounter`/`spawns`/`lootMarkers`.
 */
import { toFpGrid } from './convert';
import {
  roomGeometry,
  type AabbGrid,
  type Point,
  type PillarGrid,
  type PropPlacement,
  type SpawnPoint,
  type WaveScript,
} from './rooms';
import type { DamageType } from './damage';
import type { AABB, Obstacle } from '../state/entities';
import type { Fp } from '../math/fixed';

export type RoomId = string;

/**
 * PvP zone tuning (design/15, ROADMAP 4.2d). Design/15 is explicit that the EXACT
 * numbers are content-tuning, not part of its locked shape ("real play required") —
 * these are first-pass placeholders that exercise the stage-machine MECHANISM (which
 * IS locked), not tuned values. Revisit once real playtests exist (ROADMAP 4.3).
 */
export const ZONE = {
  /** BFS-hop distance the safe radius shrinks by each stage. */
  shrinkStep: 1,
  /** Ticks the next stage's closing rooms are telegraphed before CLOSE (design/15 WARN). */
  warnTicks: 150, // ~5s @ 30 Hz
  /** Ticks a stage holds stable once CLOSE has run (design/15 HOLD). */
  holdTicks: 300, // ~10s @ 30 Hz
  /** Integer damage/tick to an actor outside the safe set, before escalation. */
  damagePerTick: 1,
  /** Added to damagePerTick for every HOLD cycle run once the final (1-room) stage is
   * reached — design/15's "no further shrink, only escalating damage" hard time bound. */
  escalationStep: 1,
};

/** An editor-placed hazard tile (design/15) — spikes, freeze, etc. Always-on tiles
 * apply every tick an actor overlaps `rectGrid`; phased tiles cycle through their own
 * arm/active phase (`phase`), independent of the zone's stage clock. `damage`/
 * `damageType` reuse the same vocabulary as any other hit (omitted damageType →
 * 'physical', same forward-compat default as a weapon spec); a trait with no
 * `damage` (or `damage <= 0`) is inert — reserved for a future non-damage effect. */
export interface CellTrait {
  id: string;
  rectGrid: AabbGrid;
  kind: string; // 'spike' | 'freeze' | ... — an open-ended content id, not yet enumerated
  timed: boolean; // false = always-on; true = phased
  phase?: { armTicks: number; activeTicks: number; offsetTicks?: number };
  damage?: number;
  damageType?: DamageType;
}

/** A loot spawn point tagged with which (arena-scoped) DropTable to roll — same drop
 * *model* as PvE, a separate table (design/15). `SpawnSystem` spawns one pickup per
 * marker when its room activates (ROADMAP 4.3). `tableId` is carried but not yet
 * differentiated — the arena's actual per-table weighting catalog is explicitly
 * still "to design" (design/15's open-questions list), so every marker currently
 * rolls the single arena-wide table (`content/drops.ts rollArenaDrop`) regardless of
 * which id it names; a real catalog keyed by `tableId` is a follow-up, not a
 * behavior change to what's built now. */
export interface LootMarker {
  point: Point;
  tableId: string;
}

/** One room's placement + collision/content geometry within an ArenaMap. Same
 * solids/pillars vocabulary as `RoomPiece` (content/rooms.ts) — `rectGrid.x/y` is
 * this room's offset in the shared map, `rectGrid.w/h` its footprint (the
 * room-membership point-in-rect test, `EnvironmentSystem`; not read by
 * `buildArenaGeometry` itself, which only needs the offset). `spawns` is the enemy
 * spawn-point list `encounter.entries[].spawnPoint` indexes into (design/15's shown
 * schema omits this, but a WaveScript is meaningless without it — same vocabulary
 * as `RoomPiece.spawns.enemy`, ROADMAP 4.3). */
export interface ArenaRoom {
  id: RoomId;
  rectGrid: { x: number; y: number; w: number; h: number };
  solids: AabbGrid[];
  pillars?: PillarGrid[];
  cellTraits?: CellTrait[];
  encounter?: WaveScript;
  spawns?: SpawnPoint[];
  lootMarkers?: LootMarker[];
  props?: PropPlacement[];
}

/** Explicit room-to-room adjacency (design/15) — NEVER inferred from `rectGrid`
 * proximity; two rooms sharing an edge with a solid wall between them are not
 * adjacent unless a `Door` says so. Read by `computeRoomDistances`'s BFS below. */
export interface Door {
  roomA: RoomId;
  roomB: RoomId;
  passageGrid: AabbGrid;
}

/** A candidate final-circle room for the zone's eye draw (design/15); `weight` 0 (or
 * a room simply absent from this list) never gets drawn as final — omitted `weight`
 * defaults to 1 (selectable). Read by `ZoneSystem`'s eye draw. */
export interface EyeCandidate {
  roomId: RoomId;
  weight?: number;
}

export interface ArenaMap {
  id: string;
  sizeGrid: { w: number; h: number }; // total map extent
  rooms: ArenaRoom[];
  doors: Door[];
  spawns: Point[];
  eyeCandidates: EyeCandidate[];
}

/**
 * Stitch every room in the map into one co-resident world's collision geometry
 * (ROADMAP 4.2b) — each room's `solids`/`pillars` converted via the shared
 * `roomGeometry` at its own `rectGrid.x/y` offset, then concatenated. Pure and
 * side-effect-free, same contract as `roomGeometry` itself: produces the arrays
 * `state.walls`/`state.obstacles` are built from, plus the map's overall bounds.
 */
export function buildArenaGeometry(map: ArenaMap): { walls: AABB[]; obstacles: Obstacle[]; worldW: Fp; worldH: Fp } {
  const walls: AABB[] = [];
  const obstacles: Obstacle[] = [];
  for (const room of map.rooms) {
    const geo = roomGeometry(room, room.rectGrid.x, room.rectGrid.y);
    walls.push(...geo.walls);
    obstacles.push(...geo.obstacles);
  }
  return { walls, obstacles, worldW: toFpGrid(map.sizeGrid.w), worldH: toFpGrid(map.sizeGrid.h) };
}

/**
 * Pre-convert every room's `cellTraits` to absolute-Fp rects, ONE time (construction-
 * time float math is fine, design/09; `EnvironmentSystem`'s per-tick check must never
 * call `toFpGrid` itself — design/09's "authoring converters run once, never inside a
 * system at match time"). Mirrors `buildArenaGeometry`'s per-room offset handling.
 */
export function buildArenaCellTraits(map: ArenaMap): { trait: CellTrait; rect: AABB }[] {
  const out: { trait: CellTrait; rect: AABB }[] = [];
  for (const room of map.rooms) {
    for (const trait of room.cellTraits ?? []) {
      const r = trait.rectGrid;
      out.push({
        trait,
        rect: {
          x: toFpGrid(r.x + room.rectGrid.x),
          y: toFpGrid(r.y + room.rectGrid.y),
          w: toFpGrid(r.w),
          h: toFpGrid(r.h),
        },
      });
    }
  }
  return out;
}

/**
 * Pre-convert every room's `rectGrid` (already in absolute map coordinates — unlike
 * `solids`/`cellTraits`, a room's own rect needs no per-room offset added) to Fp,
 * ONE time — the room-membership point-in-rect test (`EnvironmentSystem`) must never
 * call `toFpGrid` itself, same construction-time-only rule as everything else here.
 */
export function buildArenaRoomRects(map: ArenaMap): { id: RoomId; rect: AABB }[] {
  return map.rooms.map((room) => ({
    id: room.id,
    rect: {
      x: toFpGrid(room.rectGrid.x),
      y: toFpGrid(room.rectGrid.y),
      w: toFpGrid(room.rectGrid.w),
      h: toFpGrid(room.rectGrid.h),
    },
  }));
}

/**
 * Is a `CellTrait` currently in its damaging phase, at this sim tick? Always-on
 * traits (`timed: false`) are always active. A phased trait's arm→active→arm→...
 * cycle is a pure function of `state.tick` — no separate per-trait counter needed in
 * GameState (design/15 "its own cycle" is just a fixed period, and a fixed-period
 * cycle is exactly a modulo of the global tick, not state that needs to be tracked
 * separately or replicated).
 */
export function isTraitActive(trait: CellTrait, tick: number): boolean {
  if (!trait.timed) return true;
  if (!trait.phase) return false; // timed but no phase authored — never active (content bug, fail safe)
  const { armTicks, activeTicks, offsetTicks } = trait.phase;
  const period = armTicks + activeTicks;
  if (period <= 0) return false;
  const pos = (tick + (offsetTicks ?? 0)) % period;
  return pos >= armTicks;
}

/**
 * BFS hop-distance from `eyeRoomId` to every room, over the EXPLICIT `doors` graph
 * (design/15 — never inferred from `rectGrid` proximity). Returns an array parallel
 * to `map.rooms`; `-1` = unreachable from the eye. Distance is well-defined
 * regardless of neighbor-visitation order (BFS correctness), so the `Map` used below
 * is a pure O(1) id→index LOOKUP, never iterated — it doesn't affect the result,
 * unlike the codebase's usual Set/Map-iteration-order caution (design/06/08).
 */
export function computeRoomDistances(map: ArenaMap, eyeRoomId: RoomId): number[] {
  const idToIndex = new Map<RoomId, number>();
  map.rooms.forEach((r, i) => idToIndex.set(r.id, i));
  const adjacency: number[][] = map.rooms.map(() => []);
  for (const door of map.doors) {
    const a = idToIndex.get(door.roomA);
    const b = idToIndex.get(door.roomB);
    if (a === undefined || b === undefined) continue; // malformed door, ignore
    adjacency[a]!.push(b);
    adjacency[b]!.push(a);
  }
  const dist = new Array<number>(map.rooms.length).fill(-1);
  const eyeIndex = idToIndex.get(eyeRoomId);
  if (eyeIndex === undefined) return dist; // malformed eye id — every room unreachable
  dist[eyeIndex] = 0;
  const queue: number[] = [eyeIndex];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head]!;
    for (const next of adjacency[cur]!) {
      if (dist[next] !== -1) continue;
      dist[next] = dist[cur]! + 1;
      queue.push(next);
    }
  }
  return dist;
}

/** The largest finite (reachable) distance in a `computeRoomDistances` result — the
 * initial safe radius (every reachable room is safe at stage 0). */
export function maxFiniteDistance(dist: readonly number[]): number {
  let max = 0;
  for (const d of dist) if (d > max) max = d;
  return max;
}

/** Room ids whose BFS distance is reachable (`!== -1`) and within `maxSafeDist`. */
export function safeRoomIds(map: ArenaMap, dist: readonly number[], maxSafeDist: number): RoomId[] {
  const ids: RoomId[] = [];
  for (let i = 0; i < map.rooms.length; i++) {
    const d = dist[i]!;
    if (d !== -1 && d <= maxSafeDist) ids.push(map.rooms[i]!.id);
  }
  return ids;
}
