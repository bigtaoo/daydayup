/**
 * A synthetic one-room dungeon floor whose only job is to make `config.WALL_NORTH_BRIM`
 * OBSERVABLE in a golden hash.
 *
 * ## Why this exists (read before deleting it as redundant)
 *
 * The first version of the golden gate had four scenarios built from shipped content, and a
 * mutation check found that changing `WALL_NORTH_BRIM` from 23 px to 24 px moved **none** of
 * their hashes. The gate looked like coverage of the exact constant that motivated it and was
 * not, for a structural reason:
 *
 *   - the brim applies only to a solid flagged `freeStanding`;
 *   - `EngineConfig.walls` is a flat `[x, y, w, h]` tuple and **cannot carry that flag**, so no
 *     flat-config scenario can ever exercise the brim at all;
 *   - dungeon mode does have free-standing blocks, but a pseudo-random stick wanders — over
 *     1500 ticks it never happened to press one's NORTH face hard enough for a 1 px change to
 *     alter a single fp coordinate.
 *
 * That is the "fixture makes the mutant equivalent" trap this repo has hit before. The fix is
 * not a wider sweep (a wander is still a wander); it is geometry and input chosen so the
 * contact is guaranteed.
 *
 * ## The shape
 *
 * A 21x21 room, solid perimeter, with ONE free-standing block parked in the middle and the
 * player spawning directly NORTH of it — the face the brim actually governs. Paired with the
 * `sweep` input mode (a full-deflection stick rotating a full circle every 256 ticks), the
 * player is driven into all four faces of that block over and over, so the one-sided brim shows
 * up as a difference in where the actor comes to rest.
 *
 * Two enemies sit in the far corners so the room never clears — a cleared room reaches its
 * checkpoint and the run stops being about movement.
 */
import type { RoomPiece } from '../content/rooms';
import type { DungeonConfig, DungeonFloorMap } from '../world/dungeon';

/** The block's authored rect, exported so a test can assert against it without restating it. */
export const GRINDER_BLOCK = { x: 8, y: 10, w: 5, h: 3 } as const;

const room: RoomPiece = {
  id: 'brim_grinder',
  tags: ['brim_grinder'],
  sizeGrid: { w: 21, h: 21 },
  solids: [
    // Perimeter ring — NOT free-standing, so it keeps exact-footprint collision and acts as
    // the control: if a brim change moved these too, the constant's "only free-standing
    // blocks" rule would be broken and this scenario would say so.
    { x: 0, y: 0, w: 21, h: 1 },
    { x: 0, y: 20, w: 21, h: 1 },
    { x: 0, y: 1, w: 1, h: 19 },
    { x: 20, y: 1, w: 1, h: 19 },
    // The subject. `freeStanding` is the entire point of this file.
    { ...GRINDER_BLOCK, freeStanding: true },
  ],
  spawns: {
    // Directly north of the block, so the very first ticks of southward stick press the
    // brimmed face rather than reaching it by luck.
    player: [{ x: 10.5, y: 6 }],
    enemy: [
      { x: 2.5, y: 2.5, type: 'basic' },
      { x: 18.5, y: 18.5, type: 'basic' },
    ],
  },
  // A capstone room still needs somewhere to say the floor ends; with one room and no doors,
  // nothing is ever locked and the run simply plays inside it.
  exits: [],
  role: 'extraction',
};

export const BRIM_GRINDER_ROOMS: readonly RoomPiece[] = [room];

export const BRIM_GRINDER_FLOOR: DungeonFloorMap = {
  id: 'brim_grinder_floor',
  rooms: [{ id: 'g1', pieceId: 'brim_grinder', offsetXGrid: 0, offsetYGrid: 0 }],
  doors: [],
};

export const BRIM_GRINDER_DUNGEON: DungeonConfig = {
  biomeId: 'ember',
  nameKey: 'biome.ember',
  floorCount: 1,
  roomsPerFloor: { min: 1, max: 1 },
  pieceTags: ['brim_grinder'],
  layout: 'graph2d',
  extractionPieceId: 'brim_grinder',
  bossPieceId: 'brim_grinder',
  difficultyCurve: { base: 1, perFloor: 0 },
  floorMaps: { 0: BRIM_GRINDER_FLOOR },
};
