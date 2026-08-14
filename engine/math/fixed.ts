/**
 * Fixed-point arithmetic utilities. Ported verbatim from the sibling project
 * `funny` (server/engine/src/math/fixed.ts) per design/06 — DayDayUp reuses its
 * proven deterministic core. Do not diverge without a reason recorded in 06/08.
 *
 * Convention: 1 grid unit = FP_SCALE integer units (fp).
 *
 * ENFORCEMENT RULES — apply to ALL game-logic files (design/06 banned list):
 *   ✗  Math.random()          → use Prng
 *   ✗  Date.now() / new Date  → forbidden in logic layer
 *   ✗  Math.sqrt/sin/cos/atan2 → use isqrt / math/trig.ts
 *   ✗  Assigning raw number to an Fp field  → TypeScript will error
 *   ✓  Use toFp / fp / addFp / subFp / mulFp / scaleFp / negFp for all fp ops
 */

// ── Constants ────────────────────────────────────────────────────────────────

/** 1 grid unit expressed in fixed-point integers (scale factor). */
export const FP_SCALE = 1000;

/** Logic tick rate in Hz (design/06; open question notes 20 Hz low-end fallback). */
export const TICK_RATE = 30;

/**
 * One tick duration in fixed-point.
 * dt = 1/30 s → 1000/30 = 33.33… → truncated to 33_fp.
 * Identical truncation on all clients → deterministic.
 */
export const TICK_DT_FP = Math.trunc(FP_SCALE / TICK_RATE) as Fp; // 33

// ── Branded Fp type ───────────────────────────────────────────────────────────

declare const __fpBrand: unique symbol;

/**
 * Fixed-point integer (scale = FP_SCALE = 1000).
 *
 * Branded so TypeScript rejects accidental assignment of plain floats to fp fields:
 *   unit.y_fp = 1.5;          // ✗ compile error — number is not assignable to Fp
 *   unit.y_fp = toFp(1.5);    // ✓
 *   unit.y_fp = addFp(a, b);  // ✓
 *
 * Arithmetic operators (+/-/*) on `Fp` still return plain `number`.
 * Always use the helpers below so the result is re-branded as `Fp`.
 */
export type Fp = number & { readonly [__fpBrand]: true };

// ── Constructors ─────────────────────────────────────────────────────────────

/**
 * Convert float grid units to fixed-point.
 * e.g. toFp(1.5) → 1500_fp
 */
export function toFp(gridUnits: number): Fp {
  return Math.trunc(gridUnits * FP_SCALE) as Fp;
}

/**
 * Treat a raw integer as an Fp value WITHOUT multiplication.
 * Use only when the integer is already correctly scaled.
 * e.g. fp(1000) → 1000_fp = 1 grid unit
 */
export function fp(rawInt: number): Fp {
  return rawInt as Fp;
}

// ── Arithmetic ───────────────────────────────────────────────────────────────

/** a + b (both fp → fp) */
export function addFp(a: Fp, b: Fp): Fp {
  return (a + b) as Fp;
}

/** a - b (both fp → fp) */
export function subFp(a: Fp, b: Fp): Fp {
  return (a - b) as Fp;
}

/**
 * Fixed-point multiply: Math.trunc(a × b / FP_SCALE).
 * Required for any fp × fp operation (e.g. speed_fp × dt_fp).
 */
export function mulFp(a: Fp, b: Fp): Fp {
  return Math.trunc((a * b) / FP_SCALE) as Fp;
}

/**
 * Scale an Fp value by a plain integer coefficient.
 * Use for direction × displacement, or constant factors.
 * `intMultiplier` must be a safe integer (never a float).
 * e.g. scaleFp(-1, dy_fp) → negate displacement
 */
export function scaleFp(intMultiplier: number, a: Fp): Fp {
  return Math.trunc(intMultiplier * a) as Fp;
}

/** Negate an fp value: -a */
export function negFp(a: Fp): Fp {
  return (-a) as Fp;
}

/**
 * Deterministic integer square root: floor(√n) for n ≥ 0, using only integer
 * arithmetic (no Math.sqrt → no platform float divergence). Used by the
 * projectile/collision systems to measure fp distance.
 *
 * Bit-by-bit ("digit-by-digit") method — O(log n), exact for all safe integers.
 * Input must be a non-negative integer (e.g. dx*dx + dy*dy in fp²); a negative
 * input clamps to 0.
 *
 * `res`/`bit` are divided with Math.trunc(x / 2) rather than the `>>` operator:
 * `bit` starts at the largest power of 4 ≤ n and can legitimately exceed 2^31
 * for large n, and `>>` coerces its operand to a 32-bit SIGNED integer first —
 * silently wrapping/corrupting the result for any n ≥ 2^32. Math.trunc has no
 * such width limit (exact up to Number.MAX_SAFE_INTEGER).
 */
export function isqrt(n: number): number {
  if (n <= 0) return 0;
  // Highest power of 4 ≤ n.
  let bit = 1;
  while (bit * 4 <= n) bit *= 4;
  let res = 0;
  let rem = n;
  while (bit !== 0) {
    if (rem >= res + bit) {
      rem -= res + bit;
      res = Math.trunc(res / 2) + bit;
    } else {
      res = Math.trunc(res / 2);
    }
    bit = Math.trunc(bit / 4);
  }
  return res;
}

// ── Conversion (render layer ONLY — never use in logic) ──────────────────────

/**
 * Convert fixed-point back to float grid units.
 * FOR RENDERING ONLY. Never call this inside game logic.
 */
export function fromFp(value: Fp): number {
  return value / FP_SCALE;
}
