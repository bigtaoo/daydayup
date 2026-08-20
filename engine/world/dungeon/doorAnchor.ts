/**
 * Where a door's passage sits along the band two touching rooms share — the one
 * piece of math `placeFloor`'s `pickDoorAnchor` and `placeFloorGraph2d`'s
 * `pickDoorAnchor2d` had verbatim in common, now shared instead of duplicated
 * (CLAUDE.md "500-line file convention", form ①: an independent function module,
 * no state of its own).
 */
import { DOOR_ANCHOR_COUNT, DOOR_EDGE_MARGIN_GRID, DOOR_WIDTH_GRID } from './placementConstants';
import type { Prng } from '../../math/prng';

/**
 * Draw where a `DOOR_WIDTH_GRID`-wide passage STARTS along the band `[overlapLo,
 * overlapHi)` two adjacent rooms share, or `null` if the band is too short to fit
 * one at all (the caller raises its own fail-loud error, design/09 — the two
 * placement functions word it differently and both messages are pinned by tests).
 * Costs exactly ONE `roomgenPrng` draw when it fits, and none when it doesn't.
 *
 * `DOOR_ANCHOR_COUNT` evenly-spaced candidates are offered and one is drawn, so a
 * door is never wall-centered by construction (design/05 "~5 positions per wall...
 * a snapping aid, not a constraint baked into the data shape").
 *
 * **The result is snapped to a whole grid cell** (`ENGINE_VERSION` 44, 2026-08-20).
 * That is the whole reason this function exists rather than the two inlined copies:
 * `DOOR_EDGE_MARGIN_GRID` is 1.5, so `overlapLo + DOOR_EDGE_MARGIN_GRID` is a
 * half-integer, and `span / (DOOR_ANCHOR_COUNT - 1)` is a quarter-integer — an
 * unsnapped anchor could land on a HALF or even a QUARTER cell, and every wall
 * `carveDoorGaps` then cuts inherits that offset. Four wall runs in shipped
 * level-1 content were left 16 px deep that way (`design/01-rendering.md` "A
 * north-south run is not an east-west wall": a cap band a third of the depth every
 * wall tone was measured on, and the geometry that made the occlusion x-ray need
 * its second face-fading pass). The passage is `DOOR_WIDTH_GRID` (an even integer)
 * wide, so snapping the START snaps its far edge and its centre too.
 *
 * Snapping is `Math.round` on an exact binary quarter — every input here is a sum
 * of integers, halves and quarters, so there is no platform-dependent rounding to
 * worry about (design/06 determinism). The fit test is deliberately UNCHANGED and
 * still measured against the unsnapped 1.5 margin, so no room pair that connected
 * before stops connecting and none that failed before starts. Rounding an anchor
 * outward can spend at most half of that margin, which still leaves a full cell —
 * the perimeter wall's own thickness — between the gap and the corner block: the
 * gap sits flush against the corner's inner face and never cuts into it.
 */
export function pickPassageStartGrid(
  overlapLo: number,
  overlapHi: number,
  roomgenPrng: Prng,
): number | null {
  const bandLo = overlapLo + DOOR_EDGE_MARGIN_GRID;
  const bandHi = overlapHi - DOOR_EDGE_MARGIN_GRID;
  const span = bandHi - bandLo - DOOR_WIDTH_GRID;
  if (span < 0) return null;
  const candidateCount = span === 0 ? 1 : DOOR_ANCHOR_COUNT;
  const step = candidateCount > 1 ? span / (candidateCount - 1) : 0;
  const chosen = roomgenPrng.nextInt(candidateCount); // the ONE draw this door costs
  return Math.round(bandLo + step * chosen);
}
