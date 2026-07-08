// Render-side unit conversion. The engine is grid-native fixed-point (1 grid =
// FP_SCALE fp = 32 px); the render layer is the ONLY place fp/brad are turned back
// into screen px/radians (design/06 "fromFp is render-only, never in logic").
import { fromFp, WORLD, type Fp } from '@dd/engine';

/** px per grid unit (engine WORLD scale). */
export const PX_PER_GRID = WORLD.pxPerGrid; // 32

/** fp grid → screen px. Render only. */
export function fpToPx(v: Fp): number {
  return fromFp(v) * PX_PER_GRID;
}

/**
 * brad → radians, for Pixi rotations. Render only — the input edge goes the other
 * way with radToBrad (math/trig), which is the quantization that stays deterministic.
 */
export function bradToRad(brad: number): number {
  return (brad / WORLD.bradFull) * Math.PI * 2;
}
