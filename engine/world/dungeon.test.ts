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
  placeFloorGraph2d,
  placeAuthoredFloor,
  type DungeonConfig,
  type DungeonFloorMap,
} from '@dd/engine/world/dungeon';
import { EMBER_DUNGEON, EMBER_PROCEDURAL_DUNGEON, EMBER_ROOMS } from '@dd/engine/world/rooms/ember';
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

// Drives `EMBER_PROCEDURAL_DUNGEON`, not `EMBER_DUNGEON`: level 1 is now fully
// hand-authored (every floor index has a `floorMaps` entry), so the shipped config
// no longer reaches `generateFloor` at all. The pair under test here is the
// procedural descriptor and the `EMBER_ROOMS` pool it was built for — see
// `world/rooms/ember.ts`'s module doc for what these sweeps originally found, which
// is exactly the coverage this suite exists to keep.
describe("the procedural Ember pair ships with layout: 'graph2d' — a generated floor actually bends (design/05, 2026-08-05 follow-up)", () => {
  it("both Ember configs use 'graph2d'", () => {
    expect(EMBER_PROCEDURAL_DUNGEON.layout).toBe('graph2d');
    expect(EMBER_DUNGEON.layout).toBe('graph2d');
  });

  it('no two normal EMBER_ROOMS pieces share a width — branching stays unused by this config, not an accidental side effect of the new piece', () => {
    const widths = EMBER_ROOMS.filter((r) => !r.role).map((r) => r.sizeGrid.w);
    expect(new Set(widths).size).toBe(widths.length);
  });

  it('ember_pillars and ember_atrium both offer all 4 exits now, alongside the pre-existing ember_cross', () => {
    const flexible = EMBER_ROOMS.filter((r) => !r.role && r.exits.length === 4).map((r) => r.id);
    expect(new Set(flexible)).toEqual(new Set(['ember_cross', 'ember_pillars', 'ember_atrium']));
  });

  // `placeAdjacent2d` (world/dungeon.ts) centers whichever axis the hop DIDN'T
  // travel along: an east/west hop preserves the two rooms' shared centerY
  // (offsetYGrid alone can still differ room-to-room whenever heights differ —
  // not a reliable "did it bend" signal on its own), a north/south hop preserves
  // centerX instead. So "this hop was vertical (north/south)" is exactly
  // "the two rooms share one centerX" — a direct read of the direction actually
  // drawn, not a proxy.
  function isVerticalHop(a: { offsetXGrid: number; piece: RoomPiece }, b: { offsetXGrid: number; piece: RoomPiece }): boolean {
    return a.offsetXGrid + a.piece.sizeGrid.w / 2 === b.offsetXGrid + b.piece.sizeGrid.w / 2;
  }

  it('a real seed sweep genuinely bends: some floor takes at least one north/south hop', () => {
    // generateFloor + placeFloorGraph2d off the SAME roomgenPrng instance, exactly
    // how SpawnSystem.generateAndPlaceFloor chains them (world/systems/SpawnSystem.ts)
    // — not a synthetic pool, the real shipped EMBER_DUNGEON/EMBER_ROOMS pairing.
    let bent = false;
    for (let seed = 1; seed <= 200 && !bent; seed++) {
      const prng = new Prng(seed);
      const layout = generateFloor(EMBER_PROCEDURAL_DUNGEON, 0, prng, EMBER_ROOMS);
      const { placed } = placeFloorGraph2d(layout.rooms, prng);
      for (let i = 1; i < placed.length; i++) {
        if (isVerticalHop(placed[i - 1]!, placed[i]!)) bent = true;
      }
    }
    expect(bent).toBe(true);
  });

  it('a real seed sweep also produces straight (unbent) floors — bending is real 2D freedom, not a forced zig-zag', () => {
    let straight = false;
    for (let seed = 1; seed <= 200 && !straight; seed++) {
      const prng = new Prng(seed);
      const layout = generateFloor(EMBER_PROCEDURAL_DUNGEON, 0, prng, EMBER_ROOMS);
      const { placed } = placeFloorGraph2d(layout.rooms, prng);
      const allHorizontal = Array.from({ length: placed.length - 1 }, (_, i) => i + 1).every(
        (i) => !isVerticalHop(placed[i - 1]!, placed[i]!),
      );
      if (allHorizontal) straight = true;
    }
    expect(straight).toBe(true);
  });

  // Exhaustive, not sampled: `EMBER_PROCEDURAL_DUNGEON.roomsPerFloor` caps a floor at 3
  // rooms (2 normal + capstone), and `generateFloor`'s stage draws are IID over
  // the pool — so "every seed" reduces to a small, fully enumerable space:
  // every (normal1, normal2, capstone) triple the real pool can produce, times
  // every direction `placeFloorGraph2d` could resolve stage 0→1 to. Found BOTH
  // of ember_extraction/ember_boss's `world/rooms/ember.ts` exit fixes this way
  // (its module doc's "found NOT by inspection" paragraph) — a 200-seed sample
  // had already gone green in between, which is exactly why this is exhaustive
  // rather than another sample: a bigger sample proves "rarer than 1/N", never
  // "impossible". `ForcedPrng` only pins stage 0→1's direction draw (a 2-room
  // floor structurally can't overlap — a single hop off the spawn only ever
  // touches, never overlaps, its one neighbor); stage 1→capstone is left to
  // `placeFloorGraph2d`'s own direction-retry to resolve, since that retry
  // already tries every viable direction — if resolving stage 1→capstone were
  // possible at all for a given stage-0→1 outcome, this test relies on the
  // retry actually finding it, which is the exact behavior under test.
  describe('exhaustive: every 3-room (normal, normal, capstone) combo the real pool can produce places without throwing', () => {
    class ForcedFirstDrawPrng extends Prng {
      private consumed = false;
      constructor(seed: number, private readonly forcedFirst: number) {
        super(seed);
      }
      override nextInt(max: number): number {
        if (!this.consumed) {
          this.consumed = true;
          return Math.min(this.forcedFirst, max - 1);
        }
        return super.nextInt(max);
      }
    }

    const normals = EMBER_ROOMS.filter((r) => !r.role);
    const capstones = EMBER_ROOMS.filter((r) => r.role);

    it('every combo resolves (no dead end, no fold-back overlap)', () => {
      const failures: string[] = [];
      for (const n1 of normals) {
        for (const n2 of normals) {
          for (const cap of capstones) {
            for (let forcedFirst = 0; forcedFirst < 4; forcedFirst++) {
              try {
                placeFloorGraph2d([n1, n2, cap], new ForcedFirstDrawPrng(1, forcedFirst));
              } catch (e) {
                failures.push(`${n1.id},${n2.id},${cap.id} forcedFirst=${forcedFirst} :: ${(e as Error).message}`);
              }
            }
          }
        }
      }
      expect(failures).toEqual([]);
    });
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

  /**
   * Every field of a drawn passage lands on a whole grid cell (`ENGINE_VERSION` 44).
   * This is not cosmetic. `DOOR_EDGE_MARGIN_GRID` is 1.5 and the anchor step is
   * `span / 4`, so an unsnapped anchor can land on a HALF or a QUARTER cell —
   * `carveDoorGaps` then cuts a correspondingly misaligned hole, and whatever is
   * left of the wall run past it inherits the offset as its own depth. That is how
   * shipped level-1 content ended up with four 32x16 wall runs where every other
   * wall on all five floors is a full 32x32 (see
   * `world/rooms/emberLevel1.test.ts`'s "no wall run is thinner than one grid
   * cell"). Swept over both placement paths and every direction `placeFloorGraph2d`
   * can hop in, because the two used to carry separate copies of this math.
   */
  it("a drawn door's passageGrid lands on whole grid cells, on both placement paths", () => {
    const seeds = [1, 100000, 5000000, 999999999, 123456789, 555555555, 42, 7, 88888, 314159265];
    const offenders: string[] = [];
    for (const seed of seeds) {
      const linear = new Prng(seed);
      linear.nextInt(1000); // same warmup convention as the spread test above
      const graph = new Prng(seed);
      graph.nextInt(1000);
      const drawn = [
        ...placeFloor([HALL, NARROW, EXTRACTION], linear).doors,
        // CROSS carries all four exits, so this chain exercises north/south hops
        // (band = X overlap) as well as the east/west ones placeFloor covers.
        ...placeFloorGraph2d([HALL, CROSS, NARROW, EXTRACTION], graph).doors,
      ];
      expect(drawn.length).toBeGreaterThan(0);
      for (const door of drawn) {
        for (const [field, value] of Object.entries(door.passageGrid)) {
          if (!Number.isInteger(value)) offenders.push(`seed ${seed}: passageGrid.${field} = ${value}`);
        }
      }
    }
    expect(offenders).toEqual([]);
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

// ---------------------------------------------------------------------------
// placeFloorGraph2d (design/05, ROADMAP "real 2D graph layout" follow-up) — a
// sibling to placeFloor, driven directly with hand-picked RoomPiece fixtures,
// matching placeFloor's own test style above.
// ---------------------------------------------------------------------------

describe('placeFloorGraph2d', () => {
  it('a spawn room with only ONE exit, chained through west/east-only pieces, places exactly like placeFloor\'s own spine', () => {
    // Every step here has exactly one viable direction (no ambiguity to draw from),
    // so the two functions consume roomgenPrng identically and must agree exactly —
    // matching TEST_LIB's own convention (dungeonrun.test.ts) of giving a spawn
    // piece only the one exit it actually uses to chain forward.
    const start: RoomPiece = {
      id: 'start', sizeGrid: { w: 10, h: 10 }, solids: [], spawns: { player: [{ x: 5, y: 5 }], enemy: [] },
      exits: [{ edge: 'east' }],
    };
    const mid: RoomPiece = {
      id: 'mid', sizeGrid: { w: 10, h: 10 }, solids: [], spawns: { player: [{ x: 5, y: 5 }], enemy: [] },
      exits: [{ edge: 'west' }, { edge: 'east' }],
    };
    const cap: RoomPiece = {
      id: 'cap', role: 'boss', sizeGrid: { w: 10, h: 10 }, solids: [], spawns: { player: [{ x: 5, y: 5 }], enemy: [] },
      exits: [{ edge: 'west' }],
    };
    const g2d = placeFloorGraph2d([start, mid, cap], new Prng(9));
    const lin = placeFloor([start, mid, cap], new Prng(9));
    expect(g2d.placed.map((p) => ({ id: p.id, x: p.offsetXGrid, y: p.offsetYGrid }))).toEqual(
      lin.placed.map((p) => ({ id: p.id, x: p.offsetXGrid, y: p.offsetYGrid })),
    );
    expect(g2d.doors).toEqual(lin.doors);
  });

  it("a spawn room with BOTH west and east can legitimately place its first neighbor to either side — real 2D freedom, not a bug", () => {
    // HALL/NARROW (EMBER_ROOMS) both have west+east; unlike a `placeFloor` spine,
    // the very first room has no entryEdge to exclude, so both its exits are
    // genuinely viable and a direction is drawn — this is the one place a
    // west/east-only pool can actually diverge from 'linear'.
    const west = new Set<boolean>();
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      const { placed } = placeFloorGraph2d([HALL, NARROW], new Prng(seed));
      west.add(placed[1]!.offsetXGrid < placed[0]!.offsetXGrid);
    }
    expect(west.size).toBe(2); // both true and false actually occur across seeds
  });

  it('a piece with a free south exit can place the next room south of it, not just east', () => {
    // CROSS has all 4 exits on both ends, so every direction stays viable regardless
    // of which one the first draw consumes — a real PRNG choice, no dead ends.
    const seenDirs = new Set<string>();
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      const { placed } = placeFloorGraph2d([CROSS, CROSS, CROSS], new Prng(seed));
      const [a, b] = placed;
      if (b!.offsetYGrid < a!.offsetYGrid) seenDirs.add('north');
      else if (b!.offsetYGrid > a!.offsetYGrid) seenDirs.add('south');
      else if (b!.offsetXGrid > a!.offsetXGrid) seenDirs.add('east');
      else seenDirs.add('west');
    }
    // Real variety across seeds — not just always 'east' — proves direction is
    // actually drawn, not hardcoded to the old spine.
    expect(seenDirs.size).toBeGreaterThan(1);
  });

  it('places the next room directly south when south is the only viable direction', () => {
    const SOUTH_ONLY: RoomPiece = {
      id: 'south_only', sizeGrid: { w: 10, h: 10 }, solids: [],
      spawns: { player: [{ x: 5, y: 5 }], enemy: [] }, exits: [{ edge: 'south' }],
    };
    const NORTH_CAP: RoomPiece = {
      id: 'north_cap', role: 'boss', sizeGrid: { w: 10, h: 10 }, solids: [],
      spawns: { player: [{ x: 5, y: 5 }], enemy: [] }, exits: [{ edge: 'north' }],
    };
    const { placed, doors } = placeFloorGraph2d([SOUTH_ONLY, NORTH_CAP], new Prng(1));
    const [a, b] = placed;
    expect(b!.offsetXGrid).toBe(a!.offsetXGrid); // centered, same width → same X
    expect(b!.offsetYGrid).toBe(a!.offsetYGrid + SOUTH_ONLY.sizeGrid.h);
    expect(doors).toHaveLength(1);
    expect(doors[0]!.passageGrid.w).toBeGreaterThan(doors[0]!.passageGrid.h); // a horizontal (N/S-wall) passage
  });

  it('places the next room directly north when north is the only viable direction', () => {
    const NORTH_ONLY: RoomPiece = {
      id: 'north_only', sizeGrid: { w: 10, h: 10 }, solids: [],
      spawns: { player: [{ x: 5, y: 5 }], enemy: [] }, exits: [{ edge: 'north' }],
    };
    const SOUTH_CAP: RoomPiece = {
      id: 'south_cap', role: 'boss', sizeGrid: { w: 10, h: 10 }, solids: [],
      spawns: { player: [{ x: 5, y: 5 }], enemy: [] }, exits: [{ edge: 'south' }],
    };
    const { placed } = placeFloorGraph2d([NORTH_ONLY, SOUTH_CAP], new Prng(1));
    const [a, b] = placed;
    expect(b!.offsetYGrid).toBe(a!.offsetYGrid - NORTH_ONLY.sizeGrid.h);
  });

  it('never leaves a negative offset on any room, even after a north/west hop off the origin-pinned spawn room (bug report: door unlocks with foes:0 but is physically unreachable)', () => {
    // Regression: `placeAdjacent2d`'s 'north'/'west' cases subtract the new
    // piece's own size off the spawn room's offset (0), which used to land the
    // second room at a NEGATIVE offset. `buildFloorGeometry`'s worldW/worldH is a
    // running max seeded at 0 (blind to negative extents) and `MovementSystem
    // .clampToWorld` hard-clamps to `[margin, worldW - margin]` with no bound
    // below 0 — so a player could never actually walk into (or even fully reach
    // the door of) a negative-offset room, despite the door itself correctly
    // unlocking. The floor-wide shift this test guards must put EVERY room's
    // offset — and its own connecting door's passage rect, and its entranceGrid
    // — at >= 0 on both axes, while leaving every relative adjacency intact.
    const NORTH_ONLY: RoomPiece = {
      id: 'ro_north_only', sizeGrid: { w: 10, h: 10 }, solids: [],
      spawns: { player: [{ x: 5, y: 5 }], enemy: [] }, exits: [{ edge: 'north' }],
    };
    const SOUTH_CAP: RoomPiece = {
      id: 'ro_south_cap', role: 'boss', sizeGrid: { w: 10, h: 10 }, solids: [],
      spawns: { player: [{ x: 5, y: 5 }], enemy: [] }, exits: [{ edge: 'south' }],
    };
    const { placed, doors } = placeFloorGraph2d([NORTH_ONLY, SOUTH_CAP], new Prng(1));
    for (const room of placed) {
      expect(room.offsetXGrid).toBeGreaterThanOrEqual(0);
      expect(room.offsetYGrid).toBeGreaterThanOrEqual(0);
      expect(room.entranceGrid.x).toBeGreaterThanOrEqual(0);
      expect(room.entranceGrid.y).toBeGreaterThanOrEqual(0);
    }
    for (const door of doors) {
      expect(door.passageGrid.x).toBeGreaterThanOrEqual(0);
      expect(door.passageGrid.y).toBeGreaterThanOrEqual(0);
    }
    // The relative adjacency (the thing this whole module computes) is unaffected
    // by the shift — room 1 is still exactly one room-height north of room 0.
    const [a, b] = placed;
    expect(a!.offsetYGrid - b!.offsetYGrid).toBe(NORTH_ONLY.sizeGrid.h);

    // And every room's full footprint now lands inside buildFloorGeometry's own
    // worldW/worldH — the actual bound MovementSystem.clampToWorld enforces — so
    // no room (and no door on its boundary) is ever out of physical reach.
    const geo = buildFloorGeometry(placed, doors);
    for (const room of placed) {
      expect(toFpGrid(room.offsetXGrid + room.piece.sizeGrid.w)).toBeLessThanOrEqual(geo.worldW);
      expect(toFpGrid(room.offsetYGrid + room.piece.sizeGrid.h)).toBeLessThanOrEqual(geo.worldH);
    }
  });

  it('gives every placed room a floor-unique id even if the same piece is drawn twice', () => {
    const { placed } = placeFloorGraph2d([HALL, HALL], new Prng(1));
    expect(placed[0]!.id).toBe('ember_hall#0');
    expect(placed[1]!.id).toBe('ember_hall#1');
  });

  it('is deterministic for a given seed', () => {
    const a = placeFloorGraph2d([CROSS, CROSS, CROSS], new Prng(21));
    const b = placeFloorGraph2d([CROSS, CROSS, CROSS], new Prng(21));
    expect(a.placed.map((p) => ({ id: p.id, x: p.offsetXGrid, y: p.offsetYGrid }))).toEqual(
      b.placed.map((p) => ({ id: p.id, x: p.offsetXGrid, y: p.offsetYGrid })),
    );
    expect(a.doors).toEqual(b.doors);
  });

  it('throws (fail loud) when no exit on the previous room is compatible with the next piece', () => {
    expect(() => placeFloorGraph2d([HALL, NO_EXIT], new Prng(1))).toThrow(/no exit compatible/i);
  });

  it('throws (fail loud) when two adjacent rooms are too small/mismatched to fit a door', () => {
    expect(() => placeFloorGraph2d([TINY, TINY], new Prng(1))).toThrow(/too small/i);
  });

  it('throws (fail loud) on an empty stage list', () => {
    expect(() => placeFloorGraph2d([], new Prng(1))).toThrow(/empty stage list/i);
  });

  it('throws (fail loud) when a direction sequence folds the floor back onto an earlier room', () => {
    // A fully-forced square loop (each room offers exactly one viable outgoing
    // direction, so this needs no PRNG luck — deterministic for any seed):
    // ROOM0 --east--> ROOM1 --south--> ROOM2 --west--> ROOM3 --north--> ROOM4,
    // and since every room is the same 16x16 size, ROOM4 lands EXACTLY on ROOM0's
    // own footprint.
    const ROOM0: RoomPiece = {
      id: 'r0', sizeGrid: { w: 16, h: 16 }, solids: [], spawns: { player: [{ x: 8, y: 8 }], enemy: [] },
      exits: [{ edge: 'east' }],
    };
    const ROOM1: RoomPiece = {
      id: 'r1', sizeGrid: { w: 16, h: 16 }, solids: [], spawns: { player: [{ x: 8, y: 8 }], enemy: [] },
      exits: [{ edge: 'west' }, { edge: 'south' }],
    };
    const ROOM2: RoomPiece = {
      id: 'r2', sizeGrid: { w: 16, h: 16 }, solids: [], spawns: { player: [{ x: 8, y: 8 }], enemy: [] },
      exits: [{ edge: 'north' }, { edge: 'west' }],
    };
    const ROOM3: RoomPiece = {
      id: 'r3', sizeGrid: { w: 16, h: 16 }, solids: [], spawns: { player: [{ x: 8, y: 8 }], enemy: [] },
      exits: [{ edge: 'east' }, { edge: 'north' }],
    };
    const ROOM4: RoomPiece = {
      id: 'r4', role: 'boss', sizeGrid: { w: 16, h: 16 }, solids: [], spawns: { player: [{ x: 8, y: 8 }], enemy: [] },
      exits: [{ edge: 'south' }],
    };
    expect(() => placeFloorGraph2d([ROOM0, ROOM1, ROOM2, ROOM3, ROOM4], new Prng(1))).toThrow(/overlaps already-placed/i);
  });

  it("direction-retry: falls back past TWO overlapping candidates to the one viable direction that doesn't overlap (design/05, 2026-08-05 'graph2d content' follow-up)", () => {
    // Hand-verified geometry (see world/rooms/ember.ts's module doc for how this
    // was actually found — ember_boss overhanging past a shorter room it bent
    // off of). START --east--> MID --?--> CAP: CAP is wider than MID, so a
    // north OR south hop both center it back over part of START's own
    // footprint (touching MID only, never overlapping MID itself, since MID's
    // own N/S edges sit strictly inside START's Y-range) — only 'east'
    // (continuing away from START) is actually clear. All 3 room pairs satisfy
    // the door-fit minimum (shared band >= `DOOR_EDGE_MARGIN_GRID*2 +
    // DOOR_WIDTH_GRID` = 7) so `pickDoorAnchor2d` never rejects the eventual
    // real connection.
    const START: RoomPiece = {
      id: 'start', sizeGrid: { w: 10, h: 10 }, solids: [], spawns: { player: [{ x: 5, y: 5 }], enemy: [] },
      exits: [{ edge: 'east' }],
    };
    const MID: RoomPiece = {
      id: 'mid', sizeGrid: { w: 8, h: 8 }, solids: [], spawns: { player: [{ x: 4, y: 4 }], enemy: [] },
      exits: [{ edge: 'west' }, { edge: 'north' }, { edge: 'south' }, { edge: 'east' }],
    };
    const CAP: RoomPiece = {
      id: 'cap', role: 'boss', sizeGrid: { w: 14, h: 8 }, solids: [], spawns: { player: [{ x: 7, y: 4 }], enemy: [] },
      exits: [{ edge: 'south' }, { edge: 'north' }, { edge: 'west' }],
    };
    class ForceNorthFirst extends Prng {
      private consumed = false;
      override nextInt(max: number): number {
        if (!this.consumed) {
          this.consumed = true;
          return 0; // 'north' is viable[0] (MID's own exits order, minus entryEdge 'west')
        }
        return super.nextInt(max);
      }
    }
    const { placed } = placeFloorGraph2d([START, MID, CAP], new ForceNorthFirst(1));
    const cap = placed[2]!;
    expect(cap.piece.id).toBe('cap');
    expect({ x: cap.offsetXGrid, y: cap.offsetYGrid }).toEqual({ x: 18, y: 1 }); // 'east' — the one non-overlapping option
  });

  it('doors connect stages in order — roomA/roomB match the chain, not just a count', () => {
    const { placed, doors } = placeFloorGraph2d([HALL, HALL, HALL], new Prng(1));
    expect(doors).toHaveLength(2);
    doors.forEach((d, i) => {
      expect(d.roomA).toBe(placed[i]!.id);
      expect(d.roomB).toBe(placed[i + 1]!.id);
    });
  });

  it("a non-entrance room's entranceGrid comes from entranceFromDoor, off its OWN connecting door (east/west)", () => {
    const { placed, doors } = placeFloorGraph2d([HALL, HALL], new Prng(1));
    const door = doors[0]!;
    // HALL/HALL going east: a vertical (east/west-wall) passage, w <= h — inset
    // along X off whichever side of room 1's own center the door falls on, same
    // math `entranceFromDoor` already applies for placeAuthoredFloor.
    const room1 = placed[1]!;
    const roomCenterX = room1.offsetXGrid + room1.piece.sizeGrid.w / 2;
    const doorCenterX = door.passageGrid.x + door.passageGrid.w / 2;
    const expectedX =
      doorCenterX <= roomCenterX ? room1.offsetXGrid + 1.5 : room1.offsetXGrid + room1.piece.sizeGrid.w - 1.5; // 1.5 === ENTRANCE_INSET_GRID
    expect(room1.entranceGrid).toEqual({ x: expectedX, y: door.passageGrid.y + door.passageGrid.h / 2 });
  });

  it("a non-entrance room's entranceGrid insets along Y for a north/south connection", () => {
    const SOUTH_ONLY: RoomPiece = {
      id: 'south_only2', sizeGrid: { w: 10, h: 10 }, solids: [],
      spawns: { player: [{ x: 5, y: 5 }], enemy: [] }, exits: [{ edge: 'south' }],
    };
    const NORTH_CAP: RoomPiece = {
      id: 'north_cap2', role: 'boss', sizeGrid: { w: 10, h: 10 }, solids: [],
      spawns: { player: [{ x: 5, y: 5 }], enemy: [] }, exits: [{ edge: 'north' }],
    };
    const { placed, doors } = placeFloorGraph2d([SOUTH_ONLY, NORTH_CAP], new Prng(1));
    const door = doors[0]!;
    const room1 = placed[1]!;
    // A horizontal (north/south-wall) passage sits on room1's own NORTH wall here
    // (room1 is south of room0) — inset down by ENTRANCE_INSET_GRID, x unchanged.
    expect(room1.entranceGrid).toEqual({ x: door.passageGrid.x + door.passageGrid.w / 2, y: room1.offsetYGrid + 1.5 });
  });

  it('the spawn room falls back to an inset/size-half entranceGrid when it authored no player spawn', () => {
    const noSpawnStart: RoomPiece = {
      id: 'no_spawn_start', sizeGrid: { w: 10, h: 10 }, solids: [], spawns: { player: [], enemy: [] },
      exits: [{ edge: 'east' }],
    };
    const cap: RoomPiece = {
      id: 'g2_cap2', role: 'boss', sizeGrid: { w: 8, h: 8 }, solids: [], spawns: { player: [{ x: 4, y: 4 }], enemy: [] },
      exits: [{ edge: 'west' }],
    };
    const { placed } = placeFloorGraph2d([noSpawnStart, cap], new Prng(1));
    // 1.5 === ENTRANCE_INSET_GRID (an internal, unexported module constant).
    expect(placed[0]!.entranceGrid).toEqual({ x: 0 + 1.5, y: noSpawnStart.sizeGrid.h / 2 });
  });

  it("a door's passage is not pinned to one fixed anchor across seeds, for both an east and a south connection", () => {
    const seenEastY = new Set<number>();
    const seenSouthX = new Set<number>();
    const SOUTH_ONLY: RoomPiece = {
      id: 'south_only3', sizeGrid: { w: 14, h: 10 }, solids: [],
      spawns: { player: [{ x: 5, y: 5 }], enemy: [] }, exits: [{ edge: 'south' }],
    };
    const NORTH_CAP: RoomPiece = {
      id: 'north_cap3', role: 'boss', sizeGrid: { w: 20, h: 10 }, solids: [],
      spawns: { player: [{ x: 5, y: 5 }], enemy: [] }, exits: [{ edge: 'north' }],
    };
    for (const seed of [1, 100000, 5000000, 999999999, 123456789, 555555555, 42, 7, 88888, 314159265]) {
      const eastPrng = new Prng(seed);
      eastPrng.nextInt(1000); // warmup — same LCG low-order-bits convention placeFloor's own spread test uses
      seenEastY.add(placeFloorGraph2d([HALL, NARROW], eastPrng).doors[0]!.passageGrid.y);

      const southPrng = new Prng(seed);
      southPrng.nextInt(1000);
      seenSouthX.add(placeFloorGraph2d([SOUTH_ONLY, NORTH_CAP], southPrng).doors[0]!.passageGrid.x);
    }
    expect(seenEastY.size).toBeGreaterThan(1);
    expect(seenSouthX.size).toBeGreaterThan(1);
  });

  it('a direction is drawn ONLY when more than one exit is viable — exactly 1 roomgenPrng draw per door otherwise', () => {
    class CountingPrng extends Prng {
      calls = 0;
      override nextInt(max: number): number {
        this.calls++;
        return super.nextInt(max);
      }
    }
    // Forced single-direction chain (south only viable at every step) — every door
    // should cost exactly the ONE anchor draw, never a direction draw too.
    const SOUTH_ONLY: RoomPiece = {
      id: 'cnt_south', sizeGrid: { w: 10, h: 10 }, solids: [],
      spawns: { player: [{ x: 5, y: 5 }], enemy: [] }, exits: [{ edge: 'south' }],
    };
    const NORTH_CAP: RoomPiece = {
      id: 'cnt_cap', role: 'boss', sizeGrid: { w: 10, h: 10 }, solids: [],
      spawns: { player: [{ x: 5, y: 5 }], enemy: [] }, exits: [{ edge: 'north' }],
    };
    const forced = new CountingPrng(1);
    placeFloorGraph2d([SOUTH_ONLY, NORTH_CAP], forced);
    expect(forced.calls).toBe(1); // 1 door, single viable direction → anchor draw only

    // CROSS→CROSS: the very first hop has 4 genuinely viable directions (no
    // entryEdge to exclude on the spawn room) → 1 direction draw + 1 anchor draw.
    const ambiguous = new CountingPrng(1);
    placeFloorGraph2d([CROSS, CROSS], ambiguous);
    expect(ambiguous.calls).toBe(2);
  });
});

describe('generateFloor — graph2d layout (design/05, ROADMAP "real 2D graph layout" follow-up)', () => {
  const GRAPH2D: DungeonConfig = { ...CONFIG, layout: 'graph2d' };

  it('selects the exact same stage/piece sequence as linear (selection is unchanged)', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const lin = generateFloor({ ...CONFIG, layout: 'linear' }, 0, new Prng(seed), EMBER_ROOMS).rooms.map((r) => r.id);
      const g2d = generateFloor(GRAPH2D, 0, new Prng(seed), EMBER_ROOMS).rooms.map((r) => r.id);
      expect(g2d).toEqual(lin);
    }
  });

  it('never forks (every stage stays a single RoomPiece, never a sibling array)', () => {
    const f = generateFloor(GRAPH2D, 0, new Prng(42), EMBER_ROOMS);
    for (const s of f.stages) expect(Array.isArray(s)).toBe(false);
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

  it('keeps `freeStanding` on every residual piece, and never invents it (v47)', () => {
    // A carved piece is still the same solid it came out of, so it keeps the flag that decides
    // whether `MovementSystem` gives its north face the v47 brim. Untested, this is invisible: a
    // door only ever cuts a PERIMETER ring on the shipped maps, which carries no flag, so a
    // dropped copy would leave every current test green and only surface the day a passage
    // clipped a kit block — as one block that silently lost its brim, in one room, on one map.
    // All four residual shapes are exercised: a hole in the middle of a wall produces the
    // left/right pair, and a hole overhanging one end produces a top/bottom strip.
    const block = { ...fpRect(0, 0, 10, 100), freeStanding: true as const };
    const bisected = carveDoorGaps([block], [fpRect(-5, 40, 20, 20)]);
    expect(bisected).toHaveLength(2);
    expect(bisected.every((r) => r.freeStanding === true)).toBe(true);

    const wide = { ...fpRect(0, 0, 100, 10), freeStanding: true as const };
    const clipped = carveDoorGaps([wide], [fpRect(40, -5, 20, 8)]);
    expect(clipped.length).toBeGreaterThanOrEqual(3);
    expect(clipped.every((r) => r.freeStanding === true)).toBe(true);

    // ...and the other direction, which matters just as much: a perimeter wall must not come out
    // of the carve claiming to be free-standing, or every door frame on the map grows a brim.
    const perimeter = fpRect(0, 0, 10, 100);
    for (const piece of carveDoorGaps([perimeter], [fpRect(-5, 40, 20, 20)])) {
      expect(piece.freeStanding).toBeUndefined();
    }
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

  /**
   * The authored-floor twin of this lives in `world/rooms/emberLevel1.test.ts` and
   * is the gate the four 16 px-deep wall runs actually needed. This is the same
   * property on the GENERATED path, asserted on the stitched output rather than on
   * the passage rects that feed it: integral passages are the mechanism, but "no
   * wall run comes out thinner than one grid cell" is the thing the standing-wall
   * art depends on, and it can also be broken from the other side — a fractional
   * `solids` rect or a half-cell room offset would land here too.
   */
  it('no wall run out of a generated floor is thinner than one grid cell, or lands off-grid', () => {
    const offenders: string[] = [];
    for (const seed of [1, 100000, 5000000, 999999999, 123456789, 555555555, 42, 7, 88888, 314159265]) {
      const linear = new Prng(seed);
      linear.nextInt(1000);
      const graph = new Prng(seed);
      graph.nextInt(1000);
      for (const [label, placement] of [
        ['placeFloor', placeFloor([HALL, NARROW, EXTRACTION], linear)],
        ['placeFloorGraph2d', placeFloorGraph2d([HALL, CROSS, NARROW, EXTRACTION], graph)],
      ] as const) {
        const { walls } = buildFloorGeometry(placement.placed, placement.doors);
        expect(walls.length).toBeGreaterThan(0);
        const cell = toFpGrid(1);
        for (const w of walls) {
          if (w.w < cell || w.h < cell || [w.x, w.y, w.w, w.h].some((v) => v % cell !== 0)) {
            offenders.push(`${label} seed ${seed}: ${w.w / cell}x${w.h / cell} @ (${w.x / cell}, ${w.y / cell})`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
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
