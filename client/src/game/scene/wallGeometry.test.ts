/**
 * `wallRises` — the rule deciding which walls stand up (design/01's front face) and which
 * stay flat on the ground. Pure geometry, so it is tested directly here; RoomBuilder.test
 * covers what the drawing side then does with the answer.
 *
 * Every rect below is world px. The room is 480×480 at (0, 0) with 32 px walls, which is
 * level 1's actual shape (15 grid × 32 px/grid).
 */
import { describe, it, expect } from 'vitest';
import { wallRises, WALL_HEIGHT, type RectPx } from './wallGeometry';

const ROOM: RectPx = { x: 0, y: 0, w: 480, h: 480 };
const ROOMS = [ROOM];

describe('wallRises', () => {
  it('stands a north wall up — the one whose face the camera actually sees', () => {
    expect(wallRises({ x: 0, y: 0, w: 480, h: 32 }, ROOMS)).toBe(true);
  });

  it('keeps the room\'s own south wall flat, so it never stands between camera and player', () => {
    expect(wallRises({ x: 0, y: 448, w: 480, h: 32 }, ROOMS)).toBe(false);
  });

  it('keeps a north-south run (the east/west sides) flat whatever its position', () => {
    // Tall and thin: standing it up shows almost nothing but its cap, offset off its own
    // footprint. Both a full-height run and a short segment between doorways stay flat.
    expect(wallRises({ x: 448, y: 32, w: 32, h: 416 }, ROOMS)).toBe(false);
    expect(wallRises({ x: 0, y: 64, w: 32, h: 224 }, ROOMS)).toBe(false);
  });

  it('stands an interior east-west stub up (ember_hall\'s north jetty, ember_cross\'s sides)', () => {
    expect(wallRises({ x: 256, y: 0, w: 128, h: 96 }, ROOMS)).toBe(true);
    expect(wallRises({ x: 0, y: 224, w: 160, h: 64 }, ROOMS)).toBe(true);
  });

  it('treats a square block as a north-south run (not wider than tall → flat)', () => {
    expect(wallRises({ x: 100, y: 100, w: 64, h: 64 }, ROOMS)).toBe(false);
  });

  it('stands a wall belonging to no room up (a corridor segment, or a mode with no rooms)', () => {
    expect(wallRises({ x: 2000, y: 2000, w: 128, h: 32 }, ROOMS)).toBe(true);
    expect(wallRises({ x: 0, y: 0, w: 128, h: 32 }, [])).toBe(true);
  });

  it('picks the containing room out of several, so one room\'s south edge does not flatten another\'s north wall', () => {
    const north: RectPx = { x: 0, y: 0, w: 480, h: 480 }; // rooms stacked vertically
    const south: RectPx = { x: 0, y: 480, w: 480, h: 480 };
    // The south room's north wall sits at y=480..512 — which is exactly the NORTH room's
    // south edge. Resolved against its own room (the south one) it stands; against the
    // wrong one it would read as a south perimeter and flatten.
    expect(wallRises({ x: 0, y: 480, w: 480, h: 32 }, [north, south])).toBe(true);
  });

  it('exports a wall height the camera and the pillars can share', () => {
    expect(WALL_HEIGHT).toBeGreaterThan(0);
  });
});
