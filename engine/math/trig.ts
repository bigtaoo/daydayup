/**
 * Deterministic binary-radian (brad) angles + fp-trig. design/06 calls this
 * "the single biggest new determinism surface vs funny" — funny barely needs
 * trig; DayDayUp fires bullets at arbitrary angles, so facing / velocity /
 * arc-tests all route through here instead of Math.sin/cos/atan2.
 *
 * WHY IT IS DETERMINISTIC:
 *   - sin/cos read a COMMITTED integer table (trig.table.ts, generated offline)
 *     and linear-interpolate with integer arithmetic. No runtime Math.sin.
 *   - atan2Brad uses only add/sub/mul/div and table lookups. IEEE-754 specifies
 *     those four operations exactly, so they ARE bit-identical across JS engines;
 *     only transcendental functions (sin/cos/atan) are not — and those never run
 *     at match time.
 *
 * Angle unit: brad = 16-bit binary radian. 65536 brad = full circle (2π).
 * Stored angles are integers; math is done in this integer space (design/06).
 */
import { FP_SCALE } from './fixed';
import type { Fp } from './fixed';
import { SIN_N, SIN_QUARTER, ATAN_M, ATAN_QUARTER } from './trig.table';

// ── Brad type + constants ──────────────────────────────────────────────────
declare const __bradBrand: unique symbol;
/** 16-bit binary-radian integer angle. 65536 = full circle. */
export type Brad = number & { readonly [__bradBrand]: true };

export const BRAD_FULL = 65536;
export const BRAD_HALF = 32768; // π
export const BRAD_QUARTER = 16384; // π/2
const QUARTER_STEP = BRAD_QUARTER / SIN_N; // brad per sine-table sample (=64)

/** Normalize any integer angle into [0, 65536) as a Brad. */
export function normBrad(b: number): Brad {
  return (b & (BRAD_FULL - 1)) as Brad;
}

// ── sin / cos ────────────────────────────────────────────────────────────────

/** Interpolated quarter-wave sine lookup for x in [0, BRAD_QUARTER]. Returns fp in [0, FP_SCALE]. */
function sinQuarter(x: number): number {
  const idx = Math.floor(x / QUARTER_STEP);
  if (idx >= SIN_N) return SIN_QUARTER[SIN_N]!; // x === BRAD_QUARTER → sin(π/2) = FP_SCALE
  const r = x - idx * QUARTER_STEP; // 0..QUARTER_STEP-1
  const a0 = SIN_QUARTER[idx]!;
  const a1 = SIN_QUARTER[idx + 1]!;
  return a0 + Math.trunc(((a1 - a0) * r) / QUARTER_STEP);
}

/** sin(angle) in fixed-point: returns Fp in [-FP_SCALE, FP_SCALE]. */
export function sinFp(brad: number): Fp {
  const b = normBrad(brad);
  const q = Math.floor(b / BRAD_QUARTER); // quadrant 0..3
  const rem = b - q * BRAD_QUARTER; // 0..BRAD_QUARTER-1
  switch (q) {
    case 0:
      return sinQuarter(rem) as Fp;
    case 1:
      return sinQuarter(BRAD_QUARTER - rem) as Fp;
    case 2:
      return (-sinQuarter(rem) || 0) as Fp; // || 0 normalizes -0 → 0
    default:
      return (-sinQuarter(BRAD_QUARTER - rem) || 0) as Fp;
  }
}

/** cos(angle) in fixed-point: returns Fp in [-FP_SCALE, FP_SCALE]. cos(x) = sin(x + π/2). */
export function cosFp(brad: number): Fp {
  return sinFp(brad + BRAD_QUARTER);
}

// ── atan2 (integer/deterministic) ─────────────────────────────────────────────

/** atan(lo/hi) for 0 <= lo <= hi, returned in brad over [0, 8192] (0..45°). */
function atanUnit(lo: number, hi: number): number {
  const num = lo * ATAN_M;
  const idx = Math.floor(num / hi);
  if (idx >= ATAN_M) return ATAN_QUARTER[ATAN_M]!;
  const rem = num - idx * hi; // 0..hi-1
  const a0 = ATAN_QUARTER[idx]!;
  const a1 = ATAN_QUARTER[idx + 1]!;
  return a0 + Math.trunc(((a1 - a0) * rem) / hi);
}

/**
 * Deterministic atan2 → Brad in [0, 65536). Mirrors Math.atan2(y, x) mapped to
 * [0, 2π): brad increases counter-clockwise from the +x axis toward +y, so that
 * (cosFp(b), sinFp(b)) is proportional to (x, y). Args may be raw ints or Fp
 * (scale-invariant — only the ratio matters).
 */
export function atan2Brad(y: number, x: number): Brad {
  if (x === 0 && y === 0) return 0 as Brad;
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  // First-quadrant angle a in [0, BRAD_QUARTER].
  const a = ay <= ax ? atanUnit(ay, ax) : BRAD_QUARTER - atanUnit(ax, ay);
  let b: number;
  if (x >= 0 && y >= 0) b = a;
  else if (x < 0 && y >= 0) b = BRAD_HALF - a;
  else if (x < 0 && y < 0) b = BRAD_HALF + a;
  else b = BRAD_FULL - a;
  return normBrad(b);
}

// ── angle arithmetic ──────────────────────────────────────────────────────────

/**
 * Signed shortest difference a - b, normalized to [-32768, 32767]. Use for arc
 * tests (melee swing arc, block arc) in integer space instead of radian atan2
 * differences (design/05/07).
 */
export function bradDiff(a: number, b: number): number {
  let d = (a - b) & (BRAD_FULL - 1);
  if (d >= BRAD_HALF) d -= BRAD_FULL;
  return d;
}

// ── input-edge / authoring conversions (NOT for match-time logic) ─────────────

/**
 * Degrees → brad. Authoring/config only (design/09 human-unit conversion, run
 * once at construction). Uses float math; the RESULT integer is what logic sees.
 */
export function degToBrad(deg: number): Brad {
  return normBrad(Math.round((deg / 360) * BRAD_FULL));
}

/**
 * Radians → brad. INPUT-EDGE ONLY (design/06 "quantize aim on input"): a mouse
 * `point` or joystick `dir` is turned into an integer brad here, on the render
 * side; that integer becomes the deterministic PlayerCommand. Float divergence
 * in Math.atan2 upstream is harmless because the quantized brad is what is
 * broadcast/recorded — every client reads the same integer. Never call in a
 * system (use atan2Brad there).
 */
export function radToBrad(rad: number): Brad {
  return normBrad(Math.round((rad / (2 * Math.PI)) * BRAD_FULL));
}

export { FP_SCALE };
