/**
 * Where an ArenaMap's authored content actually LANDS — the other half of the arena audit
 * (`arenaMetrics.ts` measures variety; this measures placement and enclosure).
 *
 * Split out of `arenaMetrics.ts` per CLAUDE.md's 500-line convention, form (1): these are
 * independent functions over one shared concern (absolute, post-offset geometry) with no
 * state shared with the variety side.
 *
 * The convention this module enforces is the engine's own, documented at
 * `buildArenaRoomRects`: **only `ArenaRoom.rectGrid` is in absolute map coordinates.**
 * `solids`, `pillars`, `cellTraits`, `spawns` and `lootMarkers` are all ROOM-RELATIVE, and
 * every consumer (`roomGeometry`, `buildArenaCellTraits`, `SpawnSystem.dispatchArenaSpawns`,
 * `SpawnSystem.spawnArenaLoot`) adds the room's own `rectGrid.x/y` before use.
 *
 * Measuring against that convention is the whole point. A map can be internally consistent,
 * pass `validate.ts`, and still author half its features as if they were absolute — the
 * offset is then applied to an already-absolute number and the content lands somewhere
 * nobody intended. That is exactly what `arena_prototype_60` does with its pillars and loot
 * markers, and no variety metric can see it: every room is wrong in the same way, so the
 * map looks perfectly uniform right up until you ask where the cover physically is.
 */
import type { ArenaMap, ArenaRoom, RoomId } from './arenas';

/** A cell-aligned rect in absolute map coordinates. */
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One authored feature that does not land where its room is. */
export interface Misplacement {
  room: RoomId;
  /** Which authored list it came from. */
  feature: 'pillar' | 'loot' | 'trait' | 'enemySpawn' | 'solid';
  /** Absolute position after the engine adds the room's offset. */
  at: { x: number; y: number };
  /** True when it is not merely outside its own room but outside the whole map. */
  offMap: boolean;
}

export interface ArenaPlacementMetrics {
  /** Features landing outside their OWN room's rect once the room offset is applied. */
  outsideOwnRoom: Misplacement[];
  /** The subset that lands outside `sizeGrid` entirely — unreachable, not just misplaced. */
  offMap: Misplacement[];
  /** Per feature kind: how many were authored, and how many of those landed outside. */
  byFeature: Record<Misplacement['feature'], { authored: number; misplaced: number }>;
}

export interface ArenaEnclosureMetrics {
  /** Solid cells anywhere in the map, after offsets. Zero means there are no walls at all
   *  and every `Door` is decorative: `roomGeometry` derives walls ONLY from `solids`, so a
   *  map with none is one open field that actors cross in a straight line, whatever the
   *  room rects and door graph say. */
  solidCells: number;
  /** Rooms with no solid cell anywhere on their rect boundary — an open floor patch. */
  unenclosedRooms: RoomId[];
  /** Fraction of each room's boundary ring covered by a solid cell, ascending. */
  perimeterCoverage: number[];
  /** Doors whose `passageGrid` has no solid cell adjacent to it — a gap in nothing, so it
   *  gates no movement even though the zone's BFS treats it as the only way through. */
  doorsWithoutWalls: number;
  /** Room pairs that are NOT door-connected but that an actor can walk between anyway,
   *  because no solid stands in the corridor where their rects face each other. The zone's
   *  shrink is stated over the door graph (design/15) — every leak here is a route the
   *  safe-set reasoning does not know exists. */
  undoorLeaks: number;
}

function offsetRect(r: Rect, room: ArenaRoom): Rect {
  return { x: r.x + room.rectGrid.x, y: r.y + room.rectGrid.y, w: r.w, h: r.h };
}

function contains(outer: Rect, x: number, y: number): boolean {
  return x >= outer.x && x < outer.x + outer.w && y >= outer.y && y < outer.y + outer.h;
}

/** Every solid cell in the map, keyed `"x,y"`, in absolute coordinates. */
export function solidCellSet(map: ArenaMap): Set<string> {
  const cells = new Set<string>();
  for (const room of map.rooms) {
    for (const s of room.solids) {
      const r = offsetRect(s, room);
      for (let y = r.y; y < r.y + r.h; y++) {
        for (let x = r.x; x < r.x + r.w; x++) cells.add(`${x},${y}`);
      }
    }
  }
  return cells;
}

/**
 * Check every authored feature against its own room, using the engine's offset rule.
 * A pillar's `center` is a point, not a rect — its radius may legitimately overhang the
 * room edge, so only the CENTRE is required to be inside. Anything else would flag a
 * deliberately wall-hugging pillar as a defect.
 */
export function measurePlacement(map: ArenaMap): ArenaPlacementMetrics {
  const outsideOwnRoom: Misplacement[] = [];
  const byFeature: ArenaPlacementMetrics['byFeature'] = {
    pillar: { authored: 0, misplaced: 0 },
    loot: { authored: 0, misplaced: 0 },
    trait: { authored: 0, misplaced: 0 },
    enemySpawn: { authored: 0, misplaced: 0 },
    solid: { authored: 0, misplaced: 0 },
  };
  const mapRect: Rect = { x: 0, y: 0, w: map.sizeGrid.w, h: map.sizeGrid.h };

  const check = (room: ArenaRoom, feature: Misplacement['feature'], x: number, y: number) => {
    byFeature[feature].authored++;
    const at = { x: x + room.rectGrid.x, y: y + room.rectGrid.y };
    if (contains(room.rectGrid, at.x, at.y)) return;
    byFeature[feature].misplaced++;
    outsideOwnRoom.push({
      room: room.id,
      feature,
      at,
      offMap: !contains(mapRect, at.x, at.y),
    });
  };

  for (const room of map.rooms) {
    for (const p of room.pillars ?? []) check(room, 'pillar', p.center.x, p.center.y);
    for (const m of room.lootMarkers ?? []) check(room, 'loot', m.point.x, m.point.y);
    for (const t of room.cellTraits ?? []) check(room, 'trait', t.rectGrid.x, t.rectGrid.y);
    for (const s of room.spawns ?? []) check(room, 'enemySpawn', s.x, s.y);
    // A solid may legitimately sit ON the room's edge and is a rect, so its top-left corner
    // is the anchor tested — the same "where was this authored to be" question as the rest.
    for (const s of room.solids) check(room, 'solid', s.x, s.y);
  }

  return { outsideOwnRoom, offMap: outsideOwnRoom.filter((m) => m.offMap), byFeature };
}

/** The cells forming a rect's boundary ring. */
function boundaryCells(r: Rect): string[] {
  const out: string[] = [];
  for (let x = r.x; x < r.x + r.w; x++) {
    out.push(`${x},${r.y}`, `${x},${r.y + r.h - 1}`);
  }
  for (let y = r.y + 1; y < r.y + r.h - 1; y++) {
    out.push(`${r.x},${y}`, `${r.x + r.w - 1},${y}`);
  }
  return out;
}

/** Cells in the one-cell ring just outside a rect. */
function surroundingCells(r: Rect): string[] {
  const out: string[] = [];
  for (let x = r.x - 1; x <= r.x + r.w; x++) out.push(`${x},${r.y - 1}`, `${x},${r.y + r.h}`);
  for (let y = r.y; y < r.y + r.h; y++) out.push(`${r.x - 1},${y}`, `${r.x + r.w},${y}`);
  return out;
}

/** Does `other` stand in the corridor between two rooms facing each other along an axis?
 *  Used to keep a leak meaning "these two rooms are IMMEDIATE neighbours with nothing
 *  between them", rather than also counting every distant pair that happens to line up
 *  across an empty map. Threshold-free: occlusion by a third room, not a distance guess. */
function occludes(other: Rect, band: Rect): boolean {
  return (
    other.x < band.x + band.w && other.x + other.w > band.x &&
    other.y < band.y + band.h && other.y + other.h > band.y
  );
}

/**
 * Can an actor walk between two rooms without passing a door? Only the corridor where the
 * two rects FACE each other is considered — two rooms sharing only a diagonal corner are not
 * a walkable route, and a pair with another room standing between them is not a neighbour.
 * A leak exists when that corridor contains no solid cell on either facing edge or between.
 */
function leaksBetween(a: Rect, b: Rect, others: readonly Rect[], solids: ReadonlySet<string>): boolean {
  const xLo = Math.max(a.x, b.x);
  const xHi = Math.min(a.x + a.w, b.x + b.w);
  const yLo = Math.max(a.y, b.y);
  const yHi = Math.min(a.y + a.h, b.y + b.h);
  const xOverlap = xLo < xHi;
  const yOverlap = yLo < yHi;
  if (xOverlap === yOverlap) return false; // diagonal (neither) or overlapping rects (both)

  if (xOverlap) {
    const [top, bottom] = a.y < b.y ? [a, b] : [b, a];
    const gapFrom = top.y + top.h;
    if (bottom.y < gapFrom) return false;
    const band: Rect = { x: xLo, y: gapFrom, w: xHi - xLo, h: Math.max(bottom.y - gapFrom, 1) };
    if (others.some((o) => occludes(o, band))) return false;
    for (let x = xLo; x < xHi; x++) {
      let blocked = false;
      // Include both facing edges: a wall ON either room's boundary closes the corridor.
      for (let y = gapFrom - 1; y <= bottom.y; y++) if (solids.has(`${x},${y}`)) blocked = true;
      if (!blocked) return true;
    }
    return false;
  }

  const [left, right] = a.x < b.x ? [a, b] : [b, a];
  const gapFrom = left.x + left.w;
  if (right.x < gapFrom) return false;
  const band: Rect = { x: gapFrom, y: yLo, w: Math.max(right.x - gapFrom, 1), h: yHi - yLo };
  if (others.some((o) => occludes(o, band))) return false;
  for (let y = yLo; y < yHi; y++) {
    let blocked = false;
    for (let x = gapFrom - 1; x <= right.x; x++) if (solids.has(`${x},${y}`)) blocked = true;
    if (!blocked) return true;
  }
  return false;
}

export function measureEnclosure(map: ArenaMap): ArenaEnclosureMetrics {
  const solids = solidCellSet(map);
  const unenclosedRooms: RoomId[] = [];
  const perimeterCoverage: number[] = [];

  for (const room of map.rooms) {
    const ring = boundaryCells(room.rectGrid);
    const covered = ring.filter((c) => solids.has(c)).length;
    if (covered === 0) unenclosedRooms.push(room.id);
    perimeterCoverage.push(ring.length === 0 ? 0 : covered / ring.length);
  }
  perimeterCoverage.sort((a, b) => a - b);

  const doorsWithoutWalls = map.doors.filter(
    (d) => !surroundingCells(d.passageGrid).some((c) => solids.has(c)),
  ).length;

  const doored = new Set(map.doors.map((d) => [d.roomA, d.roomB].sort().join(' ')));
  let undoorLeaks = 0;
  for (let i = 0; i < map.rooms.length; i++) {
    for (let j = i + 1; j < map.rooms.length; j++) {
      const a = map.rooms[i]!;
      const b = map.rooms[j]!;
      if (doored.has([a.id, b.id].sort().join(' '))) continue;
      const others = map.rooms.filter((_, k) => k !== i && k !== j).map((r) => r.rectGrid);
      if (leaksBetween(a.rectGrid, b.rectGrid, others, solids)) undoorLeaks++;
    }
  }

  return {
    solidCells: solids.size,
    unenclosedRooms,
    perimeterCoverage,
    doorsWithoutWalls,
    undoorLeaks,
  };
}
