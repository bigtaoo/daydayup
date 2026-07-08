/**
 * Engine-global constants (design/09 "all numbers live in @dd/engine config").
 * Balance/content numbers (weapons, enemies, drops) live under content/ and
 * balance/; this file holds only cross-cutting constants and the version guard.
 */
import { TICK_RATE, FP_SCALE } from './math/fixed';
import { BRAD_FULL } from './math/trig';

/**
 * Bumped whenever a change to the core could make an old recorded input stream
 * diverge (system reorder, fp/brad/table change, new PRNG draw site). design/08:
 * ReplayInputSource refuses a mismatched version — fail loud, never replay garbage.
 *
 * v2 (Stage C): spatial unit switched from px-as-fp to real grid (1 grid = 32 px)
 * and weapon/actor numbers moved to the content catalog, so every stored fp
 * position/velocity and weapon value differs from v1 — a v1 input stream would
 * diverge immediately.
 */
export const ENGINE_VERSION = 2;

/**
 * World scale — the anchor for every human-unit → fp/brad conversion (design/09).
 * 1 grid unit = 32 px. The demo slice runs render @60fps; the sim runs @30Hz.
 */
export const WORLD = {
  pxPerGrid: 32,
  tickRate: TICK_RATE,
  fpScale: FP_SCALE,
  bradFull: BRAD_FULL,
} as const;

export { TICK_RATE, FP_SCALE };
