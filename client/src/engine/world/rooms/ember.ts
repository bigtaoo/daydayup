/**
 * A first hand-authored RoomPiece library (design/09 "hand-authored pieces",
 * ROADMAP 1.3) — the demo's single biome, tagged 'ember'. Four normal pieces
 * (varied solids/pillars so a floor doesn't feel identical room to room), one
 * extraction-role piece, one boss-role piece (its encounter spawns the existing
 * `blightlord` finale, content/enemies.ts). Grid units, human-authored
 * (design/09); `content/rooms.ts roomGeometry` converts once at placement.
 *
 * Not yet wired into a live run — `world/dungeon.ts generateFloor` selects from
 * this library, but nothing calls it from GameEngine yet (1.4/1.5).
 */
import type { RoomPiece } from '../../content/rooms';

export const EMBER_ROOMS: readonly RoomPiece[] = [
  {
    id: 'ember_hall',
    tags: ['ember'],
    sizeGrid: { w: 20, h: 14 },
    solids: [{ x: 8, y: 0, w: 4, h: 3 }], // a stub wall jutting from the north edge
    spawns: { player: [{ x: 2, y: 7 }], enemy: [{ x: 14, y: 4 }, { x: 14, y: 10 }] },
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
    spawns: { player: [{ x: 8, y: 2 }], enemy: [{ x: 4, y: 12 }, { x: 12, y: 12 }] },
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
