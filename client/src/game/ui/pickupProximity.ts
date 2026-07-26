import type { Fp, PickupItem } from '@dd/engine';

// Pure proximity check for the design/03 ground compare card ("standing next to a
// floor weapon floats a non-blocking card"). Deliberately NOT the pickup's own
// collect radius (PickupSystem, which auto-swaps on overlap) — this is a wider,
// render-only ring so the card appears just before collection, giving the player a
// beat to see what they're about to pick up. Squared-distance, no sqrt (matches the
// engine's own geom.ts convention), but this lives in the render layer since it's
// UI-only and never feeds the sim.

/** The nearest alive `weapon`-kind pickup within `radius` of (px, py), or undefined.
 * All units Fp (fixed-point, same space as GameState positions). */
export function nearestWeaponPickup(
  pickups: readonly PickupItem[],
  px: Fp,
  py: Fp,
  radius: Fp,
): PickupItem | undefined {
  const r2 = radius * radius;
  let best: PickupItem | undefined;
  let bestD2 = Infinity;
  for (const item of pickups) {
    if (!item.alive || item.kind !== 'weapon') continue;
    const dx = item.gx - px;
    const dy = item.gy - py;
    const d2 = dx * dx + dy * dy;
    if (d2 <= r2 && d2 < bestD2) {
      best = item;
      bestD2 = d2;
    }
  }
  return best;
}
