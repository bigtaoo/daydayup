import { SIM } from '@dd/engine';
import type { Fp, PickupItem } from '@dd/engine';

// Pure proximity check for the design/03 weapon-pickup panel ("standing next to one or
// more floor weapons pops a non-blocking click-to-collect list"). Deliberately NOT the
// pickup's own collect radius (PickupSystem's SIM.pickupRadius) — this is the wider,
// render-only ring the panel is shown (and clickable) from, matching PickupSystem's own
// SIM.lootRevealRadius gate for weapon-kind collection. Squared-distance, no sqrt
// (matches the engine's own geom.ts convention), but this lives in the render layer
// since it's UI-only and never feeds the sim.

/**
 * Weapon-pickup panel proximity ring (design/03) — wider than `PickupSystem`'s own tight collect
 * radius (`SIM.pickupRadius`) so the panel has a beat to show before it is even clickable. The
 * SAME constant `PickupSystem`'s weapon-kind branch gates collection on, which is what makes
 * "if the panel shows it, you can click it" true; it is also the constant that resolves an arena
 * crate, so a resolved weapon pickup is always already known by the time the panel wants it.
 *
 * Lives here rather than in `HudView`, where it was until 2026-08-31, for one reason: the
 * agreement between this ring and the sim's own gate is the only *"无法拾取"* mechanism that
 * neither package's suite can see on its own, and the test that pins it
 * (`pickupProximity.test.ts`) has to read the real number rather than restate it. Reaching into
 * `HudView` for it would drag Pixi into a pure test.
 */
export const WEAPON_PROMPT_RADIUS_FP = SIM.lootRevealRadius;

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
