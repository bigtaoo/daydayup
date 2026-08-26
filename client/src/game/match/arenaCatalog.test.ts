/** ARENA_CATALOG: the id -> ArenaMap lookup a real PvP match start resolves against (see
 *  arenaCatalog.ts's doc comment for landing_basic vs. arena_launch's roles). Mirrors
 *  pvpConfig.test.ts's plain input->output style. */
import { describe, it, expect } from 'vitest';
import { ARENA_CATALOG, ARENA_IDS, resolveArenaId } from './arenaCatalog';

describe('ARENA_CATALOG', () => {
  it('has exactly the two known arena ids', () => {
    expect(Object.keys(ARENA_CATALOG).sort()).toEqual(['arena_launch', 'landing_basic']);
  });

  // Retired 2026-08-26 with the map itself. Asserted rather than merely deleted because the
  // id is the one thing that outlives a deletion: a `?arena=arena_prototype_60` bookmark, or
  // a stale link in a doc, must land on "unknown id, harness stays off" and not on a silently
  // empty arena — which is exactly what `resolveArenaId` exists to prevent.
  it('no longer carries the retired arena_prototype_60', () => {
    expect(ARENA_IDS).not.toContain('arena_prototype_60');
    expect(resolveArenaId('arena_prototype_60')).toBeNull();
  });

  it('arena_launch is the hand-authored launch map a real PvP match resolves to', () => {
    const arena = ARENA_CATALOG.arena_launch;
    expect(arena.id).toBe('arena_launch');
    expect(arena.rooms).toHaveLength(60);
    // The property the map it replaces did not have: real geometry. Asserted here (not only
    // in the engine's own suite) because this is the object the client actually builds from.
    expect(arena.rooms.every((r) => r.solids.length > 0)).toBe(true);
    expect(arena.spawns.length).toBeGreaterThanOrEqual(8);
  });

  describe('landing_basic', () => {
    const arena = ARENA_CATALOG.landing_basic;

    it('is an L-shaped 3-room fixture with matching id and map extent', () => {
      expect(arena.id).toBe('landing_basic');
      expect(arena.sizeGrid).toEqual({ w: 50, h: 50 });
      expect(arena.rooms).toHaveLength(3);
      expect(arena.rooms.map((r) => r.id)).toEqual(['A', 'B', 'C']);
    });

    it('has no solids in any room and no spawn markers', () => {
      for (const room of arena.rooms) expect(room.solids).toEqual([]);
      expect(arena.spawns).toEqual([]);
    });

    it('connects A-B and A-C with doors, leaving B-C unconnected', () => {
      expect(arena.doors).toHaveLength(2);
      const pairs = arena.doors.map((d) => [d.roomA, d.roomB]);
      expect(pairs).toEqual([
        ['A', 'B'],
        ['A', 'C'],
      ]);
    });

    it('marks every room as an eye-candidate (shrink stays visible in every room)', () => {
      expect(arena.eyeCandidates).toEqual([{ roomId: 'A' }, { roomId: 'B' }, { roomId: 'C' }]);
    });

    it('is a stable object identity — same reference on repeat catalog reads', () => {
      expect(ARENA_CATALOG.landing_basic).toBe(arena);
    });
  });

});

describe('resolveArenaId', () => {
  it('accepts every id the catalog actually has — no hand-kept second list', () => {
    expect(ARENA_IDS.sort()).toEqual(Object.keys(ARENA_CATALOG).sort());
    for (const id of ARENA_IDS) expect(resolveArenaId(id)).toBe(id);
  });

  it('rejects absent, empty and unknown ids', () => {
    expect(resolveArenaId(null)).toBeNull();
    expect(resolveArenaId('')).toBeNull();
    expect(resolveArenaId('arena_prototype_61')).toBeNull();
  });

  it('rejects an inherited Object.prototype key — `includes`, not `in`', () => {
    expect(resolveArenaId('toString')).toBeNull();
    expect(resolveArenaId('constructor')).toBeNull();
  });
});
