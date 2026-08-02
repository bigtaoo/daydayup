/**
 * A first hand-authored RoomPiece library (design/09 "hand-authored pieces",
 * ROADMAP 1.3) — the demo's single biome, tagged 'ember'. Four normal pieces
 * (varied solids/pillars so a floor doesn't feel identical room to room), one
 * extraction-role piece, one boss-role piece (its encounter spawns the existing
 * `blightlord` finale, content/enemies.ts). Grid units, human-authored
 * (design/09); `content/rooms.ts roomGeometry` converts once at placement.
 *
 * Wired live (ROADMAP 1.3): pair EMBER_ROOMS with EMBER_DUNGEON (below) as
 * `EngineConfig.dungeon` and SpawnSystem generates + traverses floors from them.
 */
import type { AabbGrid, RoomEdge, RoomPiece } from '../../content/rooms';
import type { DungeonConfig } from '../dungeon';

// Perimeter walls (design/10 legibility fix, 2026-08-02): every piece used to be a bare
// open rectangle of floor — no boundary at all, just whatever interior stubs/pillars it
// authored — which read as unfinished (and let the room's ground fill bleed straight
// into the render layer's backdrop with nothing framing it). `perimeterWalls` adds a
// 1-grid-unit-thick border on all 4 edges, with a 4-unit door gap centered on any edge
// the piece already lists in its own `exits` (confirmed repo-wide: `exits` is otherwise
// unread by the sim — room-to-room movement is an automatic teleport to the next room's
// spawn, never "walk through a door" — so this is a purely visual, gameplay-safe
// addition; it does still change existing collision geometry, so it's a replay-breaking
// content change like the rest of this session's fixes). An edge absent from `exits`
// gets one unbroken wall segment instead of a gap.
function perimeterWalls(w: number, h: number, exits: ReadonlyArray<RoomEdge>): AabbGrid[] {
  const has = (edge: RoomEdge) => exits.includes(edge);
  const DOOR = 4;
  const out: AabbGrid[] = [];

  if (has('north')) {
    const gapStart = (w - DOOR) / 2;
    out.push({ x: 0, y: 0, w: gapStart, h: 1 }, { x: gapStart + DOOR, y: 0, w: w - gapStart - DOOR, h: 1 });
  } else {
    out.push({ x: 0, y: 0, w, h: 1 });
  }

  if (has('south')) {
    const gapStart = (w - DOOR) / 2;
    out.push({ x: 0, y: h - 1, w: gapStart, h: 1 }, { x: gapStart + DOOR, y: h - 1, w: w - gapStart - DOOR, h: 1 });
  } else {
    out.push({ x: 0, y: h - 1, w, h: 1 });
  }

  if (has('west')) {
    const gapStart = 1 + (h - 2 - DOOR) / 2;
    out.push({ x: 0, y: 1, w: 1, h: gapStart - 1 }, { x: 0, y: gapStart + DOOR, w: 1, h: h - 1 - (gapStart + DOOR) });
  } else {
    out.push({ x: 0, y: 1, w: 1, h: h - 2 });
  }

  if (has('east')) {
    const gapStart = 1 + (h - 2 - DOOR) / 2;
    out.push({ x: w - 1, y: 1, w: 1, h: gapStart - 1 }, { x: w - 1, y: gapStart + DOOR, w: 1, h: h - 1 - (gapStart + DOOR) });
  } else {
    out.push({ x: w - 1, y: 1, w: 1, h: h - 2 });
  }

  return out;
}

export const EMBER_ROOMS: readonly RoomPiece[] = [
  {
    id: 'ember_hall',
    tags: ['ember'],
    sizeGrid: { w: 20, h: 14 },
    // A stub wall jutting from the north edge (interior flavor), plus the perimeter.
    solids: [{ x: 8, y: 0, w: 4, h: 3 }, ...perimeterWalls(20, 14, ['west', 'east'])],
    spawns: { player: [{ x: 2, y: 7 }], enemy: [{ x: 14, y: 4, type: 'floater' }, { x: 14, y: 10 }] },
    exits: [{ edge: 'west' }, { edge: 'east' }],
  },
  {
    id: 'ember_pillars',
    tags: ['ember'],
    sizeGrid: { w: 18, h: 18 },
    solids: perimeterWalls(18, 18, ['west', 'east']),
    pillars: [
      { center: { x: 6, y: 6 }, radius: 1 },
      { center: { x: 12, y: 12 }, radius: 1 },
    ],
    spawns: { player: [{ x: 2, y: 9 }], enemy: [{ x: 9, y: 3, type: 'emberling' }, { x: 9, y: 15 }] },
    exits: [{ edge: 'west' }, { edge: 'east' }],
  },
  {
    id: 'ember_cross',
    tags: ['ember'],
    sizeGrid: { w: 16, h: 16 },
    solids: [
      { x: 0, y: 7, w: 5, h: 2 },
      { x: 11, y: 7, w: 5, h: 2 },
      ...perimeterWalls(16, 16, ['north', 'south', 'east', 'west']),
    ],
    spawns: { player: [{ x: 8, y: 2 }], enemy: [{ x: 4, y: 12, type: 'brute' }, { x: 12, y: 12 }] },
    exits: [{ edge: 'north' }, { edge: 'south' }, { edge: 'east' }, { edge: 'west' }],
  },
  {
    id: 'ember_narrow',
    tags: ['ember'],
    sizeGrid: { w: 24, h: 8 },
    solids: perimeterWalls(24, 8, ['west', 'east']),
    pillars: [{ center: { x: 12, y: 4 }, radius: 1.5 }],
    spawns: { player: [{ x: 2, y: 4 }], enemy: [{ x: 20, y: 4, type: 'ironclad' }] },
    exits: [{ edge: 'west' }, { edge: 'east' }],
  },
  {
    id: 'ember_extraction',
    role: 'extraction',
    sizeGrid: { w: 12, h: 10 },
    solids: perimeterWalls(12, 10, ['west']),
    spawns: { player: [{ x: 6, y: 8 }], enemy: [] },
    exits: [{ edge: 'west' }],
  },
  {
    id: 'ember_boss',
    role: 'boss',
    sizeGrid: { w: 22, h: 18 },
    solids: perimeterWalls(22, 18, ['west']),
    spawns: { player: [{ x: 11, y: 16 }], enemy: [{ x: 11, y: 4, type: 'blightlord' }] },
    exits: [{ edge: 'west' }],
    encounter: { entries: [{ atTick: 0, enemyType: 'blightlord', spawnPoint: 0, count: 1, isBoss: true }] },
  },
];

/**
 * The Ember biome's dungeon descriptor (design/05/09, ROADMAP 1.3) — pair with
 * EMBER_ROOMS as `EngineConfig.dungeon`. Three floors of 2–3 rooms drawn from the
 * 'ember'-tagged pool, each capped by `ember_extraction` (the checkpoint) except the
 * deepest, capped by `ember_boss` (the blightlord finale, which doubles as its own
 * extraction). The difficulty curve is the first-pass linear ramp (world/dungeon.ts
 * curveAt) — final tuning is design/05's open work.
 */
export const EMBER_DUNGEON: DungeonConfig = {
  biomeId: 'ember',
  nameKey: 'biome.ember',
  floorCount: 3,
  roomsPerFloor: { min: 2, max: 3 },
  pieceTags: ['ember'],
  layout: 'linear',
  extractionPieceId: 'ember_extraction',
  bossPieceId: 'ember_boss',
  difficultyCurve: { base: 1, perFloor: 1 },
};
