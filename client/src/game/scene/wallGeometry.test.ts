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
  DOOR_H,
  DOOR_TIER,
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

  it('kerbs the north wall of a room that has another room STACKED ABOVE it', () => {
    // Reversed 2026-08-20, and the reversal is what this pass is. The case used to assert
    // 'perimeter' on the grounds that the wall belongs to the SOUTH room and is that room's
    // own north edge. Both halves of that are true and it is still the wrong answer: the wall
    // stands one grid row south of the NORTH room's floor, which is exactly the ground the
    // kerb tier exists to keep clear, and at `WALL_H_PERIMETER` its art rose 72 px into it.
    // Whose wall it is does not change where it stands.
    const north: RectPx = { x: 0, y: 0, w: 480, h: 480 }; // rooms stacked vertically
    const south: RectPx = { x: 0, y: 480, w: 480, h: 480 };
    expect(wallTier({ x: 0, y: 480, w: 480, h: 32 }, [north, south])).toBe('kerb');
    // ...and the north room's own south wall, the other half of the same boundary, still
    // kerbs for the original reason. A shared boundary is low on both sides or on neither.
    expect(wallTier({ x: 0, y: 448, w: 480, h: 32 }, [north, south])).toBe('kerb');
  });

  it('leaves a north wall at FULL height when the room above does not overlap it', () => {
    // The other side of the same rule, and what stops it flattening the content wholesale:
    // "a room's floor is immediately north of me" means a real horizontal overlap, not a
    // shared corner. Rooms sit edge to edge on these floors, and a plan where every north
    // wall dropped to 22 px would be the flat-room report all over again.
    const room: RectPx = { x: 0, y: 480, w: 480, h: 480 };
    const northEast: RectPx = { x: 480, y: 0, w: 480, h: 480 }; // above the room NEXT DOOR
    expect(wallTier({ x: 0, y: 480, w: 480, h: 32 }, [northEast, room])).toBe('perimeter');
    // A room BELOW cannot kerb anything either — the rule is about floor to the NORTH only.
    const below: RectPx = { x: 0, y: 960, w: 480, h: 480 };
    expect(wallTier({ x: 0, y: 480, w: 480, h: 32 }, [room, below])).toBe('perimeter');
  });

  it('allows the same slack on a boundary abutted from the SOUTH', () => {
    // Clause (b) of the kerb rule is an EQUALITY between two independently converted numbers —
    // the wall's own y and the room's south bound — so it needs the same fixed-point slack every
    // other edge test here gets. A strict equality would work on this content (whole grid cells
    // throughout) and break the first time a piece is authored at a fractional offset, which is
    // exactly the class of failure `EDGE_TOLERANCE` exists for.
    const above: RectPx = { x: 0, y: 0, w: 480, h: 477 }; // south bound 3 px shy of the wall
    const below: RectPx = { x: 0, y: 480, w: 480, h: 480 };
    expect(wallTier({ x: 0, y: 480, w: 480, h: 32 }, [above, below])).toBe('kerb');
    // ...and a full grid cell of separation is a real gap, not slack: there is a corridor between
    // these two rooms, so the lower room's north wall is a proper boundary again.
    const farAbove: RectPx = { x: 0, y: 0, w: 480, h: 448 };
    expect(wallTier({ x: 0, y: 480, w: 480, h: 32 }, [farAbove, below])).toBe('perimeter');
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
    // A door is not a wall tier, but `RoomBuilder` hands it to the joins pass as one, so the pair
    // has to agree — `wallJoins` decides a door's tuck (and therefore whether its cap survives)
    // from the tier's height, not from `DOOR_H`. Nothing else compares them.
    expect(wallHeight(DOOR_TIER)).toBe(DOOR_H);
    // And a door may never out-top the padding `GameLoop.cameraFrame` grows the framed room by.
    expect(DOOR_H).toBeLessThanOrEqual(MAX_WALL_HEIGHT);
  });
});
