/**
 * Shared "nearest candidate by squared position distance" search (design/08 array-
 * order determinism). Extracted 2026-07-28: this exact shape was independently
 * hand-rolled 4 times (HitResolveSystem's `retarget`/ricochet and `chain`/lightning,
 * targeting.ts's `nearestHostile`, CommandBuilder.ts's `nearestEnemyAim`) — the kind
 * of copy-pasted drift that already caused one real bug before (a ricochet re-hit
 * bug from hand-rolled retarget logic, fixed the same session weapon-frame art
 * shipped). Consolidating removes the risk of a 5th copy drifting differently, but
 * ONLY because every call site's exact tie-break behavior is preserved via
 * `preferEarlier` below — the two existing behaviors (see the option's own doc)
 * were NOT unified into one, since design/06 treats tie-break-by-array-order as a
 * tested contract, not an implementation detail free to normalize away.
 */
export interface NearestOptions<T> {
  /** Skip this exact candidate (e.g. the bullet's already-hit target in retarget,
   *  the just-hit actor itself in chain). Omit if nothing needs excluding. */
  exclude?: T;
  /** Squared-distance range cap. Omit (Infinity) for an unlimited search
   *  (nearestHostile's own contract — deflect/homing pick the globally nearest). */
  reachSq?: number;
  /**
   * Tie-break direction when two candidates are EXACTLY squared-distance-equal
   * (not astronomically rare here — fp integer positions on a grid can land
   * symmetric-equidistant often enough to matter, e.g. two enemies mirrored
   * across the player). `true` (default): the FIRST-found candidate wins ties —
   * matches retarget/chain/nearestHostile's original `d >= best → skip` /
   * `d < best → accept` shape. `false`: the LAST-found wins — matches
   * nearestEnemyAim's original `d <= best → accept` shape (render-side auto-aim,
   * lower stakes than sim-internal retargeting, but preserved exactly anyway).
   */
  preferEarlier?: boolean;
}

/** Nearest `candidates` entry to (originX, originY) by squared distance, or null if
 *  none qualify (empty/all-excluded/all-out-of-reach). */
export function nearestByPosition<T extends { gx: number; gy: number }>(
  originX: number,
  originY: number,
  candidates: Iterable<T>,
  opts: NearestOptions<T> = {},
): T | null {
  const { exclude, reachSq = Infinity, preferEarlier = true } = opts;
  let best: T | null = null;
  let bestSq = Infinity;
  for (const c of candidates) {
    if (c === exclude) continue;
    const dx = c.gx - originX;
    const dy = c.gy - originY;
    const d = dx * dx + dy * dy;
    if (d > reachSq) continue;
    if (preferEarlier ? d >= bestSq : d > bestSq) continue;
    bestSq = d;
    best = c;
  }
  return best;
}
