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
import type { AabbGrid, RoomPiece } from '../../content/rooms';
import type { DungeonConfig } from '../dungeon';

// Perimeter walls (design/10 legibility fix, 2026-08-02; door gaps moved to generic
// placement-time carving, design/05 "Room & door model" 2026-08-04): every piece used
// to be a bare open rectangle of floor — no boundary at all — which read as unfinished.
// `perimeterWalls` adds a 1-grid-unit-thick border on all 4 edges. It used to also carve
// a CENTERED gap on whichever edge the piece listed in `exits` — that centering directly
// contradicted the locked "door position is never wall-centered" requirement once real,
// freely-positioned doors existed, so gap-carving moved entirely to `world/dungeon.ts`
// `carveDoorGaps` (placement-time, given the actual placed+drawn door anchor — this
// function no longer knows where, or even whether, a door will end up on any edge).
// Every edge is now always a single unbroken wall segment; `exits` still names which
// edges a piece is willing to connect through (read by `placeFloor`), just no longer
// drives this function's own geometry.
function perimeterWalls(w: number, h: number): AabbGrid[] {
  return [
    { x: 0, y: 0, w, h: 1 }, // north
    { x: 0, y: h - 1, w, h: 1 }, // south
    { x: 0, y: 1, w: 1, h: h - 2 }, // west
    { x: w - 1, y: 1, w: 1, h: h - 2 }, // east
  ];
}

export const EMBER_ROOMS: readonly RoomPiece[] = [
  {
    id: 'ember_hall',
    tags: ['ember'],
    sizeGrid: { w: 20, h: 14 },
    // A stub wall jutting from the north edge (interior flavor), plus the perimeter.
    solids: [{ x: 8, y: 0, w: 4, h: 3 }, ...perimeterWalls(20, 14)],
    spawns: { player: [{ x: 2, y: 7 }], enemy: [{ x: 14, y: 4, type: 'floater' }, { x: 14, y: 10 }] },
    exits: [{ edge: 'west' }, { edge: 'east' }],
  },
  {
    id: 'ember_pillars',
    tags: ['ember'],
    sizeGrid: { w: 18, h: 18 },
    solids: perimeterWalls(18, 18),
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
      ...perimeterWalls(16, 16),
    ],
    spawns: { player: [{ x: 8, y: 2 }], enemy: [{ x: 4, y: 12, type: 'brute' }, { x: 12, y: 12 }] },
    exits: [{ edge: 'north' }, { edge: 'south' }, { edge: 'east' }, { edge: 'west' }],
  },
  {
    id: 'ember_narrow',
    tags: ['ember'],
    sizeGrid: { w: 24, h: 8 },
    solids: perimeterWalls(24, 8),
    pillars: [{ center: { x: 12, y: 4 }, radius: 1.5 }],
    spawns: { player: [{ x: 2, y: 4 }], enemy: [{ x: 20, y: 4, type: 'ironclad' }] },
    exits: [{ edge: 'west' }, { edge: 'east' }],
  },
  {
    id: 'ember_extraction',
    role: 'extraction',
    sizeGrid: { w: 12, h: 10 },
    solids: perimeterWalls(12, 10),
    spawns: { player: [{ x: 6, y: 8 }], enemy: [] },
    exits: [{ edge: 'west' }],
  },
  {
    id: 'ember_boss',
    role: 'boss',
    sizeGrid: { w: 22, h: 18 },
    solids: perimeterWalls(22, 18),
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
