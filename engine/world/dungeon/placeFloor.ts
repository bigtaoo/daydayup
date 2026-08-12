/**
 * Linear/branching floor placement along a west→east spine, split out of
 * dungeon.ts (CLAUDE.md "500-line file convention", form ①). Placement for the
 * `'graph2d'` layout is a sibling, not a variant — see ./placeFloorGraph2d.ts.
 */
import type { Prng } from '../../math/prng';
import type { AabbGrid } from '../../content/rooms';
import type { Door, RoomId } from '../../content/arenas';
import type { FloorStage, PlacedRoom } from './types';
import { BRANCH_GAP_GRID, DOOR_ANCHOR_COUNT, DOOR_EDGE_MARGIN_GRID, DOOR_WIDTH_GRID, ENTRANCE_INSET_GRID } from './placementConstants';

/**
 * Place a floor's already-resolved stage sequence (`generateFloor`'s output)
 * along a west→east spine (design/05 "a strict room-to-room spine" — the MVP
 * placement shape; a real 2D graph layout stays deferred). At most one stage is a
 * real fork (module doc "fully-realized branching"): its siblings are placed
 * side-by-side (same X, stacked in Y) directly east of the previous stage's room,
 * and each connects onward to the next stage's room, reconverging with no
 * separate merge-room concept needed. Every normal `ember.ts` piece already
 * authors both `west`+`east` exits and the capstone pieces author only `west`, so
 * no content re-authoring is needed to chain them this way — this throws (fail
 * loud, design/09) if some future piece breaks that assumption.
 *
 * For each door, `pickDoorAnchor` draws ONE `roomgenPrng` value to place a real,
 * non-centered `Door` — continuing the SAME stream `generateFloor` already drew
 * from, so a floor's room selection AND its door placement are one reproducible
 * draw sequence together.
 */
export function placeFloor(
  stages: readonly FloorStage[],
  roomgenPrng: Prng,
): { placed: PlacedRoom[]; doors: Door[] } {
  if (stages.length === 0) throw new Error('placeFloor: empty stage list');

  const placed: PlacedRoom[] = [];
  const doors: Door[] = [];
  let cursorXGrid = 0;
  let prevExit: PlacedRoom[] = []; // rooms whose east side is unconnected, waiting for the next stage

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i]!;
    const pieces = Array.isArray(stage) ? stage : [stage];

    if (pieces.length === 1) {
      const piece = pieces[0]!;
      const id: RoomId = `${piece.id}#${i}`;
      if (prevExit.length > 0 && !piece.exits.some((e) => e.edge === 'west')) {
        throw new Error(`placeFloor: '${id}' (stage ${i}) has no west exit to connect to stage ${i - 1}`);
      }
      const room: PlacedRoom = { id, piece, offsetXGrid: cursorXGrid, offsetYGrid: 0, entranceGrid: { x: 0, y: 0 } };
      placed.push(room);
      cursorXGrid += piece.sizeGrid.w;

      let entranceSet = false;
      for (const prev of prevExit) {
        if (!prev.piece.exits.some((e) => e.edge === 'east')) {
          throw new Error(`placeFloor: '${prev.id}' has no east exit to connect to stage ${i}`);
        }
        const passageGrid = pickDoorAnchor(prev, room, roomgenPrng);
        doors.push({ roomA: prev.id, roomB: room.id, passageGrid });
        // A merge room can receive more than one incoming door (reconvergence,
        // module doc); its entranceGrid is set from whichever is computed first
        // (deterministic — draw order), same "pick one, document it" choice as
        // any other arbitrary-but-consistent tie-break in this module.
        if (!entranceSet) {
          room.entranceGrid = { x: room.offsetXGrid + ENTRANCE_INSET_GRID, y: passageGrid.y + passageGrid.h / 2 };
          entranceSet = true;
        }
      }
      prevExit = [room];
    } else {
      // A real fork (module doc): `pieces.length >= 2`, all sharing one width
      // (generateFloor's own contract) so they share one east boundary X with the
      // upcoming merge room, reusing pickDoorAnchor's adjacency assumption as-is.
      if (prevExit.length !== 1) {
        throw new Error(`placeFloor: fork stage ${i} must follow a single-room stage (no fork-into-fork chaining)`);
      }
      const width = pieces[0]!.sizeGrid.w;
      if (pieces.some((p) => p.sizeGrid.w !== width)) {
        throw new Error(`placeFloor: fork stage ${i}'s siblings must share one width`);
      }
      const hub = prevExit[0]!;
      if (!hub.piece.exits.some((e) => e.edge === 'east')) {
        throw new Error(`placeFloor: '${hub.id}' has no east exit to connect to fork stage ${i}`);
      }

      const gap = BRANCH_GAP_GRID;
      const totalH = pieces.reduce((sum, p) => sum + p.sizeGrid.h, 0) + gap * (pieces.length - 1);
      const hubCenterY = hub.offsetYGrid + hub.piece.sizeGrid.h / 2;
      let cursorY = hubCenterY - totalH / 2;
      const siblings: PlacedRoom[] = [];
      for (const piece of pieces) {
        if (!piece.exits.some((e) => e.edge === 'west') || !piece.exits.some((e) => e.edge === 'east')) {
          throw new Error(`placeFloor: fork sibling '${piece.id}' (stage ${i}) needs both west+east exits`);
        }
        const id: RoomId = `${piece.id}#${i}`;
        siblings.push({ id, piece, offsetXGrid: cursorXGrid, offsetYGrid: cursorY, entranceGrid: { x: 0, y: 0 } });
        cursorY += piece.sizeGrid.h + gap;
      }

      for (const sib of siblings) {
        const passageGrid = pickDoorAnchor(hub, sib, roomgenPrng);
        doors.push({ roomA: hub.id, roomB: sib.id, passageGrid });
        sib.entranceGrid = { x: sib.offsetXGrid + ENTRANCE_INSET_GRID, y: passageGrid.y + passageGrid.h / 2 };
      }

      placed.push(...siblings);
      cursorXGrid += width;
      prevExit = siblings; // the NEXT stage connects from every sibling — the reconvergence
    }
  }

  const first = placed[0]!;
  const sp = first.piece.spawns.player[0];
  first.entranceGrid = sp
    ? { x: first.offsetXGrid + sp.x, y: first.offsetYGrid + sp.y }
    : { x: first.offsetXGrid + ENTRANCE_INSET_GRID, y: first.piece.sizeGrid.h / 2 };

  return { placed, doors };
}

/** Draw one door's `passageGrid` between two directly-adjacent rooms (`b` sits
 * immediately east of `a`, same shared boundary X). The candidate band is both
 * rooms' vertical overlap, inset by `DOOR_EDGE_MARGIN_GRID`; `DOOR_ANCHOR_COUNT`
 * evenly-spaced centers are offered and one is drawn — never the band's own
 * center outright, so the result is not wall-centered by construction (design/05
 * "~5 positions per wall... a snapping aid, not a constraint baked into the data
 * shape"). The rect spans 1 grid unit into each room (`w: 2`, centered on the
 * shared boundary) so `carveDoorGaps` cuts through both rooms' wall strips at
 * once. Throws if the two rooms are too small/mismatched for any anchor to fit —
 * not expected from curated content, but a real fail-loud guard (design/09), not
 * a silent clamp. */
function pickDoorAnchor(a: PlacedRoom, b: PlacedRoom, roomgenPrng: Prng): AabbGrid {
  const boundaryXGrid = a.offsetXGrid + a.piece.sizeGrid.w; // === b.offsetXGrid
  const bandLo = Math.max(a.offsetYGrid, b.offsetYGrid) + DOOR_EDGE_MARGIN_GRID;
  const bandHi = Math.min(a.offsetYGrid + a.piece.sizeGrid.h, b.offsetYGrid + b.piece.sizeGrid.h) - DOOR_EDGE_MARGIN_GRID;
  const span = bandHi - bandLo - DOOR_WIDTH_GRID;
  if (span < 0) {
    throw new Error(`placeFloor: rooms '${a.id}'/'${b.id}' are too small/mismatched to fit a door`);
  }
  const candidateCount = span === 0 ? 1 : DOOR_ANCHOR_COUNT;
  const step = candidateCount > 1 ? span / (candidateCount - 1) : 0;
  const chosen = roomgenPrng.nextInt(candidateCount); // the ONE draw this door costs
  const centerYGrid = bandLo + DOOR_WIDTH_GRID / 2 + step * chosen;
  return { x: boundaryXGrid - 1, y: centerYGrid - DOOR_WIDTH_GRID / 2, w: 2, h: DOOR_WIDTH_GRID };
}
