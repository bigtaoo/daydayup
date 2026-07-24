/**
 * Seeded dungeon assembly (design/05/09, ROADMAP 1.3) — "a seeded layout stitches
 * hand-authored pieces" (design/09's core divergence from funny's one scripted
 * level). `generateFloor` is the pure selection function: given a `DungeonConfig`,
 * which floor, the run's `roomgenPrng`, and a `RoomPiece` library, it returns the
 * ordered room sequence for that floor. Pure and side-effect-free — like
 * `content/rooms.ts roomGeometry`, this does not touch GameState; actually placing
 * a generated floor's rooms into a live run (mutable geometry, room-to-room
 * transitions, the extraction/descend choice) is 1.4/1.5.
 *
 * Only `layout: 'linear'` is implemented — a single ordered room sequence, no
 * branching paths. `'branching'` (design/09's reward-choice structure) is the
 * follow-up, same "ship the simpler shape first" precedent as ballistics' `orbit`.
 */
import type { Prng } from '../math/prng';
import type { RoomPiece } from '../content/rooms';

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
  layout: 'linear'; // 'branching' not yet implemented (see module doc)
  extractionPieceId: string; // this floor's checkpoint room (every floor but the last)
  bossPieceId: string; // the deepest floor's room — doubles as ITS extraction
  difficultyCurve: CurveSpec;
}

/** One floor's generated room sequence, in traversal order. The last entry is
 * always the floor's capstone: `extractionPieceId` on every floor except the
 * last, `bossPieceId` on the last (design/05 "the last floor's boss room IS its
 * extraction room"). */
export interface FloorLayout {
  floorIndex: number; // 0-based
  rooms: readonly RoomPiece[];
}

/**
 * Generate one floor deterministically from `roomgenPrng` (design/06/08: same
 * seed + same PRNG draw sequence → identical layout on every client). Draws,
 * in order: (1) how many rooms this floor has, within `roomsPerFloor` — ONE
 * `nextInt` call; (2) one normal piece per room-before-the-capstone, drawn from
 * the tag-matched pool — one `nextInt` call each, in room order.
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

  const rooms: RoomPiece[] = [];
  for (let i = 0; i < normalCount; i++) {
    rooms.push(pool[roomgenPrng.nextInt(pool.length)]!);
  }

  const isLastFloor = floorIndex === config.floorCount - 1;
  const capstoneId = isLastFloor ? config.bossPieceId : config.extractionPieceId;
  const capstone = library.find((p) => p.id === capstoneId);
  if (!capstone) throw new Error(`generateFloor: missing capstone RoomPiece '${capstoneId}'`);
  rooms.push(capstone);

  return { floorIndex, rooms };
}
