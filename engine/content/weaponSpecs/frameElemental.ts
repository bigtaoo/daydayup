/**
 * Frame-library elemental variants (design/03's "N frames × 5 elements" combo was
 * only ever realized on `straight` — Phase 1.1's 7 newer frames shipped physical-
 * only; these are the first two elemental siblings, same shape as their physical
 * counterpart with the frame's own numbers, an element layered on, and the same
 * "one tier up" rarity step the original flamer/cryobolt/etc. set (03/05). Split
 * out of weaponSpecs.ts, CLAUDE.md "500-line file convention", form ①; see
 * starter.ts's header for the split rationale.
 */
import type { WeaponSpec } from '../weaponTypes';

export const FRAME_ELEMENTAL_WEAPON_SPECS: Record<string, WeaponSpec> = {
  // Cinderscatter (fire scattergun): the scattergun's cone, with burn on every pellet
  // that lands — point-blank still wins, but now the DoT keeps ticking after you back off.
  cinderscatter: {
    id: 'cinderscatter',
    kind: 'ranged',
    nameKey: 'weapon.cinderscatter.name',
    skinRef: 'gun_default',
    rarity: 'epic', // 紫 — one tier up from scattergun's fine

    cooldownSec: 0.6, // slightly slower than scattergun — the burn does extra work
    bullets: 5,
    spreadDeg: 32, // a touch wider — closer to a fire "blast" than a clean cone
    bulletSpeed: 10,
    damage: 1,
    damageType: 'fire',
    ballistic: 'straight',
    // Energy per trigger pull (design/03/05, balance/energy.ts): spread x5 plus a burn on every pellet — 27/s, the priciest of the two scatter frames
    energyCost: 16,
    lifespanSec: 0.5, // short reach — fire's own convention (flamer/emberblade)
    bulletRadius: 0.14,
    muzzleGrid: 0.9375,
    bulletZ: 0.5,
  },

  // Frostseeker (ice seeker): the seeker's tracking bolt, now chilling whatever it
  // finally connects with — control on top of control, at the cost of raw pace.
  frostseeker: {
    id: 'frostseeker',
    kind: 'ranged',
    nameKey: 'weapon.frostseeker.name',
    skinRef: 'gun_default',
    rarity: 'legend', // 橙 — one tier up from seeker's epic

    cooldownSec: 0.75,
    bullets: 1,
    spreadDeg: 0,
    bulletSpeed: 6, // slower than seeker — ice's own deliberate pace (cryobolt/frostbrand)
    damage: 2,
    damageType: 'ice',
    ballistic: 'homing',
    // Energy per trigger pull (design/03/05, balance/energy.ts): homing that also chills: the seeker price plus the cryobolt reason — 27/s
    energyCost: 20,
    turnRateDegPerSec: 220, // slightly less brisk than seeker — the chill is the payoff
    lifespanSec: 2.8,
    bulletRadius: 0.16,
    muzzleGrid: 0.9375,
    bulletZ: 0.5,
  },
};
