/**
 * A first hand-authored RoomPiece library (design/09 "hand-authored pieces",
 * ROADMAP 1.3) — the demo's single biome, tagged 'ember'. Five normal pieces
 * (varied solids/pillars so a floor doesn't feel identical room to room), one
 * extraction-role piece, one boss-role piece (its encounter spawns the existing
 * `blightlord` finale, content/enemies.ts). Grid units, human-authored
 * (design/09); `content/rooms.ts roomGeometry` converts once at placement.
 *
 * Wired live (ROADMAP 1.3): pair EMBER_ROOMS with EMBER_DUNGEON (below) as
 * `EngineConfig.dungeon` and SpawnSystem generates + traverses floors from them.
 *
 * `'graph2d'` content (design/05, 2026-08-05 follow-up): `EMBER_DUNGEON.layout`
 * switched from `'linear'` to `'graph2d'` this pass, so a generated Ember floor
 * can genuinely bend north/south instead of only ever walking a west→east
 * spine. `ember_cross` already authored all 4 exits (it just had no
 * exit-matching partner before); `ember_pillars` gained `north`+`south` on top
 * of its existing `west`+`east` (its two pillars sit well clear of the N/S
 * walls, same clearance margin `pickDoorAnchor2d` already enforces generically),
 * and the new `ember_atrium` is a fully open room (no interior solids at all)
 * with all 4 exits, purpose-built as a flexible mid-floor connector. Deliberately
 * a DIFFERENT width (14) from every existing piece (20/18/16/24) — `'branching'`
 * still stays unused by any shipped config (only same-width normal pieces are
 * fork-eligible, design/05's "fully-realized branching" pass), and this pass
 * doesn't touch that; picking a colliding width here would be an accidental,
 * undocumented opt-in to forking the instant someone flips `layout` to
 * `'branching'` later. A west/east-only piece (`ember_hall`/`ember_narrow`)
 * still never bends mid-floor on its own — bending only happens when BOTH
 * sides of a transition offer a matching exit — but a floor that draws two of
 * {cross, pillars, atrium} back-to-back now has a real, PRNG-drawn choice of
 * direction, and the pool's first (spawn) room already had this "walk either
 * of two ways" freedom whenever it draws any west+east piece (module doc in
 * `world/dungeon.ts`).
 *
 * `ember_extraction`/`ember_boss` gained all 4 exits (previously `west`-only) —
 * found NOT by inspection but by two rounds of brute-force testing this pass
 * added (`dungeon.test.ts`'s EMBER_DUNGEON seed-sweep, then an exhaustive
 * enumeration over every `(normal1, normal2, capstone)` combo the real pool can
 * produce), each surfacing a distinct way the ORIGINAL `west`-only capstone
 * could dead-end or fold back:
 * 1. **Dead end (connectivity):** the spawn stage (undefined `entryEdge`)
 *    always offers BOTH `west` and `east` as viable first moves (every normal
 *    piece authors both), so a 2-normal-stage floor can legitimately draw
 *    `'west'` for its first hop — placing stage 1 WEST of the spawn, entered
 *    via stage 1's own `east` side, consuming it. Stage 1's only remaining exit
 *    is then `west`, but a `west`-only capstone has no `east` to receive it —
 *    zero viable directions, `placeFloorGraph2d` fails loud (module doc: "no
 *    solver", the content author is responsible for a compatible sequence).
 *    Fix: give the capstone `east` too — whichever single edge a room was
 *    entered through, the OTHER of {west, east} is always still open on it, so
 *    the capstone is now reachable from either side.
 * 2. **Fold-back (overlap), found only once (1) was fixed and the seed-sweep
 *    could reach a THIRD stage:** `ember_boss` (22×18, the pool's tallest+widest
 *    piece) connecting via `west` OR `east` centers itself on the PREVIOUS
 *    room's own centerline (`placeAdjacent2d`) — if that previous room is
 *    shorter than `ember_boss` (true of every other piece), the overhang can
 *    reach past it into whatever sits on the OTHER side, regardless of which
 *    of the two horizontal directions is tried. Fix: give the capstone `north`+
 *    `south` too, so when the floor already bent vertically to reach it,
 *    `placeFloorGraph2d`'s direction-retry (its own doc comment,
 *    `world/dungeon.ts`) has a THIRD option — continuing the SAME bend outward,
 *    away from every earlier room, instead of only ever doubling back
 *    horizontally across one. Adding exits to a capstone is provably
 *    never unsafe on its own (`placeFloorGraph2d`'s retry tries every viable
 *    direction before giving up, so a larger viable set can only ever add a
 *    successful option, never remove one) — the exhaustive enumeration test
 *    below is what turns "provably can't make things worse" into "confirmed
 *    zero failures over the actual finite pool", since a hand-argued proof
 *    that some Nth combination is fine is exactly the kind of claim worth
 *    machine-checking once. The capstone still only ever gets ONE door in
 *    practice (it is always the last stage — nothing places beyond it), so
 *    every added exit is a fallback connectivity/safety option, never a
 *    second door.
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
    // North/south added (design/05 'graph2d' content pass, 2026-08-05) — both
    // pillars sit at y=6/y=12, well clear of the y=0/y=17 walls a N/S door cuts.
    exits: [{ edge: 'west' }, { edge: 'east' }, { edge: 'north' }, { edge: 'south' }],
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
    id: 'ember_atrium',
    tags: ['ember'],
    // A fully open room (no interior solids beyond the perimeter) — purpose-built
    // as a flexible mid-floor connector for 'graph2d' (module doc). Width (14) is
    // deliberately unique in the pool, see module doc.
    sizeGrid: { w: 14, h: 14 },
    solids: perimeterWalls(14, 14),
    spawns: { player: [{ x: 2, y: 7 }], enemy: [{ x: 7, y: 4, type: 'emberling' }, { x: 7, y: 10, type: 'floater' }] },
    exits: [{ edge: 'west' }, { edge: 'east' }, { edge: 'north' }, { edge: 'south' }],
  },
  {
    id: 'ember_extraction',
    role: 'extraction',
    sizeGrid: { w: 12, h: 10 },
    solids: perimeterWalls(12, 10),
    spawns: { player: [{ x: 6, y: 8 }], enemy: [] },
    // All 4 exits (design/05 'graph2d' content pass, 2026-08-05 — module doc's
    // "gained all 4 exits" paragraph): a graph2d floor's capstone can
    // legitimately be approached from any of the 4 sides.
    exits: [{ edge: 'west' }, { edge: 'east' }, { edge: 'north' }, { edge: 'south' }],
  },
  {
    id: 'ember_boss',
    role: 'boss',
    sizeGrid: { w: 22, h: 18 },
    solids: perimeterWalls(22, 18),
    spawns: { player: [{ x: 11, y: 16 }], enemy: [{ x: 11, y: 4, type: 'blightlord' }] },
    exits: [{ edge: 'west' }, { edge: 'east' }, { edge: 'north' }, { edge: 'south' }], // same graph2d fix as ember_extraction, see module doc
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
 *
 * `layout: 'graph2d'` (design/05, 2026-08-05 follow-up; was `'linear'`) — the
 * module doc above lists which pieces actually make a floor bend now.
 * `generateFloor`'s stage-selection stream is byte-identical to `'linear'`
 * (module doc, `world/dungeon.ts`), so this is placement-only: every past
 * seed's ROOM SEQUENCE is unchanged, only which piece lands where in 2D space
 * (and, for a west/east-only sequence, that's unchanged too). `'branching'`
 * stays unused by this config — no two normal pieces share a width (by design,
 * see `ember_atrium`'s doc comment above).
 */
export const EMBER_DUNGEON: DungeonConfig = {
  biomeId: 'ember',
  nameKey: 'biome.ember',
  floorCount: 3,
  roomsPerFloor: { min: 2, max: 3 },
  pieceTags: ['ember'],
  layout: 'graph2d',
  extractionPieceId: 'ember_extraction',
  bossPieceId: 'ember_boss',
  difficultyCurve: { base: 1, perFloor: 1 },
};
