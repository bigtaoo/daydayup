/**
 * Real 2D graph placement for the `'graph2d'` layout, split out of dungeon.ts
 * (CLAUDE.md "500-line file convention", form ①) — a sibling to ./placeFloor.ts,
 * not a variant of it (design/05, ROADMAP "real 2D graph layout" follow-up).
 */
import type { Prng } from '../../math/prng';
import type { AabbGrid, RoomEdge, RoomPiece } from '../../content/rooms';
import type { Door } from '../../content/arenas';
import type { PlacedRoom } from './types';
import { DOOR_ANCHOR_COUNT, DOOR_EDGE_MARGIN_GRID, DOOR_WIDTH_GRID, ENTRANCE_INSET_GRID } from './placementConstants';
import { entranceFromDoor } from './entranceGeometry';

const OPPOSITE_EDGE: Record<RoomEdge, RoomEdge> = { north: 'south', south: 'north', east: 'west', west: 'east' };

/** Where `piece` lands, adjacent to `prev`, walking out through `direction` —
 * centered on `prev`'s own perpendicular axis (same centering convention
 * `placeFloor`'s own fork-sibling stacking already uses for `hubCenterY`), so a
 * next piece narrower/wider or shorter/taller than `prev` still overlaps it enough
 * for a door band to exist whenever the two sizes are anywhere close. */
function placeAdjacent2d(
  prev: PlacedRoom,
  piece: RoomPiece,
  direction: RoomEdge,
): { offsetXGrid: number; offsetYGrid: number } {
  const prevCenterX = prev.offsetXGrid + prev.piece.sizeGrid.w / 2;
  const prevCenterY = prev.offsetYGrid + prev.piece.sizeGrid.h / 2;
  switch (direction) {
    case 'east':
      return { offsetXGrid: prev.offsetXGrid + prev.piece.sizeGrid.w, offsetYGrid: prevCenterY - piece.sizeGrid.h / 2 };
    case 'west':
      return { offsetXGrid: prev.offsetXGrid - piece.sizeGrid.w, offsetYGrid: prevCenterY - piece.sizeGrid.h / 2 };
    case 'south':
      return { offsetXGrid: prevCenterX - piece.sizeGrid.w / 2, offsetYGrid: prev.offsetYGrid + prev.piece.sizeGrid.h };
    case 'north':
      return { offsetXGrid: prevCenterX - piece.sizeGrid.w / 2, offsetYGrid: prev.offsetYGrid - piece.sizeGrid.h };
  }
}

/** `pickDoorAnchor`, generalized to whichever axis `direction` shares a boundary
 * on — east/west share a vertical boundary (band = Y overlap, matching
 * `pickDoorAnchor` exactly for `direction === 'east'`); north/south share a
 * horizontal one (band = X overlap). Kept as its own function rather than folded
 * into `pickDoorAnchor` itself (a sibling, not a variant — same precedent as
 * `placeFloorGraph2d` vs. `placeFloor`) so the already-shipped, replay-critical
 * `'linear'`/`'branching'` path never changes a single line. */
function pickDoorAnchor2d(a: PlacedRoom, b: PlacedRoom, direction: RoomEdge, roomgenPrng: Prng): AabbGrid {
  const vertical = direction === 'east' || direction === 'west'; // shared boundary runs vertically (a north/south wall's own gap is horizontal)
  const aLo = vertical ? a.offsetYGrid : a.offsetXGrid;
  const aHi = aLo + (vertical ? a.piece.sizeGrid.h : a.piece.sizeGrid.w);
  const bLo = vertical ? b.offsetYGrid : b.offsetXGrid;
  const bHi = bLo + (vertical ? b.piece.sizeGrid.h : b.piece.sizeGrid.w);
  const bandLo = Math.max(aLo, bLo) + DOOR_EDGE_MARGIN_GRID;
  const bandHi = Math.min(aHi, bHi) - DOOR_EDGE_MARGIN_GRID;
  const span = bandHi - bandLo - DOOR_WIDTH_GRID;
  if (span < 0) {
    throw new Error(`placeFloorGraph2d: rooms '${a.id}'/'${b.id}' are too small/mismatched to fit a door`);
  }
  const candidateCount = span === 0 ? 1 : DOOR_ANCHOR_COUNT;
  const step = candidateCount > 1 ? span / (candidateCount - 1) : 0;
  const chosen = roomgenPrng.nextInt(candidateCount); // the ONE draw this door costs
  const center = bandLo + DOOR_WIDTH_GRID / 2 + step * chosen;

  const boundary =
    direction === 'east' ? a.offsetXGrid + a.piece.sizeGrid.w
    : direction === 'west' ? a.offsetXGrid
    : direction === 'south' ? a.offsetYGrid + a.piece.sizeGrid.h
    : a.offsetYGrid; // 'north'
  return vertical
    ? { x: boundary - 1, y: center - DOOR_WIDTH_GRID / 2, w: 2, h: DOOR_WIDTH_GRID }
    : { x: center - DOOR_WIDTH_GRID / 2, y: boundary - 1, w: DOOR_WIDTH_GRID, h: 2 };
}

/** Returns the first already-placed room `room` spatially overlaps, or `undefined`
 * if it fits cleanly — a real risk once placement can walk in any of 4 directions
 * (a sequence that turns back on itself can fold the floor onto its own earlier
 * rooms), unlike `placeFloor`'s single-axis spine where it structurally cannot
 * happen. Non-throwing (unlike its name might suggest at a glance): `placeFloorGraph2d`
 * uses this to try alternate directions before giving up, see its own doc comment's
 * "direction retry" paragraph. */
function findOverlap2d(room: PlacedRoom, placed: readonly PlacedRoom[]): PlacedRoom | undefined {
  const ax0 = room.offsetXGrid;
  const ax1 = room.offsetXGrid + room.piece.sizeGrid.w;
  const ay0 = room.offsetYGrid;
  const ay1 = room.offsetYGrid + room.piece.sizeGrid.h;
  for (const other of placed) {
    const bx0 = other.offsetXGrid;
    const bx1 = other.offsetXGrid + other.piece.sizeGrid.w;
    const by0 = other.offsetYGrid;
    const by1 = other.offsetYGrid + other.piece.sizeGrid.h;
    if (ax0 < bx1 && bx0 < ax1 && ay0 < by1 && by0 < ay1) return other;
  }
  return undefined;
}

/**
 * Place a `'graph2d'`-generated floor's already-resolved stage sequence (module
 * doc) in real 2D — a sibling to `placeFloor`, not a variant of it. `stages` is
 * always `readonly RoomPiece[]` (never a fork array: `generateFloor` only forks for
 * `'branching'`). Walks stage-to-stage: at each step, the previous room's viable
 * outgoing exits are whichever of its OWN `exits` is not the one already consumed
 * entering it (all of them, for the first/spawn room) AND has a matching opposite
 * exit on the next piece — `roomgenPrng.nextInt` draws a direction only when more
 * than one is viable (module doc). Throws (fail loud, design/09) if no exit is
 * compatible, or if the two rooms are too small/mismatched to fit a door
 * (`pickDoorAnchor2d`).
 *
 * **Direction retry (design/05, 2026-08-05 "graph2d content" follow-up):** the
 * drawn direction's placement can overlap an already-placed room (`findOverlap2d`)
 * — found live once real content gave a normal piece more than 2 exits: a floor
 * that bends north/south and THEN needs to reach a west-only-turned-west/east
 * capstone can legitimately draw the direction that folds back toward the
 * spawn room. Rather than throw immediately on the FIRST candidate (which would
 * turn an otherwise-fine seed into a crash), this tries every OTHER viable
 * direction, in fixed array order, before giving up — deterministic (no extra
 * PRNG draw; same seed always tries directions in the same order) and strictly
 * reactive (it only ever looks at rooms already placed, never at what stage
 * comes next), so this is still not a solver: a sequence where EVERY viable
 * direction overlaps still throws, same as before. For any placement that never
 * overlapped in the first place (every seed this module's tests already
 * covered), the drawn direction is still tried first and still wins immediately
 * — zero behavior change, same PRNG draw count, same output.
 */
export function placeFloorGraph2d(
  stages: readonly RoomPiece[],
  roomgenPrng: Prng,
): { placed: PlacedRoom[]; doors: Door[] } {
  if (stages.length === 0) throw new Error('placeFloorGraph2d: empty stage list');

  const firstPiece = stages[0]!;
  const first: PlacedRoom = { id: `${firstPiece.id}#0`, piece: firstPiece, offsetXGrid: 0, offsetYGrid: 0, entranceGrid: { x: 0, y: 0 } };
  const placed: PlacedRoom[] = [first];
  const doors: Door[] = [];

  let prev = first;
  let entryEdge: RoomEdge | undefined; // the exit already consumed on `prev` — undefined for the spawn room (nothing entered it)

  for (let i = 1; i < stages.length; i++) {
    const piece = stages[i]!;
    const outgoing = prev.piece.exits.map((e) => e.edge).filter((edge) => edge !== entryEdge);
    const viable = outgoing.filter((dir) => piece.exits.some((e) => e.edge === OPPOSITE_EDGE[dir]));
    if (viable.length === 0) {
      throw new Error(`placeFloorGraph2d: '${prev.id}' (stage ${i - 1}) has no exit compatible with stage ${i} ('${piece.id}')`);
    }
    const preferred = viable.length === 1 ? viable[0]! : viable[roomgenPrng.nextInt(viable.length)]!;
    const order = [preferred, ...viable.filter((dir) => dir !== preferred)];

    let room: PlacedRoom | undefined;
    let direction: RoomEdge | undefined;
    let lastConflict: { candidate: PlacedRoom; other: PlacedRoom } | undefined;
    for (const dir of order) {
      const { offsetXGrid, offsetYGrid } = placeAdjacent2d(prev, piece, dir);
      const candidate: PlacedRoom = { id: `${piece.id}#${i}`, piece, offsetXGrid, offsetYGrid, entranceGrid: { x: 0, y: 0 } };
      const conflict = findOverlap2d(candidate, placed);
      if (!conflict) {
        room = candidate;
        direction = dir;
        break;
      }
      lastConflict = { candidate, other: conflict };
    }
    if (!room || !direction) {
      const { candidate, other } = lastConflict!;
      throw new Error(
        `placeFloorGraph2d: '${candidate.id}' overlaps already-placed '${other.id}' — the drawn direction sequence folded the floor back onto itself`,
      );
    }

    const passageGrid = pickDoorAnchor2d(prev, room, direction, roomgenPrng);
    doors.push({ roomA: prev.id, roomB: room.id, passageGrid });
    room.entranceGrid = entranceFromDoor(room, passageGrid);

    placed.push(room);
    prev = room;
    entryEdge = OPPOSITE_EDGE[direction];
  }

  const sp = first.piece.spawns.player[0];
  first.entranceGrid = sp
    ? { x: first.offsetXGrid + sp.x, y: first.offsetYGrid + sp.y }
    : { x: first.offsetXGrid + ENTRANCE_INSET_GRID, y: first.piece.sizeGrid.h / 2 };

  // A north/west hop off the spawn room (pinned at the origin by construction,
  // above) produces a negative `offsetXGrid`/`offsetYGrid` (`placeAdjacent2d`'s
  // 'north'/'west' cases subtract the new piece's own size) — fine for the
  // placement math itself, which only ever compares relative offsets, but every
  // downstream consumer assumes the floor's playable area starts at (0,0):
  // `buildFloorGeometry`'s `worldW`/`worldH` is a running MAX seeded at 0 (blind
  // to negative extents), and `MovementSystem.clampToWorld` hard-clamps to
  // `[margin, worldW - margin]` with no lower bound below 0 — so a player
  // standing at a negative-offset door is walled off from ever stepping through
  // it into the room beyond, even though the door itself correctly unlocks (the
  // bug report this fixes: "door unlocked, foes:0, still can't pass through").
  // Fix: shift the WHOLE floor by the same delta so the minimum offset on each
  // axis lands at exactly 0 — pure translation, so every relative
  // distance/adjacency already computed above is unaffected; only the shared
  // origin moves. `'linear'`/`'branching'` floors (`placeFloor`) only ever walk
  // west→east (+ south-only hub forks) and so never produce a negative offset —
  // this is a deliberate no-op for them, never even reached.
  let shiftX = 0;
  let shiftY = 0;
  for (const room of placed) {
    shiftX = Math.min(shiftX, room.offsetXGrid);
    shiftY = Math.min(shiftY, room.offsetYGrid);
  }
  if (shiftX !== 0 || shiftY !== 0) {
    for (const room of placed) {
      room.offsetXGrid -= shiftX;
      room.offsetYGrid -= shiftY;
      room.entranceGrid = { x: room.entranceGrid.x - shiftX, y: room.entranceGrid.y - shiftY };
    }
    for (const door of doors) {
      door.passageGrid = { ...door.passageGrid, x: door.passageGrid.x - shiftX, y: door.passageGrid.y - shiftY };
    }
  }

  return { placed, doors };
}
