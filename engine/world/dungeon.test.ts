/**
 * Seeded dungeon assembly (design/05/09, ROADMAP 1.3). `generateFloor` is a pure
 * function, so these tests drive it directly with a real `Prng` (matching
 * GameState's own construction pattern) rather than a live GameState. The live
 * GameEngine integration (SpawnSystem.tickDungeon/ExtractionSystem.resolveDescend)
 * is covered separately in dungeonrun.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { Prng } from '@dd/engine/math/prng';
import {
  buildFloorGeometry,
  carveDoorGaps,
  curveAt,
  generateFloor,
  placeFloor,
  type DungeonConfig,
} from '@dd/engine/world/dungeon';
import { EMBER_ROOMS } from '@dd/engine/world/rooms/ember';
import { roomGeometry, type RoomPiece } from '@dd/engine/content/rooms';
import { toFpGrid } from '@dd/engine/content/convert';
import { fp } from '@dd/engine/math/fixed';
import type { AABB } from '@dd/engine/state/entities';

/** Build an `AABB` fixture directly in (already-scaled) fp units — `carveDoorGaps`
 * operates in fp space, but its geometry is scale-agnostic, so plain round numbers
 * make these tests easy to eyeball without a grid→fp conversion in the way. */
function fpRect(x: number, y: number, w: number, h: number): AABB {
  return { x: fp(x), y: fp(y), w: fp(w), h: fp(h) };
}

const CONFIG: DungeonConfig = {
  biomeId: 'ember',
  nameKey: 'biome.ember.name',
  floorCount: 3,
  roomsPerFloor: { min: 3, max: 5 },
  pieceTags: ['ember'],
  layout: 'linear',
  extractionPieceId: 'ember_extraction',
  bossPieceId: 'ember_boss',
  difficultyCurve: { base: 2, perFloor: 1 },
};

describe('generateFloor', () => {
  it('produces roomCount within [min,max], the last room being the extraction piece', () => {
    const layout = generateFloor(CONFIG, 0, new Prng(42), EMBER_ROOMS);
    expect(layout.rooms.length).toBeGreaterThanOrEqual(CONFIG.roomsPerFloor.min);
    expect(layout.rooms.length).toBeLessThanOrEqual(CONFIG.roomsPerFloor.max);
    expect(layout.rooms[layout.rooms.length - 1]!.id).toBe('ember_extraction');
    // every non-capstone room must be a normal (untagged-role) piece from the pool
    for (const r of layout.rooms.slice(0, -1)) expect(r.role).toBeUndefined();
  });

  it('the deepest floor ends in the boss piece instead of the extraction piece', () => {
    const layout = generateFloor(CONFIG, CONFIG.floorCount - 1, new Prng(42), EMBER_ROOMS);
    expect(layout.rooms[layout.rooms.length - 1]!.id).toBe('ember_boss');
  });

  it('is deterministic for a given seed', () => {
    const a = generateFloor(CONFIG, 1, new Prng(7), EMBER_ROOMS);
    const b = generateFloor(CONFIG, 1, new Prng(7), EMBER_ROOMS);
    expect(a.rooms.map((r) => r.id)).toEqual(b.rooms.map((r) => r.id));
  });

  it('a different seed can produce a different room sequence', () => {
    const ids = (seed: number) => generateFloor(CONFIG, 1, new Prng(seed), EMBER_ROOMS).rooms.map((r) => r.id);
    // Not a strict guarantee for any two seeds, but true for this config/library —
    // pins the "seed actually drives selection" behavior, not just room count.
    const variants = new Set([1, 2, 3, 4, 5].map(ids).map((r) => r.join(',')));
    expect(variants.size).toBeGreaterThan(1);
  });

  it('every normal room drawn belongs to the requested pieceTags pool', () => {
    const layout = generateFloor(CONFIG, 0, new Prng(99), EMBER_ROOMS);
    for (const r of layout.rooms.slice(0, -1)) {
      expect(r.tags?.includes('ember')).toBe(true);
    }
  });

  it('throws at generation time if the tag pool is empty (fail loud, design/09)', () => {
    const badConfig: DungeonConfig = { ...CONFIG, pieceTags: ['nonexistent_biome'] };
    expect(() => generateFloor(badConfig, 0, new Prng(1), EMBER_ROOMS)).toThrow(/pieceTags/);
  });

  it('throws at generation time if the capstone piece id is missing from the library', () => {
    const badConfig: DungeonConfig = { ...CONFIG, extractionPieceId: 'does_not_exist' };
    expect(() => generateFloor(badConfig, 0, new Prng(1), EMBER_ROOMS)).toThrow(/capstone/);
  });

  it('roomsPerFloor.min === max produces exactly that many rooms every time', () => {
    const fixed: DungeonConfig = { ...CONFIG, roomsPerFloor: { min: 4, max: 4 } };
    for (const seed of [1, 2, 3]) {
      expect(generateFloor(fixed, 0, new Prng(seed), EMBER_ROOMS).rooms).toHaveLength(4);
    }
  });
});

describe('generateFloor — branching layout resolves at generation time (design/05, 2026-08-04)', () => {
  const BRANCHING: DungeonConfig = { ...CONFIG, layout: 'branching', branchFactor: 2 };

  it('every resolved room is a single, in-pool piece — no candidate list is exposed', () => {
    const f = generateFloor(BRANCHING, 0, new Prng(42), EMBER_ROOMS);
    const poolIds = new Set(EMBER_ROOMS.filter((r) => !r.role && r.tags?.includes('ember')).map((r) => r.id));
    for (const r of f.rooms.slice(0, -1)) {
      expect(poolIds.has(r.id)).toBe(true);
      expect(r.role).toBeUndefined();
    }
    expect(f.rooms[f.rooms.length - 1]!.id).toBe('ember_extraction');
  });

  it('the extra branch draw can select a different room than linear would, for the same seed', () => {
    // Not a strict guarantee for any one seed (the branch pick can land back on the same
    // room), but true across a small seed sweep — pins "the extra draw actually changes
    // the outcome sometimes," not just "branching doesn't crash."
    const linIds = (seed: number) => generateFloor({ ...CONFIG, layout: 'linear' }, 0, new Prng(seed), EMBER_ROOMS).rooms.map((r) => r.id);
    const brIds = (seed: number) => generateFloor(BRANCHING, 0, new Prng(seed), EMBER_ROOMS).rooms.map((r) => r.id);
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
    const anyDiffer = seeds.some((s) => linIds(s).join(',') !== brIds(s).join(','));
    expect(anyDiffer).toBe(true);
  });

  it('a branchFactor larger than the pool still produces valid, in-pool rooms without crashing', () => {
    const poolIds = new Set(EMBER_ROOMS.filter((r) => !r.role && r.tags?.includes('ember')).map((r) => r.id));
    const f = generateFloor({ ...CONFIG, layout: 'branching', branchFactor: 99 }, 0, new Prng(1), EMBER_ROOMS);
    for (const r of f.rooms.slice(0, -1)) expect(poolIds.has(r.id)).toBe(true);
  });

  it('is deterministic for a given seed', () => {
    const a = generateFloor(BRANCHING, 1, new Prng(7), EMBER_ROOMS);
    const b = generateFloor(BRANCHING, 1, new Prng(7), EMBER_ROOMS);
    expect(a.rooms.map((r) => r.id)).toEqual(b.rooms.map((r) => r.id));
  });
});

describe('curveAt (first-pass linear difficulty curve)', () => {
  it('scales linearly by floor index', () => {
    const curve = { base: 2, perFloor: 3 };
    expect(curveAt(curve, 0)).toBe(2);
    expect(curveAt(curve, 1)).toBe(5);
    expect(curveAt(curve, 4)).toBe(14);
  });
});

describe('EMBER_ROOMS library shape', () => {
  it('has exactly one extraction-role and one boss-role piece', () => {
    const roles = EMBER_ROOMS.map((r: RoomPiece) => r.role).filter(Boolean);
    expect(roles.filter((r) => r === 'extraction')).toHaveLength(1);
    expect(roles.filter((r) => r === 'boss')).toHaveLength(1);
  });

  it('every normal piece is tagged and every role piece is untagged-pool (referenced by id)', () => {
    for (const r of EMBER_ROOMS) {
      if (r.role) expect(r.tags).toBeUndefined();
      else expect(r.tags?.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// placeFloor / carveDoorGaps / buildFloorGeometry (design/05 "Room & door
// model", 2026-08-04) — unwired this pass (ROADMAP, PR1): pure functions only,
// driven directly with hand-picked RoomPiece fixtures, matching generateFloor's
// own test style above.
// ---------------------------------------------------------------------------

const HALL = EMBER_ROOMS.find((r) => r.id === 'ember_hall')!;
const CROSS = EMBER_ROOMS.find((r) => r.id === 'ember_cross')!;
const NARROW = EMBER_ROOMS.find((r) => r.id === 'ember_narrow')!;
const EXTRACTION = EMBER_ROOMS.find((r) => r.id === 'ember_extraction')!;

const NO_EXIT: RoomPiece = {
  id: 'test_no_exit',
  sizeGrid: { w: 10, h: 10 },
  solids: [],
  spawns: { player: [{ x: 5, y: 5 }], enemy: [] },
  exits: [],
};

const TINY: RoomPiece = {
  id: 'test_tiny',
  sizeGrid: { w: 6, h: 6 },
  solids: [],
  spawns: { player: [{ x: 3, y: 3 }], enemy: [] },
  exits: [{ edge: 'west' }, { edge: 'east' }],
};

describe('placeFloor', () => {
  it('places rooms left-to-right, each touching the next, doors connecting them in order', () => {
    const rooms = [HALL, CROSS, NARROW, EXTRACTION];
    const { placed, doors } = placeFloor(rooms, new Prng(1));
    expect(placed).toHaveLength(4);
    expect(placed[0]!.offsetXGrid).toBe(0);
    expect(placed[1]!.offsetXGrid).toBe(HALL.sizeGrid.w);
    expect(placed[2]!.offsetXGrid).toBe(HALL.sizeGrid.w + CROSS.sizeGrid.w);
    expect(placed[3]!.offsetXGrid).toBe(HALL.sizeGrid.w + CROSS.sizeGrid.w + NARROW.sizeGrid.w);
    expect(doors).toHaveLength(3);
    doors.forEach((d, i) => {
      expect(d.roomA).toBe(placed[i]!.id);
      expect(d.roomB).toBe(placed[i + 1]!.id);
    });
  });

  it('gives every placed room a floor-unique id even if the same piece is drawn twice', () => {
    const { placed } = placeFloor([HALL, HALL], new Prng(1)); // HALL has both west+east, valid to chain to itself
    expect(placed[0]!.id).toBe('ember_hall#0');
    expect(placed[1]!.id).toBe('ember_hall#1');
    expect(placed[0]!.id).not.toBe(placed[1]!.id);
  });

  it("a door's passage sits within both connected rooms' vertical overlap and is not pinned to one fixed position", () => {
    const seenY = new Set<number>();
    // Spread-out seeds, not small sequential ones: this LCG's low-order bits (a small
    // `% 5` modulus) are seed-insensitive on a truly fresh state — a known property of
    // this exact multiplier, not a placeFloor bug — so a `nextInt(1000)` warmup mirrors
    // real usage, where `generateFloor`'s own draws already advance `roomgenPrng` well
    // past a fresh seed before `placeFloor` ever runs.
    const seeds = [1, 100000, 5000000, 999999999, 123456789, 555555555, 42, 7, 88888, 314159265];
    for (const seed of seeds) {
      const prng = new Prng(seed);
      prng.nextInt(1000);
      const { doors } = placeFloor([HALL, NARROW], prng);
      const passage = doors[0]!.passageGrid;
      seenY.add(passage.y);
      expect(passage.y).toBeGreaterThanOrEqual(0);
      expect(passage.y + passage.h).toBeLessThanOrEqual(Math.min(HALL.sizeGrid.h, NARROW.sizeGrid.h));
    }
    // Not pinned to one anchor across 10 spread-out seeds — proves placement is drawn,
    // not hardcoded to the wall's own center (design/05's explicit "not wall-centered"
    // requirement).
    expect(seenY.size).toBeGreaterThan(1);
  });

  it('is deterministic for a given seed', () => {
    const a = placeFloor([HALL, CROSS, NARROW], new Prng(9));
    const b = placeFloor([HALL, CROSS, NARROW], new Prng(9));
    expect(a.placed.map((p) => ({ id: p.id, x: p.offsetXGrid, y: p.offsetYGrid }))).toEqual(
      b.placed.map((p) => ({ id: p.id, x: p.offsetXGrid, y: p.offsetYGrid })),
    );
    expect(a.doors).toEqual(b.doors);
  });

  it('throws (fail loud) when adjacent pieces lack the matching east/west exit', () => {
    expect(() => placeFloor([HALL, NO_EXIT], new Prng(1))).toThrow(/west exit/i);
    expect(() => placeFloor([NO_EXIT, HALL], new Prng(1))).toThrow(/east exit/i);
  });

  it('throws (fail loud) when two adjacent rooms are too small/mismatched to fit a door', () => {
    expect(() => placeFloor([TINY, TINY], new Prng(1))).toThrow(/too small/i);
  });
});

describe('carveDoorGaps', () => {
  it('splits a wall bisected by a passage into two residual pieces', () => {
    const wall = fpRect(0, 0, 10, 100);
    const passage = fpRect(-5, 40, 20, 20);
    const result = carveDoorGaps([wall], [passage]);
    expect(result).toHaveLength(2);
    expect(result).toContainEqual(fpRect(0, 0, 10, 40));
    expect(result).toContainEqual(fpRect(0, 60, 10, 40));
  });

  it('leaves a wall unchanged when a passage does not overlap it', () => {
    const wall = fpRect(0, 0, 10, 10);
    const farPassage = fpRect(100, 100, 5, 5);
    expect(carveDoorGaps([wall], [farPassage])).toEqual([wall]);
  });

  it('only carves the wall a passage actually overlaps, leaving other walls untouched', () => {
    const wallA = fpRect(0, 0, 10, 100);
    const wallB = fpRect(200, 0, 10, 100);
    const passage = fpRect(-5, 40, 20, 20);
    const result = carveDoorGaps([wallA, wallB], [passage]);
    expect(result).toContainEqual(wallB);
    expect(result.filter((r) => r.x === fp(200))).toHaveLength(1);
    expect(result.filter((r) => r.x === fp(0))).toHaveLength(2);
  });
});

describe('buildFloorGeometry', () => {
  function coveredAt(walls: readonly AABB[], x: number, y: number): boolean {
    return walls.some((w) => x >= w.x && x < w.x + w.w && y >= w.y && y < w.y + w.h);
  }

  it("a single room with no doors matches roomGeometry's own conversion exactly", () => {
    const placedRoom = { id: 'ember_hall#0', piece: HALL, offsetXGrid: 0, offsetYGrid: 0, entranceGrid: { x: 0, y: 0 } };
    const geo = buildFloorGeometry([placedRoom], []);
    const direct = roomGeometry(HALL, 0, 0);
    expect(geo.walls).toEqual(direct.walls);
    expect(geo.obstacles).toEqual(direct.obstacles);
  });

  it('worldW/worldH reflect the summed width / max height of every placed room', () => {
    const { placed, doors } = placeFloor([HALL, NARROW], new Prng(2));
    const geo = buildFloorGeometry(placed, doors);
    expect(geo.worldW).toBe(toFpGrid(HALL.sizeGrid.w + NARROW.sizeGrid.w));
    expect(geo.worldH).toBe(toFpGrid(Math.max(HALL.sizeGrid.h, NARROW.sizeGrid.h)));
  });

  it('a carved door is a real, walkable hole — open at its own center, still solid elsewhere along the same wall', () => {
    const { placed, doors } = placeFloor([HALL, NARROW], new Prng(3));
    const { walls } = buildFloorGeometry(placed, doors);
    const door = doors[0]!;
    const centerXFp = toFpGrid(door.passageGrid.x + door.passageGrid.w / 2);
    const centerYFp = toFpGrid(door.passageGrid.y + door.passageGrid.h / 2);
    expect(coveredAt(walls, centerXFp, centerYFp)).toBe(false);

    // A point unambiguously inside HALL's own east-wall column (half a grid unit back
    // from the shared room boundary — the boundary itself is an ambiguous seam between
    // two adjacent rooms' half-open wall AABBs), away from the door's y-band, must
    // still be solid.
    const insideHallWallXFp = toFpGrid(door.passageGrid.x + door.passageGrid.w / 2 - 0.5);
    const farYGrid = door.passageGrid.y > HALL.sizeGrid.h / 2 ? 1.6 : HALL.sizeGrid.h - 1.6;
    expect(coveredAt(walls, insideHallWallXFp, toFpGrid(farYGrid))).toBe(true);
  });
});
