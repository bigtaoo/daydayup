/**
 * Static, pure measurements over an `ArenaMap` (design/15) — the vocabulary an arena
 * audit reports in, and the vocabulary a future quality GATE will be stated against.
 *
 * Why this exists: `tools/map-editor`'s `validate.ts` answers "is this map STRUCTURALLY
 * loadable" (ids non-empty, rects on whole cells, no overlapping rooms), and the map that used
 * to ship — `arena_prototype_60.json`, retired 2026-08-26 — passed it while being 60 identical
 * 10x10 rooms on a regular lattice, every one with `solids: []`, one dead-centre pillar and one
 * `arena_common` loot marker. Structural validity and design quality are different claims, and
 * nothing in the repo measured the second one. These functions do.
 *
 * Everything here is a pure function of the map: no engine state, no RNG, no clock — so a
 * report is reproducible and an assertion over it is stable. Read by `sim/arenaAudit.sim.ts`
 * (the report) and by this module's own tests.
 */
import type { ArenaMap, ArenaRoom, RoomId } from './arenas';

/** How many DISTINCT variants a repeated feature has across the map, next to how many
 *  rooms carry it. `distinct === 1` over 60 rooms is the fingerprint of a generated
 *  placeholder: the same thing stamped everywhere, which no hand-authored map produces. */
export interface Variety {
  /** Rooms that have at least one of this feature. */
  rooms: number;
  /** Distinct variants, comparing each room's feature set canonically (see `canonical`). */
  distinct: number;
  /** The most-repeated variant's share of `rooms`, 0..1 — 1 means every room is identical. */
  dominantShare: number;
}

export interface ArenaGraphMetrics {
  /** door-degree → how many rooms have it. A map where almost every room is degree 2 is a
   *  lattice or a corridor, not a layout with decisions in it. */
  degreeHistogram: Record<number, number>;
  /** Rooms with exactly one door — a pocket you can be run down in. */
  deadEnds: RoomId[];
  /** Rooms with no door at all. Always a bug: unreachable content, and the zone's BFS
   *  treats them as infinitely far from the eye. */
  isolated: RoomId[];
  /** Rooms whose removal would split the map into disconnected parts (Tarjan). These are
   *  the chokepoints — a battle-royale layout wants some, and wants to know where they are. */
  chokepoints: RoomId[];
  /** True when every room is reachable from `rooms[0]` through doors. */
  connected: boolean;
  /** Longest shortest-path in door hops between any two rooms (Infinity if disconnected). */
  diameter: number;
}

export interface ArenaSpawnMetrics {
  count: number;
  /** Spawn index → the room containing it, or null when it lands outside every room rect
   *  (a real defect: the seat starts in geometry no room owns). */
  rooms: (RoomId | null)[];
  /** Spawns that landed outside every room. */
  orphans: number;
  /** Spawn indices that share a room with another spawn — two seats starting on top of
   *  each other is a fairness defect, not a layout choice. */
  colliding: number;
  /** Smallest door-hop distance between any two spawns (Infinity when fewer than 2 are
   *  placed in rooms, or when two spawns cannot reach each other at all). */
  minPairHops: number;
  /** Largest such distance — with `minPairHops`, the spread of how fair the drop is. */
  maxPairHops: number;
}

export interface ArenaCoverMetrics {
  /** Rooms whose `solids` and `pillars` are both empty — nothing at all to break line of
   *  sight or stop a bullet. In a shooter this is the single most load-bearing number. */
  roomsWithNoCover: RoomId[];
  /** Rooms with no `solids` (pillars alone). A pillar is a dot; a wall run is a shape. */
  roomsWithNoWalls: RoomId[];
  /** Per-room cover area as a fraction of the room's own footprint, ascending. */
  coverFractions: number[];
  /** Total wall-run rects and pillars across the map. */
  totalSolids: number;
  totalPillars: number;
}

export interface ArenaMetrics {
  id: string;
  roomCount: number;
  doorCount: number;
  sizeGrid: { w: number; h: number };
  /** Distinct room footprints (w x h). 1 means every room is the same box. */
  footprints: Variety;
  /** Distinct interior layouts (`solids` + `pillars`) as the engine reads them. */
  interiors: Variety;
  /** The same, translated to each room's own bounding box — "how many distinct SHAPES".
   *  Fewer shapes than interiors means the same arrangement was authored at many different
   *  offsets, which for a lattice of same-size rooms means the coordinates are absolute
   *  where the engine expects room-relative. See `interiorShapeKey`. */
  interiorShapes: Variety;
  lootLayouts: Variety;
  encounters: Variety;
  traits: Variety;
  /** Every distinct `LootMarker.tableId` in the map → how many markers name it. */
  lootTables: Record<string, number>;
  /** Every distinct `CellTrait.kind` → how many traits have it. */
  traitKinds: Record<string, number>;
  cover: ArenaCoverMetrics;
  graph: ArenaGraphMetrics;
  spawns: ArenaSpawnMetrics;
  /** Eye-candidate rooms with a non-zero weight — the rooms a match can actually end in. */
  eyeCandidates: number;
  /** Largest door-hop distance from any room to the NEAREST eye candidate: the longest
   *  run the shrink can ever force on a player. Infinity if some room can reach none. */
  maxHopsToEye: number;
}

/** Canonical string for a feature set, so "the same thing, stamped again" compares equal.
 *  Sorted, so authoring order never registers as variety. */
function canonical(parts: readonly string[]): string {
  return [...parts].sort().join('|');
}

function varietyOf(keys: readonly (string | null)[]): Variety {
  const present = keys.filter((k): k is string => k !== null);
  const counts = new Map<string, number>();
  for (const k of present) counts.set(k, (counts.get(k) ?? 0) + 1);
  const dominant = Math.max(0, ...counts.values());
  return {
    rooms: present.length,
    distinct: counts.size,
    dominantShare: present.length === 0 ? 0 : dominant / present.length,
  };
}

/**
 * A room's interior AS THE ENGINE READS IT. Every one of these lists is room-relative by
 * the engine's own convention (`buildArenaRoomRects`' doc comment: only `rectGrid` is
 * absolute), so the authored numbers are used verbatim — subtracting the room offset here
 * would make two identically-furnished rooms at different offsets compare UNEQUAL, and it
 * is what the first version of this module did.
 *
 * That matters beyond correctness: a map that authored these as if they were ABSOLUTE is
 * internally consistent and looks uniform to the eye, but every room's numbers differ, so
 * this key reports 60 distinct interiors for what is visibly one repeated room. Pair it
 * with `interiorShapeKey` below — "many distinct interiors, ONE distinct shape" is exactly
 * that defect's signature, and `arenaGeometryMetrics.measurePlacement` confirms it.
 */
function interiorKey(room: ArenaRoom): string | null {
  const parts = featureParts(room);
  return parts.length === 0 ? null : canonical(parts);
}

function featureParts(room: ArenaRoom): string[] {
  return [
    ...room.solids.map((s) => `s${s.x},${s.y},${s.w},${s.h}`),
    ...(room.pillars ?? []).map((p) => `p${p.center.x},${p.center.y},${p.radius}`),
  ];
}

/** The same interior, translated so its own bounding box starts at the origin — so "the
 *  same furniture arrangement, sitting somewhere else" counts as one shape whatever
 *  coordinate convention the map was authored in. */
function interiorShapeKey(room: ArenaRoom): string | null {
  const solids = room.solids;
  const pillars = room.pillars ?? [];
  if (solids.length === 0 && pillars.length === 0) return null;
  const xs = [...solids.map((s) => s.x), ...pillars.map((p) => p.center.x)];
  const ys = [...solids.map((s) => s.y), ...pillars.map((p) => p.center.y)];
  const ox = Math.min(...xs);
  const oy = Math.min(...ys);
  return canonical([
    ...solids.map((s) => `s${s.x - ox},${s.y - oy},${s.w},${s.h}`),
    ...pillars.map((p) => `p${p.center.x - ox},${p.center.y - oy},${p.radius}`),
  ]);
}

function lootKey(room: ArenaRoom): string | null {
  const markers = room.lootMarkers ?? [];
  if (markers.length === 0) return null;
  return canonical(markers.map((m) => `${m.point.x},${m.point.y}:${m.tableId}`));
}

function encounterKey(room: ArenaRoom): string | null {
  const entries = room.encounter?.entries ?? [];
  if (entries.length === 0) return null;
  return canonical(entries.map((e) => `${e.atTick},${e.enemyType},${e.spawnPoint},${e.count ?? 1}`));
}

function traitKey(room: ArenaRoom): string | null {
  const traits = room.cellTraits ?? [];
  if (traits.length === 0) return null;
  return canonical(
    traits.map(
      (t) =>
        `${t.kind}@${t.rectGrid.x},${t.rectGrid.y},` +
        `${t.rectGrid.w}x${t.rectGrid.h}:${t.timed ? 'timed' : 'always'}:${t.damage ?? 0}`,
    ),
  );
}

/** Room-id → index, built once per report. */
function indexById(map: ArenaMap): Map<RoomId, number> {
  return new Map(map.rooms.map((r, i) => [r.id, i]));
}

/** Undirected door adjacency as index lists. Doors naming an unknown room are skipped —
 *  `validate.ts` already rejects those, and a metrics pass should not throw on bad input. */
function adjacency(map: ArenaMap, byId: Map<RoomId, number>): number[][] {
  const adj: number[][] = map.rooms.map(() => []);
  for (const door of map.doors) {
    const a = byId.get(door.roomA);
    const b = byId.get(door.roomB);
    if (a === undefined || b === undefined || a === b) continue;
    adj[a]!.push(b);
    adj[b]!.push(a);
  }
  return adj;
}

/** Door hops from `from` to every room; Infinity where unreachable. */
function bfs(adj: readonly number[][], from: number): number[] {
  const dist = adj.map(() => Infinity);
  dist[from] = 0;
  const queue = [from];
  for (let head = 0; head < queue.length; head++) {
    const at = queue[head]!;
    for (const next of adj[at]!) {
      if (dist[next] !== Infinity) continue;
      dist[next] = dist[at]! + 1;
      queue.push(next);
    }
  }
  return dist;
}

/**
 * Articulation points (Tarjan), iteratively — a 60-room map is small, but recursion depth
 * is a function of CONTENT and this module must not be the thing that breaks on a bigger
 * map later. A room is a chokepoint when removing it disconnects some pair of rooms.
 */
function articulationPoints(adj: readonly number[][]): number[] {
  const n = adj.length;
  const disc = new Array<number>(n).fill(-1);
  const low = new Array<number>(n).fill(0);
  const parent = new Array<number>(n).fill(-1);
  const isCut = new Array<boolean>(n).fill(false);
  let timer = 0;

  for (let root = 0; root < n; root++) {
    if (disc[root] !== -1) continue;
    let rootChildren = 0;
    // Each frame is [vertex, index of the next neighbour to visit].
    const stack: [number, number][] = [[root, 0]];
    disc[root] = low[root] = timer++;
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const [at, cursor] = frame;
      if (cursor < adj[at]!.length) {
        frame[1]++;
        const next = adj[at]![cursor]!;
        if (next === parent[at]) continue;
        if (disc[next] !== -1) {
          low[at] = Math.min(low[at]!, disc[next]!);
          continue;
        }
        parent[next] = at;
        disc[next] = low[next] = timer++;
        if (at === root) rootChildren++;
        stack.push([next, 0]);
        continue;
      }
      stack.pop();
      const up = parent[at];
      if (up === -1) continue;
      low[up] = Math.min(low[up]!, low[at]!);
      // The classic non-root rule; the root is decided by its child count instead.
      if (low[at]! >= disc[up]! && up !== root) isCut[up] = true;
    }
    if (rootChildren > 1) isCut[root] = true;
  }
  return isCut.flatMap((cut, i) => (cut ? [i] : []));
}

function graphMetrics(map: ArenaMap, adj: readonly number[][]): ArenaGraphMetrics {
  const degreeHistogram: Record<number, number> = {};
  const deadEnds: RoomId[] = [];
  const isolated: RoomId[] = [];
  map.rooms.forEach((room, i) => {
    const degree = adj[i]!.length;
    degreeHistogram[degree] = (degreeHistogram[degree] ?? 0) + 1;
    if (degree === 1) deadEnds.push(room.id);
    if (degree === 0) isolated.push(room.id);
  });

  let diameter = 0;
  let connected = true;
  for (let i = 0; i < map.rooms.length; i++) {
    for (const d of bfs(adj, i)) {
      if (d === Infinity) connected = false;
      else diameter = Math.max(diameter, d);
    }
  }

  return {
    degreeHistogram,
    deadEnds,
    isolated,
    chokepoints: articulationPoints(adj).map((i) => map.rooms[i]!.id),
    connected,
    diameter: connected ? diameter : Infinity,
  };
}

/** Which room's `rectGrid` contains a point, or null. Same point-in-rect membership test
 *  design/15 locks for actors — half-open on the far edge, so a point on the shared border
 *  of two rooms belongs to exactly one of them. */
function roomAt(map: ArenaMap, x: number, y: number): RoomId | null {
  for (const room of map.rooms) {
    const r = room.rectGrid;
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return room.id;
  }
  return null;
}

function spawnMetrics(map: ArenaMap, adj: readonly number[][], byId: Map<RoomId, number>): ArenaSpawnMetrics {
  const rooms = map.spawns.map((p) => roomAt(map, p.x, p.y));
  const placed = rooms.filter((r): r is RoomId => r !== null);
  const seen = new Map<RoomId, number>();
  for (const id of placed) seen.set(id, (seen.get(id) ?? 0) + 1);
  const colliding = [...seen.values()].filter((n) => n > 1).reduce((sum, n) => sum + n, 0);

  let minPairHops = Infinity;
  let maxPairHops = 0;
  for (let i = 0; i < placed.length; i++) {
    const dist = bfs(adj, byId.get(placed[i]!)!);
    for (let j = i + 1; j < placed.length; j++) {
      const d = dist[byId.get(placed[j]!)!]!;
      minPairHops = Math.min(minPairHops, d);
      if (d !== Infinity) maxPairHops = Math.max(maxPairHops, d);
    }
  }

  return {
    count: map.spawns.length,
    rooms,
    orphans: rooms.length - placed.length,
    colliding,
    minPairHops,
    maxPairHops,
  };
}

function coverMetrics(map: ArenaMap): ArenaCoverMetrics {
  const roomsWithNoCover: RoomId[] = [];
  const roomsWithNoWalls: RoomId[] = [];
  const coverFractions: number[] = [];
  let totalSolids = 0;
  let totalPillars = 0;

  for (const room of map.rooms) {
    const pillars = room.pillars ?? [];
    totalSolids += room.solids.length;
    totalPillars += pillars.length;
    if (room.solids.length === 0) roomsWithNoWalls.push(room.id);
    if (room.solids.length === 0 && pillars.length === 0) roomsWithNoCover.push(room.id);

    const solidArea = room.solids.reduce((sum, s) => sum + s.w * s.h, 0);
    // A pillar's footprint as an area, not a cell count — radius is in grid units and may
    // be fractional, so a cell-counting version would round the small ones away to zero.
    const pillarArea = pillars.reduce((sum, p) => sum + Math.PI * p.radius * p.radius, 0);
    const footprint = room.rectGrid.w * room.rectGrid.h;
    coverFractions.push(footprint > 0 ? (solidArea + pillarArea) / footprint : 0);
  }

  coverFractions.sort((a, b) => a - b);
  return { roomsWithNoCover, roomsWithNoWalls, coverFractions, totalSolids, totalPillars };
}

function tally<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/** Measure a map. Pure — same map in, same metrics out. */
export function measureArena(map: ArenaMap): ArenaMetrics {
  const byId = indexById(map);
  const adj = adjacency(map, byId);
  const graph = graphMetrics(map, adj);

  const eyeRooms = map.eyeCandidates.filter((c) => (c.weight ?? 1) > 0).map((c) => c.roomId);
  // Distance to the NEAREST eye candidate, maximised over rooms: run one BFS per candidate
  // and keep the per-room minimum, rather than 60 BFS runs from every room.
  const nearestEye = map.rooms.map(() => Infinity);
  for (const id of eyeRooms) {
    const from = byId.get(id);
    if (from === undefined) continue;
    bfs(adj, from).forEach((d, i) => {
      nearestEye[i] = Math.min(nearestEye[i]!, d);
    });
  }

  return {
    id: map.id,
    roomCount: map.rooms.length,
    doorCount: map.doors.length,
    sizeGrid: map.sizeGrid,
    footprints: varietyOf(map.rooms.map((r) => `${r.rectGrid.w}x${r.rectGrid.h}`)),
    interiors: varietyOf(map.rooms.map(interiorKey)),
    interiorShapes: varietyOf(map.rooms.map(interiorShapeKey)),
    lootLayouts: varietyOf(map.rooms.map(lootKey)),
    encounters: varietyOf(map.rooms.map(encounterKey)),
    traits: varietyOf(map.rooms.map(traitKey)),
    lootTables: tally(
      map.rooms.flatMap((r) => r.lootMarkers ?? []),
      (m) => m.tableId,
    ),
    traitKinds: tally(
      map.rooms.flatMap((r) => r.cellTraits ?? []),
      (t) => t.kind,
    ),
    cover: coverMetrics(map),
    graph,
    spawns: spawnMetrics(map, adj, byId),
    eyeCandidates: eyeRooms.length,
    maxHopsToEye: eyeRooms.length === 0 ? Infinity : Math.max(...nearestEye),
  };
}
