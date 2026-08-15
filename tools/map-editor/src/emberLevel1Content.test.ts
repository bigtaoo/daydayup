/**
 * The shipped level-1 content has to survive a round trip through THIS editor —
 * `world/dungeons/ember/`'s JSON is authored to be tuned here, and the editor
 * refuses to save anything `validate.ts` rejects. So every file the game ships must
 * already pass those same save-time gates, or the first tweak-and-save would be
 * blocked on a problem the content shipped with.
 *
 * This is deliberately the editor's OWN validators run against the real files, not
 * a copy of the rules: `engine/world/rooms/emberLevel1.test.ts` covers the engine
 * side (placement, geometry, physical door passability), and this covers the
 * authoring side.
 */
import { describe, it, expect } from 'vitest';
import { EMBER_L1_FLOORS, EMBER_L1_ROOMS } from '@dd/engine/world/rooms/emberLevel1';
import { validateDungeonFloorMap, validateRoomPiece } from './validate';

const FLOOR_INDICES = [0, 1, 2, 3, 4];

describe('shipped level-1 content passes the editor\'s own save-time gates', () => {
  it.each(EMBER_L1_ROOMS.map((p) => [p.id, p] as const))('room piece %s validates', (_id, piece) => {
    expect(validateRoomPiece(piece)).toEqual([]);
  });

  it.each(FLOOR_INDICES)('floor %i validates against the shipped piece library', (i) => {
    const map = EMBER_L1_FLOORS[i];
    expect(map).toBeDefined();
    expect(validateDungeonFloorMap(map!, EMBER_L1_ROOMS)).toEqual([]);
  });

  it('every floor resolves ALL its pieces from one library load — the whole level can be opened in the editor at once', () => {
    const known = new Set(EMBER_L1_ROOMS.map((p) => p.id));
    const missing = FLOOR_INDICES.flatMap((i) =>
      (EMBER_L1_FLOORS[i]?.rooms ?? []).map((r) => r.pieceId).filter((id) => !known.has(id)),
    );
    expect(missing).toEqual([]);
  });
});
