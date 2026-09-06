/**
 * Frame library (design/03 landing order, ROADMAP 1.1) — one showcase weapon per
 * new frame beyond straight/saber, each physical so the frame's own behavior reads
 * clearly, independent of the element layer (see elemental.ts). Also carries the
 * v28 k_* proc showcases (carom/leech), same "one showcase per new mechanic"
 * convention. Split out of weaponSpecs.ts, CLAUDE.md "500-line file convention",
 * form ①; see starter.ts's header for the split rationale.
 */
import type { WeaponSpec } from '../weaponTypes';

export const FRAME_LIBRARY_WEAPON_SPECS: Record<string, WeaponSpec> = {
  // Scattergun (spread emission): a cone of pellets — near-free on top of the
  // existing bullets/spreadDeg fields (03 "near-free, adds a sharp new feel").
  // Each pellet is weak alone; the cone is the payoff at close range.
  scattergun: {
    id: 'scattergun',
    kind: 'ranged',
    nameKey: 'weapon.scattergun.name',
    skinRef: 'gun_default',
    rarity: 'fine', // 蓝

    cooldownSec: 0.55, // slow recovery — a burst weapon, not a spray
    bullets: 5,
    spreadDeg: 28,
    bulletSpeed: 11,
    damage: 1, // ×5 pellets at point-blank
    ballistic: 'straight',
    // Energy per trigger pull (design/03/05, balance/energy.ts): spread x5, charged ONCE for the pull and not per pellet (balance/energy.ts) — 25/s
    energyCost: 14,
    lifespanSec: 0.6, // short reach — a shotgun, not a sniper
    bulletRadius: 0.14,
    muzzleGrid: 0.9375,
    bulletZ: 0.5,
  },

  // Seeker (homing): curves toward the nearest enemy — "the strongest new
  // behavior" (03). Slow and low-damage so tracking is the payoff, not raw power.
  seeker: {
    id: 'seeker',
    kind: 'ranged',
    nameKey: 'weapon.seeker.name',
    skinRef: 'gun_default',
    rarity: 'epic', // 紫

    cooldownSec: 0.7,
    bullets: 1,
    spreadDeg: 0,
    bulletSpeed: 7, // slow — gives the turn time to matter
    damage: 2,
    ballistic: 'homing',
    // Energy per trigger pull (design/03/05, balance/energy.ts): homing does not miss, which is the single most valuable property on this axis — 26/s
    energyCost: 18,
    turnRateDegPerSec: 260, // brisk but not instant-lock
    lifespanSec: 2.5,
    bulletRadius: 0.16,
    muzzleGrid: 0.9375,
    bulletZ: 0.5,
  },

  // Mortar (lob): fake-3D arc that lands as an AoE blast — over-cover reach the
  // straight ballistics can't offer (03). No direct-hit special-case; it simply
  // detonates when its flight ends.
  mortar: {
    id: 'mortar',
    kind: 'ranged',
    nameKey: 'weapon.mortar.name',
    skinRef: 'gun_default',
    rarity: 'epic', // 紫

    cooldownSec: 0.9, // slow — the AoE is the payoff, not the direct hit
    bullets: 1,
    spreadDeg: 0,
    bulletSpeed: 8,
    damage: 2, // AoE blast damage (no separate direct-hit case)
    ballistic: 'lob',
    // Energy per trigger pull (design/03/05, balance/energy.ts): lob detonates an AoE blast through the full resist/status path — 24/s
    energyCost: 22,
    blastRadiusGrid: 1.3,
    lifespanSec: 1.0, // flight time to landing
    bulletRadius: 0.2,
    muzzleGrid: 0.9375,
    bulletZ: 1.2, // cosmetic arc peak
  },

  // Lasercutter (beam): hitscan line, damage ticked over a short window — pairs
  // naturally with fire DoT (03), shipped physical here to isolate the frame.
  lasercutter: {
    id: 'lasercutter',
    kind: 'ranged',
    nameKey: 'weapon.lasercutter.name',
    skinRef: 'gun_default',
    rarity: 'legend', // 橙

    cooldownSec: 0.8, // recovery between beam channels
    bullets: 1,
    spreadDeg: 0,
    bulletSpeed: 0, // beam does not travel (hitscan; frozen origin/direction)
    damage: 1, // per tick, for beamSec / beamTickIntervalSec ticks
    ballistic: 'beam',
    // Energy per trigger pull (design/03/05, balance/energy.ts): beam damages on a cadence for a whole 0.4s window per pull — 28/s
    energyCost: 22,
    beamSec: 0.4,
    beamTickIntervalSec: 0.1, // 4 damage ticks per channel
    beamRangeGrid: 3.5, // max reach along the frozen facing
    lifespanSec: 0.4, // matches beamSec — the channel's total lifetime
    bulletRadius: 0.1,
    muzzleGrid: 0.9375,
    bulletZ: 0.5,
  },

  // Tomahawk (boomerang): flies out, reverses, flies back — hits going both ways.
  // A commitment weapon: miss the return arc and you're unarmed for the cooldown.
  tomahawk: {
    id: 'tomahawk',
    kind: 'ranged',
    nameKey: 'weapon.tomahawk.name',
    skinRef: 'gun_default',
    rarity: 'legend', // 橙

    cooldownSec: 0.6,
    bullets: 1,
    spreadDeg: 0,
    bulletSpeed: 10,
    damage: 2,
    ballistic: 'boomerang',
    // Energy per trigger pull (design/03/05, balance/energy.ts): boomerang hits going out AND coming back — 27/s
    energyCost: 16,
    returnAfterSec: 0.35, // outbound leg length before it reverses
    lifespanSec: 1.2, // enough for the full out-and-back
    bulletRadius: 0.18,
    muzzleGrid: 0.9375,
    bulletZ: 0.5,
  },

  // Hammer (melee frame): wide arc, high knockback, slow — one big deflect
  // sector, crowd control (03). Parries like every melee weapon.
  hammer: {
    id: 'hammer',
    kind: 'melee',
    nameKey: 'weapon.hammer.name',
    skinRef: 'sword_default',
    rarity: 'fine', // 蓝

    cooldownSec: 0.65, // slow recovery — one big swing, not a flurry
    damage: 3,
    arcDeg: 220, // wide sweep
    rangeGrid: 1.3,
    swingSec: 0.2,
    knockback: 12, // heavy shove
    deflect: true,
    deflectSpeed: 14.4,
  },

  // Spear (melee frame): narrow arc, long reach — deflect/poke at distance (03).
  // The opposite pole from hammer: precision over crowd control.
  spear: {
    id: 'spear',
    kind: 'melee',
    nameKey: 'weapon.spear.name',
    skinRef: 'sword_default',
    rarity: 'fine', // 蓝

    cooldownSec: 0.3, // fast recovery — a poke, not a heavy swing
    damage: 2,
    arcDeg: 60, // narrow
    rangeGrid: 2.1, // longest reach in the roster
    swingSec: 0.1,
    knockback: 4,
    deflect: true,
    deflectSpeed: 14.4,
  },

  // Novaburst (radial emission): fires a full even ring of pellets in every direction at
  // once — orthogonal to ballistic, deterministic (no spread PRNG). A panic-button /
  // surrounded weapon: no aim needed, but slow and thin in any single direction.
  novaburst: {
    id: 'novaburst',
    kind: 'ranged',
    nameKey: 'weapon.novaburst.name',
    skinRef: 'gun_default',
    rarity: 'epic', // 紫

    cooldownSec: 0.8, // slow — the omnidirectional volley is the payoff
    bullets: 10, // a ring of ten
    spreadDeg: 0, // unused by radial (the ring is even, not jittered)
    pattern: 'radial',
    bulletSpeed: 9,
    damage: 1,
    ballistic: 'straight', // each pellet then flies straight outward
    // Energy per trigger pull (design/03/05, balance/energy.ts): radial x10: a bullet-hell ring from one pull, the most output any single press buys — 33/s
    energyCost: 26,
    lifespanSec: 1.2,
    bulletRadius: 0.14,
    muzzleGrid: 0.5,
    bulletZ: 0.5,
  },

  // Gyre (orbit ballistic): spins a blade around the wielder at a fixed radius — a
  // moving melee wall that guards you while you shoot. Each blade is consumed on the
  // first thing it touches (or when its lifespan ends), so it's contact damage on a
  // timer, not a permanent shield (per-target hit cooldowns are the design/03 k_* tier).
  gyre: {
    id: 'gyre',
    kind: 'ranged',
    nameKey: 'weapon.gyre.name',
    skinRef: 'gun_default',
    rarity: 'legend', // 橙

    cooldownSec: 0.5, // spawns a fresh blade this often — several can circle at once
    bullets: 1,
    spreadDeg: 0,
    bulletSpeed: 0, // orbit doesn't travel; position is driven from the owner
    damage: 2,
    ballistic: 'orbit',
    // Energy per trigger pull (design/03/05, balance/energy.ts): orbit leaves persistent orbs doing work after the pull — 40/s
    energyCost: 20,
    orbitRadiusGrid: 1.6, // circling distance — just outside the body
    orbitPeriodSec: 1.0, // one revolution per second
    lifespanSec: 2.0, // each blade circles for ~2 revolutions before dissipating
    bulletRadius: 0.22,
    muzzleGrid: 1.6, // spawn on the orbit circle (repositioned on the first step anyway)
    bulletZ: 0.5,
  },

  // Carom (k_ricochet, design/03/09 ENGINE_VERSION 28): a single pellet that bounces to
  // the nearest OTHER hostile actor instead of expiring on its first hit — reach around
  // corners/crowds rather than through them (the opposite trade-off from `piercing`'s
  // straight-line punch-through, so this weapon leaves piercing off).
  carom: {
    id: 'carom',
    kind: 'ranged',
    nameKey: 'weapon.carom.name',
    skinRef: 'gun_default',
    rarity: 'epic', // 紫

    cooldownSec: 0.45,
    bullets: 1,
    spreadDeg: 0,
    bulletSpeed: 11,
    damage: 2,
    ballistic: 'straight',
    // Energy per trigger pull (design/03/05, balance/energy.ts): ricochet x2: one pull, up to three bodies — 31/s
    energyCost: 14,
    ricochetCount: 2, // up to 2 bounces after the first hit (3 targets total, at most)
    lifespanSec: 2.5,
    bulletRadius: 0.15,
    muzzleGrid: 0.9375,
    bulletZ: 0.5,
  },

  // Leech (k_lifesteal, design/03/09 ENGINE_VERSION 28): a melee weapon that heals the
  // wielder on every connecting hit — the sustain pick for a build that wants to stand
  // and trade rather than kite (05's "finding a better weapon" power axis, not a buff).
  leech: {
    id: 'leech',
    kind: 'melee',
    nameKey: 'weapon.leech.name',
    skinRef: 'sword_default',
    rarity: 'epic', // 紫

    cooldownSec: 0.4,
    damage: 2,
    arcDeg: 140,
    rangeGrid: 1.3,
    swingSec: 0.14,
    knockback: 3,
    deflect: true,
    deflectSpeed: 14.4,
    lifestealPermille: 300, // heal 30% of the damage dealt, per target hit, min 1
  },
};
