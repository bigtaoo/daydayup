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
import type { RoomPiece } from '../../content/rooms';
import type { DungeonConfig } from '../dungeon';

export const EMBER_ROOMS: readonly RoomPiece[] = [
  {
    id: 'ember_hall',
    tags: ['ember'],
    sizeGrid: { w: 20, h: 14 },
    solids: [{ x: 8, y: 0, w: 4, h: 3 }], // a stub wall jutting from the north edge
    spawns: { player: [{ x: 2, y: 7 }], enemy: [{ x: 14, y: 4, type: 'floater' }, { x: 14, y: 10 }] },
    exits: [{ edge: 'west' }, { edge: 'east' }],
  },
  {
    id: 'ember_pillars',
    tags: ['ember'],
    sizeGrid: { w: 18, h: 18 },
    solids: [],
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
    ],
    spawns: { player: [{ x: 8, y: 2 }], enemy: [{ x: 4, y: 12, type: 'brute' }, { x: 12, y: 12 }] },
    exits: [{ edge: 'north' }, { edge: 'south' }, { edge: 'east' }, { edge: 'west' }],
  },
  {
    id: 'ember_narrow',
    tags: ['ember'],
    sizeGrid: { w: 24, h: 8 },
    solids: [],
    pillars: [{ center: { x: 12, y: 4 }, radius: 1.5 }],
    spawns: { player: [{ x: 2, y: 4 }], enemy: [{ x: 20, y: 4, type: 'ironclad' }] },
    exits: [{ edge: 'west' }, { edge: 'east' }],
  },
  {
    id: 'ember_extraction',
    role: 'extraction',
    sizeGrid: { w: 12, h: 10 },
    solids: [],
    spawns: { player: [{ x: 6, y: 8 }], enemy: [] },
    exits: [{ edge: 'west' }],
  },
  {
    id: 'ember_boss',
    role: 'boss',
    sizeGrid: { w: 22, h: 18 },
    solids: [],
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
