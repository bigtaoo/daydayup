import type { Fp, PickupItem } from '@dd/engine';

// Pure proximity check for the design/03 weapon-pickup panel ("standing next to one or
// more floor weapons pops a non-blocking click-to-collect list"). Deliberately NOT the
// pickup's own collect radius (PickupSystem's SIM.pickupRadius) — this is the wider,
// render-only ring the panel is shown (and clickable) from, matching PickupSystem's own
// SIM.lootRevealRadius gate for weapon-kind collection. Squared-distance, no sqrt
// (matches the engine's own geom.ts convention), but this lives in the render layer
// since it's UI-only and never feeds the sim.

/** Every alive `weapon`-kind pickup within `radius` of (px, py), nearest first.
 * All units Fp (fixed-point, same space as GameState positions). */
export function nearbyWeaponPickups(
  pickups: readonly PickupItem[],
  px: Fp,
  py: Fp,
  radius: Fp,
): PickupItem[] {
  const r2 = radius * radius;
  const found: Array<{ item: PickupItem; d2: number }> = [];
  for (const item of pickups) {
    if (!item.alive || item.kind !== 'weapon') continue;
    const dx = item.gx - px;
    const dy = item.gy - py;
    const d2 = dx * dx + dy * dy;
    if (d2 <= r2) found.push({ item, d2 });
  }
  found.sort((a, b) => a.d2 - b.d2);
  return found.map((f) => f.item);
}
