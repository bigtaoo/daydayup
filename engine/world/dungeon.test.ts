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
  placeAuthoredFloor,
  type DungeonConfig,
  type DungeonFloorMap,
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

describe('generateFloor — branching layout gets at most one real fork (design/05, 2026-08-05)', () => {
  const BRANCHING: DungeonConfig = { ...CONFIG, layout: 'branching', branchFactor: 2 };

  it('every flattened .rooms entry is still a single, in-pool piece, and .rooms === stages flattened', () => {
    const f = generateFloor(BRANCHING, 0, new Prng(42), EMBER_ROOMS);
    const poolIds = new Set(EMBER_ROOMS.filter((r) => !r.role && r.tags?.includes('ember')).map((r) => r.id));
    for (const r of f.rooms.slice(0, -1)) {
      expect(poolIds.has(r.id)).toBe(true);
      expect(r.role).toBeUndefined();
    }
    expect(f.rooms[f.rooms.length - 1]!.id).toBe('ember_extraction');
    expect(f.rooms).toEqual(f.stages.map((s) => (Array.isArray(s) ? s[0] : s)));
  });

  // EMBER_ROOMS' 4 normal pieces (ember_hall/pillars/cross/narrow) all have DIFFERENT
  // widths, so — same-width being the fork-eligibility rule (module doc) — a fork
  // stage here always finds zero eligible partners and gracefully degrades to a
  // single piece: this pool never actually shows a materialized sibling set. See the
  // dedicated 'a real fork with distinct siblings' describe block below for a pool
  // that DOES exercise real forking.
  it('gracefully degrades to a single piece per stage when the pool has no same-width match (EMBER_ROOMS)', () => {
    const f = generateFloor(BRANCHING, 0, new Prng(42), EMBER_ROOMS);
    for (const s of f.stages) expect(Array.isArray(s)).toBe(false);
  });

  it('the extra fork-position draw shifts the whole per-stage stream, so branching still diverges from linear', () => {
    // Not "the extra draw picks a different room" anymore (module doc — that's the
    // OLD mechanism); now branching draws ONE extra value up front (which interior
    // transition forks) before the per-stage loop, offsetting every subsequent
    // nextInt() call by one position in the LCG stream relative to 'linear'. Not a
    // strict per-seed guarantee, but true across a small seed sweep.
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

  it('never forks with fewer than 2 normal stages (nowhere to put both a fork and a merge point)', () => {
    const oneNormal: DungeonConfig = { ...BRANCHING, roomsPerFloor: { min: 2, max: 2 } }; // roomCount 2 → normalCount 1
    for (const seed of [1, 2, 3, 4, 5]) {
      const f = generateFloor(oneNormal, 0, new Prng(seed), EMBER_ROOMS);
      expect(f.stages.length).toBe(2); // 1 normal + capstone
      for (const s of f.stages) expect(Array.isArray(s)).toBe(false);
    }
  });

  it('never forks at stage 0 — the run\'s spawn room is always a single ordinary room', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      const f = generateFloor(BRANCHING, 0, new Prng(seed), EMBER_ROOMS);
      expect(Array.isArray(f.stages[0])).toBe(false);
    }
  });
});

describe('generateFloor — a real fork with distinct siblings (design/05, 2026-08-05)', () => {
  // A bespoke pool where forking has somewhere to land: FORK_A/FORK_B share a width
  // (20) and nothing else in the pool does, so ANY base pick at the fork stage is
  // guaranteed exactly one same-width partner — deterministic shape, seed-independent.
  const FORK_A: RoomPiece = {
    id: 'fork_a', tags: ['fk'], sizeGrid: { w: 20, h: 14 }, solids: [],
    spawns: { player: [{ x: 2, y: 7 }], enemy: [] }, exits: [{ edge: 'west' }, { edge: 'east' }],
  };
  const FORK_B: RoomPiece = {
    id: 'fork_b', tags: ['fk'], sizeGrid: { w: 20, h: 18 }, solids: [],
    spawns: { player: [{ x: 2, y: 9 }], enemy: [] }, exits: [{ edge: 'west' }, { edge: 'east' }],
  };
  const FORK_CAP: RoomPiece = {
    id: 'fork_cap', role: 'boss', sizeGrid: { w: 12, h: 30 }, solids: [],
    spawns: { player: [{ x: 6, y: 15 }], enemy: [] }, exits: [{ edge: 'west' }],
  };
  const FORK_LIB = [FORK_A, FORK_B, FORK_CAP];
  // roomsPerFloor min=max=3 → normalCount=2 → forkStageIndex = 1 + nextInt(1) = 1,
  // ALWAYS — every seed puts the fork at stage 1, the last normal stage.
  const FORK_CFG: DungeonConfig = {
    biomeId: 'fk', nameKey: 'fk', floorCount: 1, roomsPerFloor: { min: 3, max: 3 },
    pieceTags: ['fk'], layout: 'branching', branchFactor: 2,
    extractionPieceId: 'fork_cap', bossPieceId: 'fork_cap', difficultyCurve: { base: 1, perFloor: 0 },
  };

  it('resolves stage 1 to both distinct, same-width siblings, for every seed', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const f = generateFloor(FORK_CFG, 0, new Prng(seed), FORK_LIB);
      expect(Array.isArray(f.stages[0])).toBe(false); // stage 0 stays ordinary
      const fork = f.stages[1];
      expect(Array.isArray(fork)).toBe(true);
      const siblings = fork as readonly RoomPiece[];
      expect(siblings).toHaveLength(2);
      expect(new Set(siblings.map((s) => s.id))).toEqual(new Set(['fork_a', 'fork_b']));
      expect(siblings[0]!.sizeGrid.w).toBe(siblings[1]!.sizeGrid.w);
      expect(f.stages[2]).toBe(FORK_CAP); // capstone, ordinary
    }
  });

  it('.rooms flattens the fork stage down to its first/primary sibling', () => {
    const f = generateFloor(FORK_CFG, 0, new Prng(3), FORK_LIB);
    const fork = f.stages[1] as readonly RoomPiece[];
    expect(f.rooms[1]).toBe(fork[0]);
  });

  it('degrades to a single piece when the pool has no eligible partner at all (pool of one)', () => {
    const lonely = generateFloor(
      { ...FORK_CFG, pieceTags: ['lonely'] },
      0,
      new Prng(1),
      [{ ...FORK_A, id: 'only_one', tags: ['lonely'] }, FORK_CAP],
    );
    expect(Array.isArray(lonely.stages[1])).toBe(false);
  });

  it('is deterministic for a given seed', () => {
    const a = generateFloor(FORK_CFG, 0, new Prng(11), FORK_LIB);
    const b = generateFloor(FORK_CFG, 0, new Prng(11), FORK_LIB);
    const norm = (f: typeof a) => f.stages.map((s) => (Array.isArray(s) ? s.map((p) => p.id) : s.id));
    expect(norm(a)).toEqual(norm(b));
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

describe('placeFloor — branching fork stage (design/05, 2026-08-05 "fully-realized branching")', () => {
  // HUB/MERGE are tall (30) relative to the stacked siblings (10 each + a 2-unit gap
  // = 22 total) so BOTH siblings land comfortably within each's own y-range once
  // centered — pickDoorAnchor needs real vertical overlap on every hub/sibling and
  // sibling/merge pair, not just the stack as a whole (module doc's own documented
  // "curated content" contract).
  const HUB: RoomPiece = {
    id: 'hub', sizeGrid: { w: 14, h: 30 }, solids: [],
    spawns: { player: [{ x: 2, y: 15 }], enemy: [] }, exits: [{ edge: 'west' }, { edge: 'east' }],
  };
  const SIB_A: RoomPiece = {
    id: 'sib_a', sizeGrid: { w: 20, h: 10 }, solids: [],
    spawns: { player: [{ x: 2, y: 5 }], enemy: [] }, exits: [{ edge: 'west' }, { edge: 'east' }],
  };
  const SIB_B: RoomPiece = {
    id: 'sib_b', sizeGrid: { w: 20, h: 10 }, solids: [],
    spawns: { player: [{ x: 2, y: 5 }], enemy: [] }, exits: [{ edge: 'west' }, { edge: 'east' }],
  };
  const MERGE: RoomPiece = {
    id: 'merge', sizeGrid: { w: 14, h: 30 }, solids: [],
    spawns: { player: [{ x: 2, y: 15 }], enemy: [] }, exits: [{ edge: 'west' }],
  };

  it('places siblings side-by-side east of the hub — same X, stacked and non-overlapping in Y', () => {
    const { placed } = placeFloor([HUB, [SIB_A, SIB_B], MERGE], new Prng(1));
    expect(placed).toHaveLength(4);
    const [hub, a, b, merge] = placed;
    expect(a!.piece.id).toBe('sib_a');
    expect(b!.piece.id).toBe('sib_b');
    expect(a!.offsetXGrid).toBe(hub!.offsetXGrid + HUB.sizeGrid.w);
    expect(b!.offsetXGrid).toBe(a!.offsetXGrid); // same X — side by side
    expect(a!.offsetYGrid).not.toBe(b!.offsetYGrid); // stacked, not on top of each other
    // Non-overlapping Y ranges (order-independent — either could be stacked first).
    const [lo, hi] = a!.offsetYGrid < b!.offsetYGrid ? [a!, b!] : [b!, a!];
    expect(lo.offsetYGrid + lo.piece.sizeGrid.h).toBeLessThanOrEqual(hi.offsetYGrid);
    expect(merge!.offsetXGrid).toBe(a!.offsetXGrid + SIB_A.sizeGrid.w); // merge starts after the shared width
    expect(merge!.offsetYGrid).toBe(0); // merge stays on the spine's Y=0, like every plain stage
  });

  it('connects the hub to every sibling and every sibling to the merge room — the reconvergence', () => {
    const { placed, doors } = placeFloor([HUB, [SIB_A, SIB_B], MERGE], new Prng(1));
    const [hub, a, b, merge] = placed;
    expect(doors).toHaveLength(4); // hub→a, hub→b, a→merge, b→merge — NOT rooms.length-1
    const pairs = doors.map((d) => `${d.roomA}->${d.roomB}`);
    expect(pairs).toEqual(
      expect.arrayContaining([`${hub!.id}->${a!.id}`, `${hub!.id}->${b!.id}`, `${a!.id}->${merge!.id}`, `${b!.id}->${merge!.id}`]),
    );
  });

  it('each sibling\'s entranceGrid is set from its OWN connecting door, not shared with its sibling', () => {
    const { placed } = placeFloor([HUB, [SIB_A, SIB_B], MERGE], new Prng(1));
    const [, a, b] = placed;
    // Each sibling's entrance x is inset into ITS OWN offsetXGrid (same for both,
    // since they share an X), but the y comes from ITS OWN door's anchor — which
    // differs, since the two doors were drawn independently and the siblings sit at
    // different Y — so the two entrances must differ overall.
    expect(a!.entranceGrid).not.toEqual(b!.entranceGrid);
    expect(a!.entranceGrid.x).toBe(a!.offsetXGrid + 1.5); // ENTRANCE_INSET_GRID
    expect(b!.entranceGrid.x).toBe(b!.offsetXGrid + 1.5);
  });

  it('the merge room\'s entranceGrid is set from the FIRST connecting door processed (sibling draw order)', () => {
    const { placed, doors } = placeFloor([HUB, [SIB_A, SIB_B], MERGE], new Prng(1));
    const merge = placed[3]!;
    const firstDoorIntoMerge = doors.find((d) => d.roomB === merge.id)!;
    expect(merge.entranceGrid).toEqual({
      x: merge.offsetXGrid + 1.5,
      y: firstDoorIntoMerge.passageGrid.y + firstDoorIntoMerge.passageGrid.h / 2,
    });
  });

  it('no two placed rooms spatially overlap', () => {
    const { placed } = placeFloor([HUB, [SIB_A, SIB_B], MERGE], new Prng(1));
    const rect = (r: (typeof placed)[number]) => ({
      x0: r.offsetXGrid, x1: r.offsetXGrid + r.piece.sizeGrid.w,
      y0: r.offsetYGrid, y1: r.offsetYGrid + r.piece.sizeGrid.h,
    });
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const ri = rect(placed[i]!);
        const rj = rect(placed[j]!);
        const overlaps = ri.x0 < rj.x1 && rj.x0 < ri.x1 && ri.y0 < rj.y1 && rj.y0 < ri.y1;
        expect(overlaps).toBe(false);
      }
    }
  });

  it('is deterministic for a given seed', () => {
    const a = placeFloor([HUB, [SIB_A, SIB_B], MERGE], new Prng(5));
    const b = placeFloor([HUB, [SIB_A, SIB_B], MERGE], new Prng(5));
    expect(a.placed.map((p) => ({ id: p.id, x: p.offsetXGrid, y: p.offsetYGrid }))).toEqual(
      b.placed.map((p) => ({ id: p.id, x: p.offsetXGrid, y: p.offsetYGrid })),
    );
    expect(a.doors).toEqual(b.doors);
  });

  it('throws (fail loud) when a fork stage\'s siblings do not share one width', () => {
    const NARROW_SIB: RoomPiece = { ...SIB_A, id: 'sib_narrow', sizeGrid: { w: 18, h: 12 } };
    expect(() => placeFloor([HUB, [SIB_A, NARROW_SIB], MERGE], new Prng(1))).toThrow(/share one width/i);
  });

  it('throws (fail loud) when the hub has no east exit to connect to the fork', () => {
    const HUB_NO_EAST: RoomPiece = { ...HUB, id: 'hub_no_east', exits: [{ edge: 'west' }] };
    expect(() => placeFloor([HUB_NO_EAST, [SIB_A, SIB_B], MERGE], new Prng(1))).toThrow(/east exit/i);
  });

  it('throws (fail loud) when a fork sibling is missing its west or east exit', () => {
    const SIB_NO_WEST: RoomPiece = { ...SIB_A, id: 'sib_no_west', exits: [{ edge: 'east' }] };
    expect(() => placeFloor([HUB, [SIB_NO_WEST, SIB_B], MERGE], new Prng(1))).toThrow(/west\+east exits/i);
    const SIB_NO_EAST: RoomPiece = { ...SIB_A, id: 'sib_no_east', exits: [{ edge: 'west' }] };
    expect(() => placeFloor([HUB, [SIB_NO_EAST, SIB_B], MERGE], new Prng(1))).toThrow(/west\+east exits/i);
  });

  it('throws (fail loud) when a fork stage is stage 0 (no predecessor to fork from)', () => {
    expect(() => placeFloor([[SIB_A, SIB_B], MERGE], new Prng(1))).toThrow(/single-room stage/i);
  });

  it('throws (fail loud) when a fork stage immediately follows another fork stage', () => {
    expect(() => placeFloor([HUB, [SIB_A, SIB_B], [SIB_A, SIB_B], MERGE], new Prng(1))).toThrow(/single-room stage/i);
  });

  it('still throws (fail loud) if the hub is too small to fit a door to a stacked-away sibling', () => {
    // Two same-width TINY-sized siblings, stacked with a gap and centered on TINY's
    // (also tiny) own vertical center — the stack pushes each sibling far enough off
    // TINY's own y-range that pickDoorAnchor's overlap band goes negative.
    const TINY_SIB_1: RoomPiece = { id: 'tiny_sib_1', sizeGrid: { w: 6, h: 6 }, solids: [], spawns: { player: [{ x: 3, y: 3 }], enemy: [] }, exits: [{ edge: 'west' }, { edge: 'east' }] };
    const TINY_SIB_2: RoomPiece = { id: 'tiny_sib_2', sizeGrid: { w: 6, h: 6 }, solids: [], spawns: { player: [{ x: 3, y: 3 }], enemy: [] }, exits: [{ edge: 'west' }, { edge: 'east' }] };
    expect(() => placeFloor([TINY, [TINY_SIB_1, TINY_SIB_2], MERGE], new Prng(1))).toThrow(/too small/i);
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

// ---------------------------------------------------------------------------
// placeAuthoredFloor (design/05 "Hand-authored PvE floors", 2026-08-05) — a
// sibling to placeFloor, driven directly with a hand-built DungeonFloorMap
// fixture (no Prng at all: unlike placeFloor, there is nothing to draw).
// ---------------------------------------------------------------------------

const NO_SPAWN: RoomPiece = {
  id: 'test_no_spawn',
  sizeGrid: { w: 10, h: 10 },
  solids: [],
  spawns: { player: [], enemy: [] },
  exits: [],
};

describe('placeAuthoredFloor', () => {
  it('places every room at its exact authored offset and passes doors through byte-unchanged', () => {
    const map: DungeonFloorMap = {
      id: 'test_floor',
      rooms: [
        { id: 'a', pieceId: 'ember_hall', offsetXGrid: 0, offsetYGrid: 0 },
        { id: 'b', pieceId: 'ember_narrow', offsetXGrid: 20, offsetYGrid: 0 },
        { id: 'c', pieceId: 'ember_extraction', offsetXGrid: 44, offsetYGrid: 0 },
      ],
      doors: [
        { roomA: 'a', roomB: 'b', passageGrid: { x: 19, y: 2, w: 2, h: 4 } },
        { roomA: 'b', roomB: 'c', passageGrid: { x: 43, y: 1, w: 2, h: 4 } },
      ],
    };
    const { placed, doors } = placeAuthoredFloor(map, EMBER_ROOMS);
    expect(placed.map((p) => ({ id: p.id, x: p.offsetXGrid, y: p.offsetYGrid, piece: p.piece.id }))).toEqual([
      { id: 'a', x: 0, y: 0, piece: 'ember_hall' },
      { id: 'b', x: 20, y: 0, piece: 'ember_narrow' },
      { id: 'c', x: 44, y: 0, piece: 'ember_extraction' },
    ]);
    expect(doors).toEqual(map.doors); // no PRNG draw — the authored passageGrid IS the door
  });

  it("the entrance room (rooms[0])'s entranceGrid comes from its own authored player spawn, offset by its placement", () => {
    const map: DungeonFloorMap = {
      id: 'f',
      rooms: [{ id: 'a', pieceId: 'ember_hall', offsetXGrid: 5, offsetYGrid: 3 }],
      doors: [],
    };
    const { placed } = placeAuthoredFloor(map, EMBER_ROOMS);
    const sp = HALL.spawns.player[0]!;
    expect(placed[0]!.entranceGrid).toEqual({ x: 5 + sp.x, y: 3 + sp.y });
  });

  it('falls back to an inset/size-half point when the entrance room authored no player spawn', () => {
    const map: DungeonFloorMap = {
      id: 'f',
      rooms: [{ id: 'a', pieceId: 'test_no_spawn', offsetXGrid: 4, offsetYGrid: 6 }],
      doors: [],
    };
    const { placed } = placeAuthoredFloor(map, [NO_SPAWN]);
    // 1.5 === ENTRANCE_INSET_GRID (an internal, unexported module constant).
    expect(placed[0]!.entranceGrid).toEqual({ x: 4 + 1.5, y: 6 + NO_SPAWN.sizeGrid.h / 2 });
  });

  it("a non-entrance room's entranceGrid insets along X off a vertical (east/west-wall) door", () => {
    const map: DungeonFloorMap = {
      id: 'f',
      rooms: [
        { id: 'a', pieceId: 'ember_hall', offsetXGrid: 0, offsetYGrid: 0 },
        { id: 'b', pieceId: 'ember_narrow', offsetXGrid: 20, offsetYGrid: 0 }, // b sits east of a
      ],
      doors: [{ roomA: 'a', roomB: 'b', passageGrid: { x: 19, y: 2, w: 2, h: 4 } }], // vertical: w <= h
    };
    const { placed } = placeAuthoredFloor(map, EMBER_ROOMS);
    // Door center (20, 4) sits on b's WEST wall (20 <= b's own center x, 20+24/2=32) —
    // inset 1.5 grid units in from that wall, y unchanged from the passage's own center.
    expect(placed[1]!.entranceGrid).toEqual({ x: 20 + 1.5, y: 4 });
  });

  it("a non-entrance room's entranceGrid insets along Y off a horizontal (north/south-wall) door", () => {
    const map: DungeonFloorMap = {
      id: 'f',
      rooms: [
        { id: 'a', pieceId: 'ember_cross', offsetXGrid: 0, offsetYGrid: 0 },
        { id: 'b', pieceId: 'ember_cross', offsetXGrid: 0, offsetYGrid: 16 }, // b sits south of a
      ],
      doors: [{ roomA: 'a', roomB: 'b', passageGrid: { x: 6, y: 15, w: 4, h: 2 } }], // horizontal: w > h
    };
    const { placed } = placeAuthoredFloor(map, EMBER_ROOMS);
    // Door center (8, 16) sits on b's NORTH wall (16 <= b's own center y, 16+16/2=24) —
    // inset 1.5 grid units down from that wall, x unchanged from the passage's own center.
    expect(placed[1]!.entranceGrid).toEqual({ x: 8, y: 16 + 1.5 });
  });

  it('a room with multiple incoming doors takes its entranceGrid from whichever comes FIRST in doors array order', () => {
    const map: DungeonFloorMap = {
      id: 'f',
      rooms: [
        { id: 'a', pieceId: 'ember_hall', offsetXGrid: 0, offsetYGrid: 0 },
        { id: 'b', pieceId: 'ember_pillars', offsetXGrid: 20, offsetYGrid: 0 },
        { id: 'c', pieceId: 'ember_pillars', offsetXGrid: 20, offsetYGrid: 20 },
        { id: 'merge', pieceId: 'ember_extraction', offsetXGrid: 38, offsetYGrid: 10 },
      ],
      doors: [
        { roomA: 'b', roomB: 'merge', passageGrid: { x: 37, y: 12, w: 2, h: 4 } }, // FIRST — wins
        { roomA: 'c', roomB: 'merge', passageGrid: { x: 37, y: 25, w: 2, h: 4 } }, // ignored for entrance
      ],
    };
    const { placed } = placeAuthoredFloor(map, EMBER_ROOMS);
    const merge = placed.find((p) => p.id === 'merge')!;
    expect(merge.entranceGrid).toEqual({ x: 38 + 1.5, y: 14 });
  });

  it('throws (fail loud) when a room references an unknown pieceId', () => {
    const map: DungeonFloorMap = {
      id: 'f',
      rooms: [{ id: 'a', pieceId: 'does_not_exist', offsetXGrid: 0, offsetYGrid: 0 }],
      doors: [],
    };
    expect(() => placeAuthoredFloor(map, EMBER_ROOMS)).toThrow(/unknown piece/i);
  });

  it('throws (fail loud) when a door references an unknown room id', () => {
    const map: DungeonFloorMap = {
      id: 'f',
      rooms: [{ id: 'a', pieceId: 'ember_hall', offsetXGrid: 0, offsetYGrid: 0 }],
      doors: [{ roomA: 'a', roomB: 'ghost', passageGrid: { x: 0, y: 0, w: 1, h: 1 } }],
    };
    expect(() => placeAuthoredFloor(map, EMBER_ROOMS)).toThrow(/unknown room/i);
  });

  it('throws (fail loud) on an empty rooms list', () => {
    const map: DungeonFloorMap = { id: 'f', rooms: [], doors: [] };
    expect(() => placeAuthoredFloor(map, EMBER_ROOMS)).toThrow(/no rooms/i);
  });
});
