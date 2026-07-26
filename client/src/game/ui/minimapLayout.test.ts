import { describe, it, expect } from 'vitest';
import type { ArenaMap } from '@dd/engine/content/arenas';
import type { ZoneState } from '@dd/engine';
import { computeMinimapLayout, roomStatus } from './minimapLayout';

// Mirrors client/src/engine/content/arenas.test.ts's fixture shape (three rooms far
// apart) so this pure layout math is exercised against the same kind of ArenaMap the
// engine-side tests already trust.
const ARENA: ArenaMap = {
  id: 'test_arena',
  sizeGrid: { w: 200, h: 200 },
  rooms: [
    { id: 'A', rectGrid: { x: 0, y: 0, w: 10, h: 10 }, solids: [] },
    { id: 'B', rectGrid: { x: 100, y: 0, w: 10, h: 10 }, solids: [] },
    { id: 'C', rectGrid: { x: 0, y: 100, w: 20, h: 20 }, solids: [] },
  ],
  doors: [
    { roomA: 'A', roomB: 'B', passageGrid: { x: 10, y: 4, w: 1, h: 2 } },
    { roomA: 'A', roomB: 'C', passageGrid: { x: 4, y: 10, w: 2, h: 1 } },
  ],
  spawns: [],
  eyeCandidates: [{ roomId: 'A' }],
};

describe('computeMinimapLayout', () => {
  it('fits every room into the box at a uniform, aspect-preserving scale', () => {
    const { rooms } = computeMinimapLayout(ARENA, { w: 100, h: 100 });
    expect(rooms).toHaveLength(3);
    const a = rooms.find((r) => r.id === 'A')!;
    const b = rooms.find((r) => r.id === 'B')!;
    const c = rooms.find((r) => r.id === 'C')!;
    // scale = min(100/200, 100/200) = 0.5, no letterboxing offset for a square map.
    expect(a).toEqual({ id: 'A', x: 0, y: 0, w: 5, h: 5 });
    expect(b).toEqual({ id: 'B', x: 50, y: 0, w: 5, h: 5 });
    expect(c).toEqual({ id: 'C', x: 0, y: 50, w: 10, h: 10 });
  });

  it('letterboxes (centres) a non-square map inside a square box', () => {
    const wide: ArenaMap = { ...ARENA, sizeGrid: { w: 400, h: 200 } };
    const { rooms } = computeMinimapLayout(wide, { w: 100, h: 100 });
    // scale = min(100/400, 100/200) = 0.25 → mapH*scale = 50, centred: offY = 25.
    const a = rooms.find((r) => r.id === 'A')!;
    expect(a.x).toBeCloseTo(0);
    expect(a.y).toBeCloseTo(25);
  });

  it('draws a line between every door\'s two room centres, skipping malformed doors', () => {
    const { doors } = computeMinimapLayout(ARENA, { w: 100, h: 100 });
    expect(doors).toHaveLength(2);
    // A's centre (2.5,2.5) — B's centre (52.5,2.5) at this scale.
    expect(doors[0]).toEqual({ x1: 2.5, y1: 2.5, x2: 52.5, y2: 2.5 });

    const withBadDoor: ArenaMap = { ...ARENA, doors: [...ARENA.doors, { roomA: 'A', roomB: 'ghost', passageGrid: { x: 0, y: 0, w: 1, h: 1 } }] };
    const { doors: doors2 } = computeMinimapLayout(withBadDoor, { w: 100, h: 100 });
    expect(doors2).toHaveLength(2); // the malformed door referencing 'ghost' is skipped, not thrown
  });

  it('collapses to zero-scale (not NaN/Infinity) for a degenerate zero-size map', () => {
    const degenerate: ArenaMap = { ...ARENA, sizeGrid: { w: 0, h: 0 } };
    const { rooms } = computeMinimapLayout(degenerate, { w: 100, h: 100 });
    expect(rooms.every((r) => Number.isFinite(r.x) && Number.isFinite(r.w))).toBe(true);
  });
});

describe('roomStatus', () => {
  const baseZone: ZoneState = { eye: 'A', stage: 1, phase: 'hold', ticksToPhaseEnd: 100, safe: ['A'], closing: [], escalation: 0 };

  it('is "safe" when no zone has been drawn yet (pre-match / non-arena)', () => {
    expect(roomStatus(undefined, 'A')).toBe('safe');
  });

  it('is "safe" when the room is in the current safe set', () => {
    expect(roomStatus(baseZone, 'A')).toBe('safe');
  });

  it('is "danger" when outside the safe set and not currently closing', () => {
    expect(roomStatus(baseZone, 'B')).toBe('danger');
  });

  it('is "closing" only during the warn phase, for rooms in `closing`', () => {
    const warning: ZoneState = { ...baseZone, phase: 'warn', closing: ['B'] };
    expect(roomStatus(warning, 'B')).toBe('closing');
    expect(roomStatus(warning, 'A')).toBe('safe');
    // The same `closing` list during 'hold' (already resolved) no longer marks a warn.
    const held: ZoneState = { ...warning, phase: 'hold', safe: ['A'] };
    expect(roomStatus(held, 'B')).toBe('danger');
  });
});
