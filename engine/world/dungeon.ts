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
 * Two layouts (design/05 reward-choice structure): `'linear'` is a single ordered
 * room sequence (one candidate per stage); `'branching'` offers `branchFactor`
 * DISTINCT candidate rooms per normal stage. **Branching resolves at generation
 * time now, via one extra `roomgenPrng` draw per stage — not a live player choice
 * (design/05, 2026-08-04)**: the old resolution read player facing at "the moment
 * of arrival" into a stage, but under the co-resident model every room in the
 * floor is generated and placed before any player has acted, so there is no such
 * moment left to read from. A linear config draws exactly the same ONE `nextInt`
 * per stage as before (byte-identical to every pre-branching replay); a branching
 * config draws that same call PLUS one more to pick among the `branchFactor`
 * candidates. A fully-realized "walk through whichever door" branching (real
 * sibling rooms, a real in-run choice) is a deferred follow-up, not this pass.
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
}

/** One floor's generated room sequence, already fully resolved — branching has
 * already picked ONE candidate per stage (module doc), so there is no further
 * choice left to make. The last room is always the capstone: `extractionPieceId`
 * on every floor except the last, `bossPieceId` on the last (design/05 "the last
 * floor's boss room IS its extraction room"). */
export interface FloorLayout {
  floorIndex: number; // 0-based
  rooms: readonly RoomPiece[];
}

/**
 * Generate one floor deterministically from `roomgenPrng` (design/06/08: same
 * seed + same PRNG draw sequence → identical layout on every client). Draws, in
 * order: (1) how many rooms this floor has, within `roomsPerFloor` — ONE `nextInt`
 * call; (2) one normal ROOM per room-before-the-capstone — one `nextInt` call
 * each, in order, PLUS (branching only) one more `nextInt` to resolve which of the
 * `branchFactor` candidates is actually taken (module doc).
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

  // branchFactor > 1 only for 'branching' — never more candidates than the pool has.
  const branchFactor = config.layout === 'branching'
    ? Math.max(1, Math.min(config.branchFactor ?? 2, pool.length))
    : 1;

  const rooms: RoomPiece[] = [];
  for (let i = 0; i < normalCount; i++) {
    const base = roomgenPrng.nextInt(pool.length); // the ONE draw every layout costs
    const branchPick = branchFactor > 1 ? roomgenPrng.nextInt(branchFactor) : 0; // branching-only 2nd draw
    rooms.push(pool[(base + branchPick) % pool.length]!);
  }

  const isLastFloor = floorIndex === config.floorCount - 1;
  const capstoneId = isLastFloor ? config.bossPieceId : config.extractionPieceId;
  const capstone = library.find((p) => p.id === capstoneId);
  if (!capstone) throw new Error(`generateFloor: missing capstone RoomPiece '${capstoneId}'`);
  rooms.push(capstone);

  return { floorIndex, rooms };
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
 * Place a floor's already-resolved room sequence (`generateFloor`'s output) along
 * a single west→east spine, each room touching the next (design/05 "a strict
 * room-to-room spine" — the MVP placement shape; a real 2D graph layout is
 * deferred, same as fully-realized branching). Every normal `ember.ts` piece
 * already authors both `west`+`east` exits and the capstone pieces author only
 * `west`, so no content re-authoring is needed to chain them this way — this
 * throws (fail loud, design/09) if some future piece breaks that assumption.
 *
 * For each adjacent pair, `pickDoorAnchor` draws ONE `roomgenPrng` value to place
 * a real, non-centered `Door` — continuing the SAME stream `generateFloor` already
 * drew from, so a floor's room selection AND its door placement are one
 * reproducible draw sequence together.
 */
export function placeFloor(
  rooms: readonly RoomPiece[],
  roomgenPrng: Prng,
): { placed: PlacedRoom[]; doors: Door[] } {
  if (rooms.length === 0) throw new Error('placeFloor: empty room list');

  const placed: PlacedRoom[] = [];
  let cursorXGrid = 0;
  for (let i = 0; i < rooms.length; i++) {
    const piece = rooms[i]!;
    const id: RoomId = `${piece.id}#${i}`;
    if (i > 0) {
      const prev = placed[i - 1]!;
      if (!prev.piece.exits.some((e) => e.edge === 'east')) {
        throw new Error(`placeFloor: '${prev.id}' (stage ${i - 1}) has no east exit to connect to stage ${i}`);
      }
      if (!piece.exits.some((e) => e.edge === 'west')) {
        throw new Error(`placeFloor: '${id}' (stage ${i}) has no west exit to connect to stage ${i - 1}`);
      }
    }
    placed.push({ id, piece, offsetXGrid: cursorXGrid, offsetYGrid: 0, entranceGrid: { x: 0, y: 0 } });
    cursorXGrid += piece.sizeGrid.w;
  }

  const doors: Door[] = [];
  for (let i = 1; i < placed.length; i++) {
    const a = placed[i - 1]!;
    const b = placed[i]!;
    const passageGrid = pickDoorAnchor(a, b, roomgenPrng);
    doors.push({ roomA: a.id, roomB: b.id, passageGrid });
    b.entranceGrid = { x: b.offsetXGrid + ENTRANCE_INSET_GRID, y: passageGrid.y + passageGrid.h / 2 };
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
