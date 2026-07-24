/**
 * Seeded dungeon assembly (design/05/09, ROADMAP 1.3). `generateFloor` is a pure
 * function — not yet wired into GameEngine — so these tests drive it directly
 * with a real `Prng` (matching GameState's own construction pattern) rather than
 * a live GameState.
 */
import { describe, it, expect } from 'vitest';
import { Prng } from '@dd/engine/math/prng';
import { curveAt, generateFloor, type DungeonConfig } from '@dd/engine/world/dungeon';
import { EMBER_ROOMS } from '@dd/engine/world/rooms/ember';
import type { RoomPiece } from '@dd/engine/content/rooms';

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
