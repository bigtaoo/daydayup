/**
 * `wallTier`/`wallHeight` — the rule deciding how tall each wall segment stands (design/01's
 * front face). Pure geometry, so it is tested directly here; RoomBuilder.test and
 * wallRender.test cover what the drawing side then does with the answer.
 *
 * Replaced the boolean `wallRises` on 2026-08-18. The cases that used to assert FLAT for a
 * north-south run and for a square block are kept below, inverted: those were the exclusions
 * that left level 1's rooms looking painted on, and they are now the regression guard in the
 * other direction (see `wallTier`'s own doc for the whole account).
 *
 * Every rect below is world px. The room is 480×480 at (0, 0) with 32 px walls, which is
 * level 1's actual shape (15 grid × 32 px/grid).
 */
import { describe, it, expect } from 'vitest';
import {
  wallTier,
  wallHeight,
  WALL_HEIGHT,
  WALL_H_PERIMETER,
  WALL_H_INTERIOR,
  WALL_H_KERB,
  MAX_WALL_HEIGHT,
  type RectPx,
} from './wallGeometry';

const ROOM: RectPx = { x: 0, y: 0, w: 480, h: 480 };
const ROOMS = [ROOM];

describe('wallTier', () => {
  it('makes a north wall the tall perimeter — the one whose face the camera actually sees', () => {
    expect(wallTier({ x: 0, y: 0, w: 480, h: 32 }, ROOMS)).toBe('perimeter');
  });

  it('makes the room\'s own south wall a low kerb, so it never stands between camera and player', () => {
    expect(wallTier({ x: 0, y: 448, w: 480, h: 32 }, ROOMS)).toBe('kerb');
  });

  it('stands a north-south run up as perimeter — it used to be excluded entirely', () => {
    // Both a full-height east side and a short west segment between doorways. These are the
    // walls `ember_l1_gallery` is almost entirely made of (1×16 grid runs), and the old
    // `w > h` rule flattened every one of them.
    expect(wallTier({ x: 448, y: 32, w: 32, h: 416 }, ROOMS)).toBe('perimeter');
    expect(wallTier({ x: 0, y: 64, w: 32, h: 224 }, ROOMS)).toBe('perimeter');
  });

  it('stands an interior stub up at the shorter interior height, whichever way it runs', () => {
    // An east-west jetty and a north-south one, neither touching a room edge.
    expect(wallTier({ x: 128, y: 224, w: 160, h: 64 }, ROOMS)).toBe('interior');
    expect(wallTier({ x: 224, y: 128, w: 64, h: 160 }, ROOMS)).toBe('interior');
  });

  it('stands a square interior block up — `ember_l1_kiln`\'s four 2×2 blocks', () => {
    // The case the old rule read as "not wider than tall → flat". Every interior solid in
    // the shipped kiln room is one of these, so the room had nothing standing in it at all.
    expect(wallTier({ x: 128, y: 128, w: 64, h: 64 }, ROOMS)).toBe('interior');
  });

  it('counts a stub that reaches a room edge as perimeter, not interior', () => {
    expect(wallTier({ x: 256, y: 0, w: 128, h: 96 }, ROOMS)).toBe('perimeter'); // touches north
    expect(wallTier({ x: 0, y: 200, w: 96, h: 64 }, ROOMS)).toBe('perimeter'); // touches west
    expect(wallTier({ x: 384, y: 200, w: 96, h: 64 }, ROOMS)).toBe('perimeter'); // touches east
  });

  it('treats a wall belonging to no room as perimeter (a corridor segment, or a mode with no rooms)', () => {
    expect(wallTier({ x: 2000, y: 2000, w: 128, h: 32 }, ROOMS)).toBe('perimeter');
    expect(wallTier({ x: 0, y: 0, w: 128, h: 32 }, [])).toBe('perimeter');
  });

  it('picks the containing room out of several, so one room\'s south edge does not kerb another\'s north wall', () => {
    const north: RectPx = { x: 0, y: 0, w: 480, h: 480 }; // rooms stacked vertically
    const south: RectPx = { x: 0, y: 480, w: 480, h: 480 };
    // The south room's north wall sits at y=480..512 — which is exactly the NORTH room's
    // south edge. Resolved against its own room (the south one) it is a full-height
    // perimeter; against the wrong one it would drop to a kerb.
    expect(wallTier({ x: 0, y: 480, w: 480, h: 32 }, [north, south])).toBe('perimeter');
  });

  it('allows a grid cell of slack at every edge, for the fixed-point → px conversion', () => {
    // 3 px shy of each edge on all four sides — still the perimeter, not a floating block.
    expect(wallTier({ x: 3, y: 3, w: 474, h: 32 }, ROOMS)).toBe('perimeter');
    expect(wallTier({ x: 0, y: 451, w: 480, h: 26 }, ROOMS)).toBe('kerb');
  });
});

describe('wallHeight', () => {
  it('makes a room\'s boundary genuinely tower over the blocks inside it', () => {
    // Height VARIETY is the readable cue — one uniform height for everything vertical gives
    // the eye no relative measure, which is what the flat-looking room report was about.
    expect(wallHeight('perimeter')).toBeGreaterThan(wallHeight('interior'));
    expect(wallHeight('interior')).toBeGreaterThan(wallHeight('kerb'));
  });

  it('maps each tier onto its own exported constant', () => {
    expect(wallHeight('perimeter')).toBe(WALL_H_PERIMETER);
    expect(wallHeight('interior')).toBe(WALL_H_INTERIOR);
    expect(wallHeight('kerb')).toBe(WALL_H_KERB);
  });

  it('keeps a kerb short enough that the player\'s own collision radius clears it', () => {
    // The safety argument for standing the south wall up at all: a wall is 32 px thick and
    // the player cannot overlap it, so their ground point is always >= 32 px north of the
    // south edge. A kerb no taller than that can never reach up to them on screen.
    expect(WALL_H_KERB).toBeLessThanOrEqual(32);
  });

  it('keeps the pillars on the interior wall height, so a block and a pillar agree', () => {
    expect(WALL_HEIGHT).toBe(WALL_H_INTERIOR);
  });

  it('exports the maximum the camera frame has to grow by', () => {
    expect(MAX_WALL_HEIGHT).toBe(Math.max(WALL_H_PERIMETER, WALL_H_INTERIOR, WALL_H_KERB));
  });
});
