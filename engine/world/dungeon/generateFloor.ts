/**
 * Floor generation — choosing WHICH rooms make up a floor (split out of
 * dungeon.ts, CLAUDE.md "500-line file convention", form ①: an independent, pure,
 * side-effect-free function with no shared state with the placement concern in
 * the sibling place*.ts files). Placement (turning the chosen sequence into a
 * co-resident, door-connected floor) lives in ./placeFloor.ts / ./placeFloorGraph2d.ts.
 */
import type { Prng } from '../../math/prng';
import type { RoomPiece } from '../../content/rooms';
import type { CurveSpec, DungeonConfig, FloorLayout, FloorStage } from './types';

export function curveAt(curve: CurveSpec, floorIndex: number): number {
  return curve.base + curve.perFloor * floorIndex;
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
