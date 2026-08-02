/**
 * Seeded dungeon assembly (design/05/09, ROADMAP 1.3) — "a seeded layout stitches
 * hand-authored pieces" (design/09's core divergence from funny's one scripted
 * level). `generateFloor` is the pure selection function: given a `DungeonConfig`,
 * which floor, the run's `roomgenPrng`, and a `RoomPiece` library, it returns the
 * ordered room sequence for that floor. Pure and side-effect-free — like
 * `content/rooms.ts roomGeometry`, this does not touch GameState. Placing a generated
 * floor's rooms into a live run (per-room geometry swap, room-to-room advance, the
 * extraction/descend choice) is now wired: `SpawnSystem` calls this when a config opts
 * into `EngineConfig.dungeon` and traverses the returned sequence room by room.
 *
 * Two layouts (design/05 reward-choice structure): `'linear'` is a single ordered
 * room sequence (one candidate per stage); `'branching'` offers `branchFactor`
 * DISTINCT candidate rooms per normal stage and the player picks which to enter
 * (SpawnSystem.chooseBranch). Both share ONE identical roomgenPrng draw per stage —
 * branching expands that single draw into distinct candidates by modular offset — so
 * a linear config's draw sequence (and every pre-branching replay) is byte-identical.
 * The capstone stage is always a single room. A door-based selection UX is a
 * presentation follow-up; the engine resolves the choice from player aim for now.
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
  layout: 'linear' | 'branching'; // see module doc — branching offers a per-stage choice
  branchFactor?: number; // 'branching' only: candidate rooms per normal stage (default 2,
  // clamped to the pool size); ignored for 'linear' (always 1)
  extractionPieceId: string; // this floor's checkpoint room (every floor but the last)
  bossPieceId: string; // the deepest floor's room — doubles as ITS extraction
  difficultyCurve: CurveSpec;
}

/** One floor's generated layout, as an ordered list of STAGES. Each stage is the set
 * of candidate rooms offered at that step: exactly one for a linear layout, up to
 * `branchFactor` distinct candidates for a branching one (the player picks — see
 * SpawnSystem.chooseBranch). The last stage is always the single-room capstone:
 * `extractionPieceId` on every floor except the last, `bossPieceId` on the last
 * (design/05 "the last floor's boss room IS its extraction room"). */
export interface FloorLayout {
  floorIndex: number; // 0-based
  stages: readonly (readonly RoomPiece[])[];
  // Convenience "default path" — the first candidate of each stage. For a LINEAR
  // layout this is the full room sequence (every stage has one room); for branching
  // it is one representative path. Kept so linear callers/tests read a flat list.
  rooms: readonly RoomPiece[];
}

/**
 * Generate one floor deterministically from `roomgenPrng` (design/06/08: same
 * seed + same PRNG draw sequence → identical layout on every client). Draws,
 * in order: (1) how many rooms this floor has, within `roomsPerFloor` — ONE
 * `nextInt` call; (2) one normal STAGE per room-before-the-capstone — one `nextInt`
 * call each, in stage order. For 'linear' a stage is that single drawn piece; for
 * 'branching' the same single draw becomes the stage's `branchFactor` DISTINCT
 * candidates (drawn piece + the next-in-pool wrap-arounds), so both layouts draw the
 * identical roomgenPrng sequence and a linear config stays byte-identical to before.
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
  const normalCount = Math.max(0, roomCount - 1); // the capstone is the final stage

  // Candidates per normal stage: 1 (linear) or branchFactor distinct rooms (branching),
  // never more than the pool has to offer.
  const branchFactor = config.layout === 'branching'
    ? Math.max(1, Math.min(config.branchFactor ?? 2, pool.length))
    : 1;

  const stages: (readonly RoomPiece[])[] = [];
  for (let i = 0; i < normalCount; i++) {
    const base = roomgenPrng.nextInt(pool.length); // the ONE draw this stage costs
    const candidates: RoomPiece[] = [];
    for (let c = 0; c < branchFactor; c++) candidates.push(pool[(base + c) % pool.length]!);
    stages.push(candidates);
  }

  const isLastFloor = floorIndex === config.floorCount - 1;
  const capstoneId = isLastFloor ? config.bossPieceId : config.extractionPieceId;
  const capstone = library.find((p) => p.id === capstoneId);
  if (!capstone) throw new Error(`generateFloor: missing capstone RoomPiece '${capstoneId}'`);
  stages.push([capstone]);

  return { floorIndex, stages, rooms: stages.map((s) => s[0]!) };
}
