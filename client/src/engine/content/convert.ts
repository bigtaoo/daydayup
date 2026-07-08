/**
 * Construction-time human-unit → sim-unit converters (design/09). These run ONCE
 * when the content catalog is built, never inside a system at match time. They use
 * float math and Math.round; the RESULT integer is what the deterministic core
 * sees, so a one-time rounding here is fine (it is committed identically for every
 * client). Contrast with the engine's `toFp` (Math.trunc) which is the runtime fp
 * constructor — the authoring family below rounds, per the design/09 spec.
 *
 * Unit anchors (design/06/09):
 *   1 grid unit = WORLD.pxPerGrid px      · FP_SCALE fp = 1 grid
 *   sim runs @ TICK_RATE Hz               · full circle = BRAD_FULL brad
 */
import { FP_SCALE, TICK_RATE, TICK_DT_FP, type Fp } from '../math/fixed';
import { WORLD } from '../config';

/** Seconds → whole ticks. toTicks(0.2) = round(0.2·30) = 6. */
export function toTicks(sec: number): number {
  return Math.round(sec * TICK_RATE);
}

/** Grid units → fp (rounded, authoring-only). toFpGrid(0.15) = round(0.15·1000) = 150. */
export function toFpGrid(grid: number): Fp {
  return Math.round(grid * FP_SCALE) as Fp;
}

/** Grid/second → fp per second (rounded). toFpS(10) = 10000. */
export function toFpS(gridPerSec: number): Fp {
  return Math.round(gridPerSec * FP_SCALE) as Fp;
}

/**
 * Grid/second → fp displacement per tick, so MovementSystem is a plain addFp with
 * no per-tick dt multiply (design/08). fp/s × TICK_DT_FP / FP_SCALE, truncated —
 * uses the same truncated dt (33 = ⌊1000/30⌋) the runtime integrator would, so the
 * baked-in velocity matches a dt-multiplied one bit-for-bit. Blaster: 10 grid/s →
 * 10000 fp/s → ⌊10000·33/1000⌋ = 330 fp/tick.
 */
export function toFpPerTick(gridPerSec: number): Fp {
  return Math.trunc((toFpS(gridPerSec) * TICK_DT_FP) / FP_SCALE) as Fp;
}

/**
 * Pixels → fp, via grid. The px→grid boundary lives at the engine's edge: the
 * render/demo layer is px-native, the sim is grid-native, and EngineConfig
 * (world bounds, wave/player-start positions) plus any ported Stage-B px tuning
 * cross here. pxToFp(800) = round(800·1000/32) = 25000 (= 25 grid). Rounded to
 * match the authoring family above.
 */
export function pxToFp(px: number): Fp {
  return Math.round((px * FP_SCALE) / WORLD.pxPerGrid) as Fp;
}
