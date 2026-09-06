/**
 * Elemental weapons (design/03 "distinct behavior" — each layers an on-hit status
 * the combat systems interpret; see content/damage.ts). Split out of weaponSpecs.ts,
 * CLAUDE.md "500-line file convention", form ①; see starter.ts's header for the
 * split rationale.
 */
import type { WeaponSpec } from '../weaponTypes';

export const ELEMENTAL_WEAPON_SPECS: Record<string, WeaponSpec> = {
  // Flamer (fire): short-range sprayer. Fast, weak per shot, but burn refreshes on
  // every hit → continuous DoT while you keep the stream on target. Short lifespan
  // = you must close in — the fire trade-off (range for damage-over-time).
  flamer: {
    id: 'flamer',
    kind: 'ranged',
    nameKey: 'weapon.flamer.name',
    skinRef: 'gun_default',
    rarity: 'fine', // 蓝

    cooldownSec: 0.1, // 3 ticks — 10 shots/s, keeps burn topped up
    bullets: 1,
    spreadDeg: 0,
    bulletSpeed: 9,
    damage: 1,
    damageType: 'fire',
    ballistic: 'straight',
    // Energy per trigger pull (design/03/05, balance/energy.ts): a 30/s fire hose — sustainable in bursts, not held down; the element is the mechanic
    energyCost: 3,
    lifespanSec: 0.55, // short reach — the flamethrower band
    bulletRadius: 0.22,
    muzzleGrid: 0.9375,
    bulletZ: 0.5,
  },

  // Cryobolt (ice): slow, deliberate shot that chills — the target crawls while you
  // reposition or line up the next hit. Higher single-hit than the flamer; the value
  // is control, not raw dps.
  cryobolt: {
    id: 'cryobolt',
    kind: 'ranged',
    nameKey: 'weapon.cryobolt.name',
    skinRef: 'gun_default',
    rarity: 'epic', // 紫

    cooldownSec: 0.5, // 15 ticks
    bullets: 1,
    spreadDeg: 0,
    bulletSpeed: 11,
    damage: 2,
    damageType: 'ice',
    ballistic: 'straight',
    // Energy per trigger pull (design/03/05, balance/energy.ts): chill is a movement debuff
    // stacked on top of the damage — 24/s
    energyCost: 12,
    lifespanSec: 3.0,
    bulletRadius: 0.18,
    muzzleGrid: 0.9375,
    bulletZ: 0.5,
  },

  // Teslagun (lightning): every hit arcs to a second nearby enemy for half damage —
  // the crowd-clear gun. Middling on a lone target, excellent into a pack.
  teslagun: {
    id: 'teslagun',
    kind: 'ranged',
    nameKey: 'weapon.teslagun.name',
    skinRef: 'gun_default',
    rarity: 'epic', // 紫

    cooldownSec: 0.35, // ~11 ticks
    bullets: 1,
    spreadDeg: 0,
    bulletSpeed: 13, // fast, snappy
    damage: 2,
    damageType: 'lightning',
    ballistic: 'straight',
    // Energy per trigger pull (design/03/05, balance/energy.ts): chain: one pull reaches a second body — 26/s
    energyCost: 9,
    lifespanSec: 2.0,
    bulletRadius: 0.15,
    muzzleGrid: 0.9375,
    bulletZ: 0.5,
  },

  // Venomspit (poison): each hit adds an independent stack; sustained fire ramps a
  // target toward heavy DoT that keeps ticking after you break off. The patient-DPS
  // gun — kill things that are already walking away.
  venomspit: {
    id: 'venomspit',
    kind: 'ranged',
    nameKey: 'weapon.venomspit.name',
    skinRef: 'gun_default',
    rarity: 'fine', // 蓝

    cooldownSec: 0.22, // ~7 ticks — stacks build with uptime
    bullets: 1,
    spreadDeg: 0,
    bulletSpeed: 9,
    damage: 1,
    damageType: 'poison',
    ballistic: 'straight',
    // Energy per trigger pull (design/03/05, balance/energy.ts): poison stacks ramp with UPTIME, so uptime is what it pays for: 23/s
    energyCost: 5,
    lifespanSec: 2.5,
    bulletRadius: 0.16,
    muzzleGrid: 0.9375,
    bulletZ: 0.5,
  },

  // Emberblade (fire melee): the saber's burst + a burn on everything the arc
  // touches. Swing, back off, let the fire finish the wave. Parries like the saber.
  emberblade: {
    id: 'emberblade',
    kind: 'melee',
    nameKey: 'weapon.emberblade.name',
    skinRef: 'sword_default',
    rarity: 'legend', // 橙

    cooldownSec: 0.37,
    damage: 2,
    damageType: 'fire',
    arcDeg: 162,
    rangeGrid: 1.44,
    swingSec: 0.13,
    knockback: 6,
    deflect: true,
    deflectSpeed: 14.4,
  },

  // Frostbrand (ice melee): a wider, slower crowd-control swing that chills the
  // whole arc — everything it hits crawls, so a swarm can't collapse on you. Parries.
  frostbrand: {
    id: 'frostbrand',
    kind: 'melee',
    nameKey: 'weapon.frostbrand.name',
    skinRef: 'sword_default',
    rarity: 'legend', // 橙

    cooldownSec: 0.45, // slower recovery — control weapon
    damage: 2,
    damageType: 'ice',
    arcDeg: 200, // sweeping arc
    rangeGrid: 1.5,
    swingSec: 0.15,
    knockback: 5,
    deflect: true,
    deflectSpeed: 14.4,
  },

  // Stormglaive (lightning melee): long reach; each enemy the arc hits also arcs to
  // a neighbour. Reach + chain makes one swing clear a line. Parries.
  stormglaive: {
    id: 'stormglaive',
    kind: 'melee',
    nameKey: 'weapon.stormglaive.name',
    skinRef: 'sword_default',
    rarity: 'legendary', // 金 — the top-tier showcase drop

    cooldownSec: 0.4,
    damage: 2,
    damageType: 'lightning',
    arcDeg: 150,
    rangeGrid: 1.9, // longest melee reach
    swingSec: 0.14,
    knockback: 6,
    deflect: true,
    deflectSpeed: 14.4,
  },
};
