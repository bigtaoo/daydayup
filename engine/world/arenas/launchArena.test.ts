/**
 * The launch arena as a whole: the properties that make it a map rather than a data file.
 *
 * These are deliberately stated against the ASSEMBLED map and the shared metrics modules,
 * not against the plan — the plan is a drawing, and every defect the previous arena shipped
 * was a drawing that assembled into something else. `arenaMetrics`/`arenaGeometryMetrics`
 * are the same functions `npm run audit:arena` prints, so a number here and a number in the
 * report can never disagree.
 */
import { describe, it, expect } from 'vitest';
import { LAUNCH_ARENA, buildLaunchArena } from './launchArena';
import { DISTRICTS, DISTRICT_MAP, SPAWN_SLOTS, EYE_SLOTS } from './launchArenaPlan';
import { measureArena } from '../../content/arenaMetrics';
import { measureEnclosure, measurePlacement, solidCellSet } from '../../content/arenaGeometryMetrics';
import { buildArenaGeometry } from '../../content/arenas';

const metrics = measureArena(LAUNCH_ARENA);
const placement = measurePlacement(LAUNCH_ARENA);
const enclosure = measureEnclosure(LAUNCH_ARENA);

describe('the plan and the map agree', () => {
  it('has one room per non-empty slot', () => {
    const authored = DISTRICT_MAP.join('').split('').filter((c) => c !== '.').length;
    expect(authored).toBe(60);
    expect(LAUNCH_ARENA.rooms).toHaveLength(authored);
  });

  it('gives every room a unique id naming its district and slot', () => {
    const ids = LAUNCH_ARENA.rooms.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    const names = Object.values(DISTRICTS).map((d) => d.name);
    for (const id of ids) expect(names).toContain(id.split('_')[0]);
  });

  it('is a pure function of the plan — rebuilding produces an identical map', () => {
    expect(buildLaunchArena()).toEqual(LAUNCH_ARENA);
  });

  it('places every room inside the map extent', () => {
    for (const room of LAUNCH_ARENA.rooms) {
      const r = room.rectGrid;
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(LAUNCH_ARENA.sizeGrid.w);
      expect(r.y + r.h).toBeLessThanOrEqual(LAUNCH_ARENA.sizeGrid.h);
    }
  });

  it('never overlaps two rooms', () => {
    const rects = LAUNCH_ARENA.rooms.map((r) => r.rectGrid);
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!;
        const b = rects[j]!;
        const overlap =
          a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
        expect(overlap).toBe(false);
      }
    }
  });
});

/**
 * The defect class the previous map shipped. Every one of these is 0 there and 0 here — but
 * there it was 0 only because nothing measured it, and the metrics that do measure it were
 * pointed at this map first.
 */
describe('geometry is real', () => {
  it('walls every room and leaves no room unenclosed', () => {
    expect(enclosure.unenclosedRooms).toEqual([]);
    expect(enclosure.solidCells).toBeGreaterThan(2000);
    // A perimeter is never fully closed — a room with no opening would be unreachable — but
    // it is never mostly open either.
    expect(Math.min(...enclosure.perimeterCoverage)).toBeGreaterThan(0.5);
    expect(Math.max(...enclosure.perimeterCoverage)).toBeLessThan(1);
  });

  it('makes every door the only way between its two rooms', () => {
    expect(enclosure.doorsWithoutWalls).toBe(0);
    expect(enclosure.undoorLeaks).toBe(0);
  });

  it('authors every feature in room-relative space, so nothing lands outside its room', () => {
    expect(placement.outsideOwnRoom).toEqual([]);
    expect(placement.offMap).toEqual([]);
    // The counterweight: an empty finding list must mean "checked and clean", not "nothing
    // to check". Every feature kind this map uses has to be represented.
    for (const kind of ['pillar', 'loot', 'trait', 'enemySpawn', 'solid'] as const) {
      expect(placement.byFeature[kind].authored).toBeGreaterThan(0);
    }
  });

  it('never places loot, an enemy spawn or a drop point inside a solid', () => {
    const solids = solidCellSet(LAUNCH_ARENA);
    for (const room of LAUNCH_ARENA.rooms) {
      const abs = (p: { x: number; y: number }) => `${p.x + room.rectGrid.x},${p.y + room.rectGrid.y}`;
      for (const m of room.lootMarkers ?? []) expect(solids.has(abs(m.point))).toBe(false);
      for (const s of room.spawns ?? []) expect(solids.has(abs(s))).toBe(false);
    }
    for (const s of LAUNCH_ARENA.spawns) expect(solids.has(`${s.x},${s.y}`)).toBe(false);
  });

  // A mutation battery left "ignore the target cell, take the first free cell" alive: nothing
  // asserted that content goes WHERE it was aimed, only that it misses the walls. Loot is
  // aimed at the room's middle and enemies at its corners, and that difference is the whole
  // reason a vault pen has anything in it.
  it('aims loot at the middle of the room and enemies at its edges', () => {
    for (const room of LAUNCH_ARENA.rooms) {
      const half = { x: room.rectGrid.w / 2, y: room.rectGrid.h / 2 };
      const centre = { x: (room.rectGrid.w - 1) / 2, y: (room.rectGrid.h - 1) / 2 };
      const offCentre = (p: { x: number; y: number }) =>
        Math.max(Math.abs(p.x - centre.x) / half.x, Math.abs(p.y - centre.y) / half.y);

      const loot = room.lootMarkers?.[0];
      expect(loot).toBeDefined();
      // Never out in the outermost fifth of the room — i.e. never shoved against a wall,
      // which is where "first free cell in scan order" would always put it.
      expect(offCentre(loot!.point)).toBeLessThanOrEqual(0.8);
    }
  });

  // Per ROOM the two aims can invert — a small room whose middle is walled pushes the loot
  // further out than a corner-seeking spawn lands. The claim that holds is distributional,
  // and it is the one the mutant breaks.
  it('separates those two aims across the map', () => {
    const mean = (ns: number[]) => ns.reduce((a, b) => a + b, 0) / ns.length;
    const fractions = (pick: (r: (typeof LAUNCH_ARENA.rooms)[number]) => { x: number; y: number }[]) =>
      LAUNCH_ARENA.rooms.flatMap((room) => {
        const half = { x: room.rectGrid.w / 2, y: room.rectGrid.h / 2 };
        const centre = { x: (room.rectGrid.w - 1) / 2, y: (room.rectGrid.h - 1) / 2 };
        return pick(room).map((p) =>
          Math.max(Math.abs(p.x - centre.x) / half.x, Math.abs(p.y - centre.y) / half.y),
        );
      });
    const loot = mean(fractions((r) => (r.lootMarkers ?? []).map((m) => m.point)));
    const spawns = mean(fractions((r) => r.spawns ?? []));
    expect(spawns).toBeGreaterThan(loot + 0.25);
  });

  it('never places content inside a pillar footprint either', () => {
    for (const room of LAUNCH_ARENA.rooms) {
      for (const pillar of room.pillars ?? []) {
        const reach = Math.ceil(pillar.radius);
        const content = [...(room.lootMarkers ?? []).map((m) => m.point), ...(room.spawns ?? [])];
        for (const p of content) {
          const inside =
            Math.abs(p.x - pillar.center.x) <= reach && Math.abs(p.y - pillar.center.y) <= reach;
          expect(inside).toBe(false);
        }
      }
      // Not a vacuous pass: this map's rooms really do carry both.
      if ((room.pillars ?? []).length > 0) expect((room.lootMarkers ?? []).length).toBeGreaterThan(0);
    }
  });

  it('builds real collision geometry through the engine own stitcher', () => {
    const geo = buildArenaGeometry(LAUNCH_ARENA);
    expect(geo.walls.length).toBeGreaterThan(400);
    expect(geo.obstacles.length).toBeGreaterThan(100);
  });
});

describe('the map is authored, not stamped', () => {
  it('varies room footprints', () => {
    expect(metrics.footprints.distinct).toBeGreaterThanOrEqual(20);
    // No single footprint may dominate — the previous map's was 100%.
    expect(metrics.footprints.dominantShare).toBeLessThan(0.2);
  });

  it('gives every room a different interior, by numbers AND by shape', () => {
    expect(metrics.interiors.distinct).toBe(60);
    // The distinction that caught the previous map: identical shapes at different offsets.
    expect(metrics.interiorShapes.distinct).toBe(60);
  });

  it('gives every room cover without filling it in', () => {
    expect(metrics.cover.roomsWithNoCover).toEqual([]);
    expect(Math.min(...metrics.cover.coverFractions)).toBeGreaterThan(0.1);
    expect(Math.max(...metrics.cover.coverFractions)).toBeLessThan(0.7);
  });

  it('differentiates its loot tables', () => {
    const tables = Object.keys(metrics.lootTables);
    expect(tables.length).toBeGreaterThanOrEqual(3);
    expect(tables).toContain('arena_vault');
  });

  it('populates roughly half its rooms with an encounter, from more than one script', () => {
    expect(metrics.encounters.rooms).toBeGreaterThan(20);
    expect(metrics.encounters.rooms).toBeLessThan(45);
    expect(metrics.encounters.distinct).toBeGreaterThan(3);
  });

  it('puts hazards in more than one district', () => {
    const hazardDistricts = new Set(
      LAUNCH_ARENA.rooms.filter((r) => (r.cellTraits ?? []).length > 0).map((r) => r.id.split('_')[0]),
    );
    expect(hazardDistricts.size).toBeGreaterThan(1);
  });
});

describe('the layout has decisions in it', () => {
  it('is connected, with no isolated room', () => {
    expect(metrics.graph.connected).toBe(true);
    expect(metrics.graph.isolated).toEqual([]);
  });

  it('is deep enough to cross but not a corridor', () => {
    expect(metrics.graph.diameter).toBeGreaterThanOrEqual(10);
    expect(metrics.graph.diameter).toBeLessThanOrEqual(25);
  });

  it('has real chokepoints, and they are a minority of rooms', () => {
    expect(metrics.graph.chokepoints.length).toBeGreaterThan(4);
    expect(metrics.graph.chokepoints.length).toBeLessThan(20);
  });

  it('has dead ends — pockets a fight can corner someone in', () => {
    expect(metrics.graph.deadEnds.length).toBeGreaterThan(2);
  });

  it('offers most rooms more than one way out', () => {
    const single = metrics.graph.degreeHistogram[1] ?? 0;
    expect(single / LAUNCH_ARENA.rooms.length).toBeLessThan(0.25);
  });
});

describe('the drop is fair, and the zone can reach everyone', () => {
  it('places one drop point per authored spawn slot, inside a room', () => {
    expect(LAUNCH_ARENA.spawns).toHaveLength(SPAWN_SLOTS.length);
    expect(metrics.spawns.orphans).toBe(0);
    expect(metrics.spawns.colliding).toBe(0);
  });

  // The check that actually moved the map: a first draft put two seats four hops apart on
  // paper and TWO through the foundry->catacombs artery.
  it('never drops two seats within three door hops of each other', () => {
    expect(metrics.spawns.minPairHops).toBeGreaterThanOrEqual(4);
  });

  it('spreads the drop across the map rather than one district', () => {
    const districts = new Set(SPAWN_SLOTS.map((ref) => {
      const room = LAUNCH_ARENA.rooms.find((r) => r.id.endsWith(`_${ref}`));
      return room?.id.split('_')[0];
    }));
    expect(districts.size).toBeGreaterThanOrEqual(5);
    expect(metrics.spawns.maxPairHops).toBeGreaterThan(metrics.spawns.minPairHops * 2);
  });

  it('never starts a seat in the atrium — the eye of the zone', () => {
    for (const ref of SPAWN_SLOTS) {
      const room = LAUNCH_ARENA.rooms.find((r) => r.id.endsWith(`_${ref}`));
      expect(room?.id.startsWith('atrium')).toBe(false);
    }
  });

  it('offers eye candidates weighted toward the atrium but not confined to it', () => {
    expect(LAUNCH_ARENA.eyeCandidates).toHaveLength(EYE_SLOTS.length);
    const atrium = LAUNCH_ARENA.eyeCandidates.filter((c) => c.roomId.startsWith('atrium'));
    expect(atrium.length).toBeGreaterThan(0);
    expect(atrium.length).toBeLessThan(LAUNCH_ARENA.eyeCandidates.length);
    const atriumWeight = atrium.reduce((sum, c) => sum + (c.weight ?? 1), 0);
    const total = LAUNCH_ARENA.eyeCandidates.reduce((sum, c) => sum + (c.weight ?? 1), 0);
    expect(atriumWeight / total).toBeGreaterThan(0.6);
  });

  it('leaves no room stranded far from every possible final circle', () => {
    expect(metrics.maxHopsToEye).toBeLessThanOrEqual(8);
  });
});
