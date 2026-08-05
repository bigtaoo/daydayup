/**
 * Seeded dungeon assembly (design/05/09, ROADMAP 1.3) — "a seeded layout stitches
 * hand-authored pieces" (design/09's core divergence from funny's one scripted
 * level). `generateFloor` is the pure selection function: given a `DungeonConfig`,
 * which floor, the run's `roomgenPrng`, and a `RoomPiece` library, it returns the
 * ordered room sequence for that floor. `placeFloor`/`carveDoorGaps`/
 * `buildFloorGeometry` are the pure placement functions (design/05 "Room & door
 * model", 2026-08-04): they turn that ordered sequence into a co-resident,
 * door-connected floor — every room simultaneously live, matching PvP's `ArenaMap`
 * (`content/arenas.ts`) shape, rather than the old one-room-at-a-time swap. All of
 * these are pure and side-effect-free, like `content/rooms.ts roomGeometry` — none
 * touch GameState. Wiring a generated, placed floor into a live run is
 * `SpawnSystem`'s job.
 *
 * Two layouts: `'linear'` is a single ordered room sequence, one room per normal
 * stage. `'branching'` (design/05, 2026-08-05 "fully-realized branching") gets
 * **one real fork-and-reconverge diamond per floor**: a PRNG-chosen interior
 * normal-stage transition splits into `branchFactor` DISTINCT, same-width sibling
 * rooms placed side-by-side (real `PlacedRoom`s, a real walk-through-the-door
 * choice), which reconverge into the very next stage's room (an ordinary room or
 * the capstone) with no separate merge-room concept needed. Superseded prior
 * behavior (ENGINE_VERSION 34): branching used to resolve at generation time via a
 * second `roomgenPrng.nextInt(branchFactor)` draw per stage that just perturbed the
 * linear pick by a wraparound offset into the same pool — no sibling ever existed
 * as data. See the `FloorStage`/`generateFloor`/`placeFloor` doc comments below for
 * the concrete draw sequence and placement geometry. Only one fork per floor
 * (no fork-into-fork chaining) and siblings must share their pool piece's exact
 * width (so their shared east boundary lines up with one merge-room X, reusing
 * `pickDoorAnchor`'s adjacency assumption unmodified) — both deliberate scope cuts,
 * not data-model limits (`Door`/`PlacedRoom` already support an arbitrary graph).
 */
import type { Prng } from '../math/prng';
import { roomGeometry, type AabbGrid, type RoomPiece } from '../content/rooms';
import type { Door, RoomId } from '../content/arenas';
import { toFpGrid } from '../content/convert';
import type { AABB, Obstacle } from '../state/entities';
import { addFp, subFp, type Fp } from '../math/fixed';

/** A tag against `RoomPiece.tags` — which pool a biome draws its normal rooms from. */
export type RoomTag = string;

/** First-pass linear difficulty scaling by floor depth (design/05 "to-tune"):
 * `base + perFloor * floorIndex`, floorIndex 0-based. Final tuning is design/05's
 * open work; the shape (a simple linear ramp) is what ships now. */
export interface CurveSpec {
  base: number;
  perFloor: number;
}

export function curveAt(curve: CurveSpec, floorIndex: number): number {
  return curve.base + curve.perFloor * floorIndex;
}

export interface DungeonConfig {
  biomeId: string;
  nameKey: string;
  floorCount: number;
  roomsPerFloor: { min: number; max: number };
  pieceTags: readonly RoomTag[];
  layout: 'linear' | 'branching'; // see module doc — branching offers a per-stage choice
  branchFactor?: number; // 'branching' only: candidate rooms per normal stage (default 2,
  // clamped to the pool size); ignored for 'linear' (always 1)
  extractionPieceId: string; // this floor's checkpoint room (every floor but the last)
  bossPieceId: string; // the deepest floor's room — doubles as ITS extraction
  difficultyCurve: CurveSpec;
  /** Optional per-floor-index hand-authored override (design/05 "Hand-authored PvE
   * floors", 2026-08-05): when `floorIndex` has an entry, `SpawnSystem` calls
   * `placeAuthoredFloor` instead of `generateFloor`/`placeFloor` for that floor —
   * zero `roomgenPrng` draws for it, the same PRNG-free property PvP's `ArenaMap`
   * already has. A floor index absent here still draws procedurally, byte-identical
   * to before this field existed — fully additive, no `ENGINE_VERSION` bump (no
   * shipped config sets it, and it changes nothing for one that doesn't). */
  floorMaps?: Partial<Record<number, DungeonFloorMap>>;
}

/** One resolved stage: normally a single `RoomPiece`; a `RoomPiece[]` (length
 * always `>= 2`) only at a `'branching'` floor's one fork stage — real, distinct
 * sibling rooms `placeFloor` places side-by-side (module doc "fully-realized
 * branching"), not a resolved single pick. Deliberately NOT `readonly RoomPiece[]`
 * here — TS's `Array.isArray` type guard doesn't narrow a `readonly T[]` union
 * member out of the non-array branch (a `readonly T[] extends any[]` conditional
 * check is false), which would leave every `Array.isArray(stage) ? ... : stage`
 * site still seeing the array type in the `RoomPiece` branch. */
export type FloorStage = RoomPiece | RoomPiece[];

/** One floor's generated room sequence, already fully resolved — at most one
 * stage is a real fork (module doc), so `placeFloor` never has to make its own
 * content choice, only a placement one. The last stage is always the capstone:
 * `extractionPieceId` on every floor except the last, `bossPieceId` on the last
 * (design/05 "the last floor's boss room IS its extraction room"). */
export interface FloorLayout {
  floorIndex: number; // 0-based
  stages: readonly FloorStage[];
  /** Flattened, one-piece-per-stage view for simple/back-compat consumers (HUD
   * stage count, non-branching callers): the fork stage's first/primary candidate.
   * Always `stages.map(s => Array.isArray(s) ? s[0] : s)`. */
  rooms: readonly RoomPiece[];
}

/**
 * Generate one floor deterministically from `roomgenPrng` (design/06/08: same
 * seed + same PRNG draw sequence → identical layout on every client). Draws, in
 * order: (1) how many rooms this floor has, within `roomsPerFloor` — ONE `nextInt`
 * call; (2) for `'branching'` only, with at least 2 normal stages, ONE more
 * `nextInt` to pick which INTERIOR normal-stage transition forks (never stage 0,
 * so the run's spawn stays a single ordinary room — module doc); (3) one normal
 * ROOM per room-before-the-capstone — one `nextInt(pool.length)` call each, in
 * order, in the SAME stream position a `'linear'` config would use, PLUS, only at
 * the chosen fork stage, up to `branchFactor - 1` further `nextInt` draws to pick
 * that many more DISTINCT, same-width siblings from the pool (clamped down if the
 * pool doesn't have that many — a graceful degrade, not a throw: fewer eligible
 * siblings just means a smaller (or no) fork, same as `branchFactor` itself already
 * clamps to the pool size).
 *
 * Throws (a load-time validation, design/09 "fail loud, never at use") if the
 * tag pool is empty or the required capstone piece id is missing from `library`.
 */
export function generateFloor(
  config: DungeonConfig,
  floorIndex: number,
  roomgenPrng: Prng,
  library: readonly RoomPiece[],
): FloorLayout {
  const pool = library.filter((p) => !p.role && p.tags?.some((t) => config.pieceTags.includes(t)));
  if (pool.length === 0) {
    throw new Error(`generateFloor: no normal RoomPiece matches pieceTags for biome '${config.biomeId}'`);
  }

  const span = config.roomsPerFloor.max - config.roomsPerFloor.min + 1;
  const roomCount = config.roomsPerFloor.min + roomgenPrng.nextInt(span);
  const normalCount = Math.max(0, roomCount - 1); // the capstone is the final room

  // The floor's one fork stage (module doc) — never stage 0, only when there's
  // room for both a fork point AND a reconvergence point among normal stages.
  const forkStageIndex = config.layout === 'branching' && normalCount >= 2
    ? 1 + roomgenPrng.nextInt(normalCount - 1)
    : -1;

  const stages: FloorStage[] = [];
  for (let i = 0; i < normalCount; i++) {
    const base = roomgenPrng.nextInt(pool.length); // the ONE draw every stage costs
    const basePiece = pool[base]!;
    if (i === forkStageIndex) {
      const branchFactor = Math.max(1, config.branchFactor ?? 2);
      const sameWidth = pool.filter((p) => p.id !== basePiece.id && p.sizeGrid.w === basePiece.sizeGrid.w);
      const extra = Math.min(branchFactor - 1, sameWidth.length);
      const siblings: RoomPiece[] = [basePiece];
      const remaining = sameWidth.slice(); // local copy — splice is array-order, never Map/Set iteration
      for (let j = 0; j < extra; j++) {
        const pick = roomgenPrng.nextInt(remaining.length);
        siblings.push(remaining[pick]!);
        remaining.splice(pick, 1); // never drawn twice
      }
      stages.push(siblings.length > 1 ? siblings : basePiece);
    } else {
      stages.push(basePiece);
    }
  }

  const isLastFloor = floorIndex === config.floorCount - 1;
  const capstoneId = isLastFloor ? config.bossPieceId : config.extractionPieceId;
  const capstone = library.find((p) => p.id === capstoneId);
  if (!capstone) throw new Error(`generateFloor: missing capstone RoomPiece '${capstoneId}'`);
  stages.push(capstone);

  const rooms = stages.map((s) => (Array.isArray(s) ? s[0]! : (s as RoomPiece)));
  return { floorIndex, stages, rooms };
}

// ---------------------------------------------------------------------------
// Floor placement — a co-resident, door-connected floor (design/05, 2026-08-04)
// ---------------------------------------------------------------------------

/** How wide a door's passage is, in grid units — matches `world/rooms/ember.ts`'s
 * existing `DOOR` constant (the visual scale every hand-authored piece was built
 * against). */
const DOOR_WIDTH_GRID = 4;
/** How far a door's center must stay from a room's own top/bottom edge, so a
 * carved gap never lands in (or beside) the corner a room's north/south wall
 * claims. A generic layout margin — this module does not need to know any
 * particular content piece's own wall-authoring convention. */
const DOOR_EDGE_MARGIN_GRID = 1.5;
/** "~5 positions per wall" (design/05) — evenly-spaced candidate anchors a door's
 * center is drawn from, so placement is never wall-centered but also never
 * unbounded-arbitrary at generation time. */
const DOOR_ANCHOR_COUNT = 5;
/** How far inside a room, off its entry door, the force-regroup landing point /
 * a mid-floor room's default spawn sits. */
const ENTRANCE_INSET_GRID = 1.5;
/** Vertical gap between two stacked fork siblings (module doc "fully-realized
 * branching") — keeps their AABBs from touching/overlapping; same order of
 * magnitude as `DOOR_EDGE_MARGIN_GRID`, just a distinct constant since it governs
 * room-to-room spacing, not a door-to-wall-edge margin. */
const BRANCH_GAP_GRID = 2;

/** One room placed into a floor's shared coordinate space. `id` is synthesized as
 * `${piece.id}#${stageIndex}` — a `RoomPiece` can be drawn more than once per
 * floor (branching wrap-around, or two stages happening to draw the same piece),
 * so the piece's own `id` alone cannot be relied on as a floor-unique `RoomId`. */
export interface PlacedRoom {
  id: RoomId;
  piece: RoomPiece;
  offsetXGrid: number;
  offsetYGrid: number;
  /** A point just inside the room, used as the force-regroup teleport target and
   * (for the first room) the run's initial spawn. */
  entranceGrid: { x: number; y: number };
}

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

// ---------------------------------------------------------------------------
// Hand-authored floors (design/05 "Hand-authored PvE floors", 2026-08-05)
// ---------------------------------------------------------------------------

/**
 * A hand-authored floor — the `DungeonConfig.floorMaps` per-floor-index override
 * that lets a floor be placed exactly, instead of drawn from `generateFloor`/
 * `placeFloor`'s PRNG stream. `rooms` reference the SAME `RoomPiece` library
 * `generateFloor` already draws from, by id — a hand-authored floor is not a
 * separate content vocabulary, just a different way of arranging the existing
 * one. `doors` reuses PvP's own `Door` type unchanged (`content/arenas.ts`) — a
 * hand-placed PvE door is no different a shape from a hand-placed PvP one.
 *
 * Array order carries meaning, reusing the two single-index assumptions already
 * baked into the engine rather than inventing a third: `rooms[0]` is the
 * entrance/spawn room (`SpawnSystem`'s `placed[0]`), `rooms[rooms.length - 1]` is
 * the capstone extraction/boss room (`ExtractionSystem`'s
 * `dungeonRoomRuntime[length - 1]`). This module trusts that ordering — it fails
 * loud only on a broken reference (a missing piece/room id), never re-validates
 * placement or the capstone convention; `tools/map-editor`'s
 * `validateDungeonFloorMap` is the save-time gate for those, matching how
 * `validateArenaMap` is PvP's own save-time gate rather than an engine-side check.
 */
export interface DungeonFloorMap {
  id: string;
  rooms: { id: RoomId; pieceId: string; offsetXGrid: number; offsetYGrid: number }[];
  doors: Door[];
}

/**
 * Place an already-authored floor (design/05 "Hand-authored PvE floors") — a
 * sibling to `placeFloor`, not a variant of it: every door's `passageGrid` is
 * already fully authored, so there is no PRNG draw here at all (unlike
 * `placeFloor`'s `pickDoorAnchor`). Resolves each room's `pieceId` against
 * `library` (throws if missing — fail loud, matches `generateFloor`'s own
 * missing-capstone check) and computes each non-entrance room's `entranceGrid`
 * from whichever connecting door reaches it FIRST in `doors` array order (same
 * "first door wins" tie-break `placeFloor` already uses for a fork's merge
 * room), inset into the room along whichever axis the door's passage is
 * narrower on (`entranceFromDoor` below) — generalizing `ENTRANCE_INSET_GRID`'s
 * existing west-only inset, which only worked because a generated floor's spine
 * is always west→east; a hand-authored floor's doors can sit on any of a room's
 * four walls, matching PvP's own map-editor door tool. `rooms[0]`'s own
 * `entranceGrid` instead comes from its own authored player spawn point (or a
 * size/2 fallback) — the same "first room reads its own spawn" rule
 * `placeFloor` uses, generalized to an arbitrary (not-necessarily-zero)
 * `offsetYGrid` since a hand-authored entrance room need not sit at the origin.
 * Returns the exact same `{placed, doors}` shape `placeFloor` does, so
 * `buildFloorGeometry` and every system downstream of it (`DoorSystem`,
 * `RoomBuilder`, `EventReactor`, the minimap adapter) need zero changes.
 */
export function placeAuthoredFloor(
  map: DungeonFloorMap,
  library: readonly RoomPiece[],
): { placed: PlacedRoom[]; doors: Door[] } {
  if (map.rooms.length === 0) throw new Error(`placeAuthoredFloor: '${map.id}' has no rooms`);

  const placed: PlacedRoom[] = map.rooms.map((r) => {
    const piece = library.find((p) => p.id === r.pieceId);
    if (!piece) throw new Error(`placeAuthoredFloor: '${map.id}' room '${r.id}' references unknown piece '${r.pieceId}'`);
    return { id: r.id, piece, offsetXGrid: r.offsetXGrid, offsetYGrid: r.offsetYGrid, entranceGrid: { x: 0, y: 0 } };
  });

  const byId = new Map(placed.map((r) => [r.id, r] as const));
  const first = placed[0]!;
  const entranceSet = new Set<RoomId>([first.id]); // first.entranceGrid is set below, from its own spawn, never from a door

  for (const door of map.doors) {
    const a = byId.get(door.roomA);
    const b = byId.get(door.roomB);
    if (!a || !b) {
      throw new Error(`placeAuthoredFloor: '${map.id}' door references unknown room ('${door.roomA}'/'${door.roomB}')`);
    }
    for (const target of [b, a]) {
      if (entranceSet.has(target.id)) continue;
      target.entranceGrid = entranceFromDoor(target, door.passageGrid);
      entranceSet.add(target.id);
    }
  }

  const sp = first.piece.spawns.player[0];
  first.entranceGrid = sp
    ? { x: first.offsetXGrid + sp.x, y: first.offsetYGrid + sp.y }
    : { x: first.offsetXGrid + ENTRANCE_INSET_GRID, y: first.offsetYGrid + first.piece.sizeGrid.h / 2 };

  return { placed, doors: map.doors.slice() };
}

/** A point just inside `room`, off `passageGrid`'s door — generalizes
 * `pickDoorAnchor`'s spine-only west-inset convention to an arbitrary wall. The
 * passage's narrower dimension identifies which axis to inset along (a
 * vertical passage — narrower in X — sits on an east/west wall, so the inset is
 * along X; a horizontal passage sits on a north/south wall, so the inset is
 * along Y); whichever side of `room`'s own center the passage falls on picks
 * the inset direction (west vs east, or north vs south). Ties (a square
 * passage, or a center exactly on the room's own center) resolve to the
 * vertical/west-ish branch — an arbitrary but deterministic choice, same class
 * as any other tie-break in this module. */
function entranceFromDoor(room: PlacedRoom, passageGrid: AabbGrid): { x: number; y: number } {
  const cx = passageGrid.x + passageGrid.w / 2;
  const cy = passageGrid.y + passageGrid.h / 2;
  if (passageGrid.w <= passageGrid.h) {
    const roomCenterX = room.offsetXGrid + room.piece.sizeGrid.w / 2;
    const x =
      cx <= roomCenterX ? room.offsetXGrid + ENTRANCE_INSET_GRID : room.offsetXGrid + room.piece.sizeGrid.w - ENTRANCE_INSET_GRID;
    return { x, y: cy };
  }
  const roomCenterY = room.offsetYGrid + room.piece.sizeGrid.h / 2;
  const y =
    cy <= roomCenterY ? room.offsetYGrid + ENTRANCE_INSET_GRID : room.offsetYGrid + room.piece.sizeGrid.h - ENTRANCE_INSET_GRID;
  return { x: cx, y };
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

/**
 * Subtract every door's passage rect from a floor's stitched wall list — the
 * ONLY place any gap is ever cut (design/05, 2026-08-04): hand-authored pieces
 * (`world/rooms/ember.ts perimeterWalls`) now always emit a full, uncut wall per
 * edge, regardless of `exits`. A generic axis-aligned rect-minus-rect split (up to
 * 4 residual pieces per wall the passage overlaps) — it doesn't matter whether the
 * overlapped solid IS the perimeter wall or an incidental interior solid (e.g.
 * `ember_cross`'s stub walls near its west/east openings): either way, whatever a
 * door's rect overlaps gets cleanly carved through. Operates in Fp (post-
 * conversion) space, same as `roomGeometry`'s own output.
 */
export function carveDoorGaps(walls: readonly AABB[], passages: readonly AABB[]): AABB[] {
  let result: AABB[] = walls.slice();
  for (const passage of passages) {
    const next: AABB[] = [];
    for (const wall of result) next.push(...subtractRect(wall, passage));
    result = next;
  }
  return result;
}

/** `wall` minus `hole`, as 0-4 residual AABBs (a standard rect-difference: left
 * strip, right strip, then top/bottom strips clipped to the hole's own X-range so
 * the four pieces never overlap each other). Returns `[wall]` unchanged if the two
 * don't overlap at all. */
function subtractRect(wall: AABB, hole: AABB): AABB[] {
  const wx0 = wall.x;
  const wx1 = addFp(wall.x, wall.w);
  const wy0 = wall.y;
  const wy1 = addFp(wall.y, wall.h);
  const hx0 = hole.x;
  const hx1 = addFp(hole.x, hole.w);
  const hy0 = hole.y;
  const hy1 = addFp(hole.y, hole.h);
  if (hx1 <= wx0 || hx0 >= wx1 || hy1 <= wy0 || hy0 >= wy1) return [wall];

  const out: AABB[] = [];
  if (hx0 > wx0) out.push({ x: wx0, y: wy0, w: subFp(hx0, wx0), h: wall.h });
  if (hx1 < wx1) out.push({ x: hx1, y: wy0, w: subFp(wx1, hx1), h: wall.h });
  const midX0 = (wx0 > hx0 ? wx0 : hx0) as Fp; // Math.max would drop the Fp brand
  const midX1 = (wx1 < hx1 ? wx1 : hx1) as Fp; // Math.min, same reason
  if (hy0 > wy0 && midX1 > midX0) out.push({ x: midX0, y: wy0, w: subFp(midX1, midX0), h: subFp(hy0, wy0) });
  if (hy1 < wy1 && midX1 > midX0) out.push({ x: midX0, y: hy1, w: subFp(midX1, midX0), h: subFp(wy1, hy1) });
  return out;
}

/**
 * Stitch every placed room's collision geometry into one co-resident floor
 * (mirrors `content/arenas.ts buildArenaGeometry`, reusing the same
 * `roomGeometry` converter per room) and carve every door's gap through it.
 * Pure and side-effect-free — produces the arrays `state.walls`/`state.obstacles`
 * are built from, plus the floor's overall bounds, exactly like
 * `buildArenaGeometry`'s own contract.
 */
export function buildFloorGeometry(
  placed: readonly PlacedRoom[],
  doors: readonly Door[],
): { walls: AABB[]; obstacles: Obstacle[]; worldW: Fp; worldH: Fp } {
  const obstacles: Obstacle[] = [];
  let walls: AABB[] = [];
  let maxXGrid = 0;
  let maxYGrid = 0;
  for (const room of placed) {
    const geo = roomGeometry(room.piece, room.offsetXGrid, room.offsetYGrid);
    walls.push(...geo.walls);
    obstacles.push(...geo.obstacles);
    maxXGrid = Math.max(maxXGrid, room.offsetXGrid + room.piece.sizeGrid.w);
    maxYGrid = Math.max(maxYGrid, room.offsetYGrid + room.piece.sizeGrid.h);
  }
  const passages = doors.map((d) => toFpAabbGrid(d.passageGrid));
  walls = carveDoorGaps(walls, passages);
  return { walls, obstacles, worldW: toFpGrid(maxXGrid), worldH: toFpGrid(maxYGrid) };
}

/** `AabbGrid` (human grid units) → `AABB` (Fp) — same per-field `toFpGrid` shape as
 * `roomGeometry`'s own conversion. Exported so `SpawnSystem` can pre-convert a
 * `Door.passageGrid` into a `DoorRuntime.passageAabb` ONCE, at floor-placement time,
 * rather than duplicating this conversion. */
export function toFpAabbGrid(g: AabbGrid): AABB {
  return { x: toFpGrid(g.x), y: toFpGrid(g.y), w: toFpGrid(g.w), h: toFpGrid(g.h) };
}
