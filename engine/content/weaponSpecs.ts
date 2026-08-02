/**
 * The demo weapon catalog (design/09), split out of weapons.ts 2026-07-28 — this file
 * is purely data; conversion into the sim-facing shape (`toSimSpec`) lives in weapons.ts.
 *
 * Economy this is balanced against (first pass, matches the demo):
 *   player HP 6 · basic enemy HP 3 · player move 6 grid/s (demo 3.2px/frame).
 * Design intent (03/05): the GUN is safe ranged chip damage; the SABER trades
 * reach for higher burst + AoE arc + the deflect mechanic. Picking the gun means
 * giving up parry — a genuine trade-off, not a strictly-worse choice.
 */
import type { WeaponSpec } from './weaponTypes';

export const WEAPON_SPECS: Record<string, WeaponSpec> = {
  // ── Blaster (starter pistol) ────────────────────────────────────────────────
  // Demo: fireRate 12f, bulletSpeed 5.5px/f, lifetime 180f, damage 1, muzzle 30px.
  //   cooldownSec 0.20  → 6 ticks   (5 shots/s)        bulletSpeed 10 → 330 fp/tick
  //   lifespanSec 3.0   → 90 ticks                     damage 1 → 3 shots to drop a 3-HP enemy
  //   muzzleGrid 0.9375 (30px)   bulletRadius 0.15 (5px)   spreadDeg 0 → pinpoint (03)
  blaster: {
    id: 'blaster',
    kind: 'ranged',
    nameKey: 'weapon.blaster.name',
    skinRef: 'gun_default',
    rarity: 'common', // 白 — the baseline starter pistol

    cooldownSec: 0.2, // = fire rate; 5 shots/s
    bullets: 1,
    spreadDeg: 0,
    bulletSpeed: 10, // grid/s  (demo 5.5px/f·60/32 = 10.3, rounded)
    damage: 1, // chip damage — the gun's identity vs the saber's burst (03/05)
    ballistic: 'straight',
    lifespanSec: 3.0,
    bulletRadius: 0.15, // grid (demo 5px/32 = 0.156)
    muzzleGrid: 0.9375, // grid (demo 30px/32)
    bulletZ: 0.5, // fired at chest height → clears ground-hug hazards, blocked by tall cover (07)
  },

  // ── Saber (starter melee) ─────────────────────────────────────────────────────
  // Demo: swingRate 22f, damage 2, arc 0.9π, range 46px.
  //   cooldownSec 0.37 → 11 ticks      damage 2 → 2 swings to drop a 3-HP enemy (hits ALL in arc)
  //   arcDeg 162 → half 81° = 14746 brad   rangeGrid 1.44 (46px)
  //   deflect true → the whole point; a swing parries any enemy bullet in the SAME arc.
  //   deflectSpeed 14.4 grid/s (demo 5.5px/f·1.4)
  saber: {
    id: 'saber',
    kind: 'melee',
    nameKey: 'weapon.saber.name',
    skinRef: 'sword_default',
    rarity: 'common', // 白 — the baseline starter melee

    cooldownSec: 0.37, // recovery between swings
    damage: 2,
    arcDeg: 162, // 0.9π (demo) — the swing sector; enemies hit + bullets deflected inside it
    rangeGrid: 1.44, // demo 46px
    swingSec: 0.13, // active hit window ⊂ cooldown
    knockback: 6, // grid/s impulse (applied by HitResolve once z/knockback lands, 07)
    deflect: true, // ranged loadouts have no parry (03/05)
    deflectSpeed: 14.4, // grid/s of a redirected bullet (demo 5.5px/f · 1.4 · 60/32)
  },

  // ── Repeater (drop-only: fast, weak) ─────────────────────────────────────────
  // The "spray" gun — a weapon drop that trades punch for uptime, a wall of chip damage.
  repeater: {
    id: 'repeater',
    kind: 'ranged',
    nameKey: 'weapon.repeater.name',
    skinRef: 'gun_default',
    rarity: 'fine', // 蓝 — a slightly nicer floor drop

    cooldownSec: 0.1, // 3 ticks — 10 shots/s
    bullets: 1,
    spreadDeg: 0,
    bulletSpeed: 12, // grid/s
    damage: 1,
    ballistic: 'straight',
    lifespanSec: 2.0,
    bulletRadius: 0.12,
    muzzleGrid: 0.9375,
    bulletZ: 0.5,
  },

  // ── Cannon (drop-only: slow, heavy) ──────────────────────────────────────────
  // The opposite pole — big single hits that two-shot a basic enemy raw. Slow
  // enough that positioning matters.
  cannon: {
    id: 'cannon',
    kind: 'ranged',
    nameKey: 'weapon.cannon.name',
    skinRef: 'gun_default',
    rarity: 'epic', // 紫 — a standout heavy-hitter drop

    cooldownSec: 0.6, // 18 ticks
    bullets: 1,
    spreadDeg: 0,
    bulletSpeed: 8, // grid/s
    damage: 3,
    ballistic: 'straight',
    lifespanSec: 3.0,
    bulletRadius: 0.28,
    muzzleGrid: 1.0,
    bulletZ: 0.5,
  },

  // ── Enemy gun (basic mob loadout — not player-selectable) ───────────────────
  // Demo Game.ts enemy: fireInterval 90f, bullet dmg 1, muzzle 20px, same ballistic.
  //   cooldownSec 1.5 → 45 ticks    muzzleGrid 0.625 (20px)
  enemygun: {
    id: 'enemygun',
    kind: 'ranged',
    nameKey: 'weapon.enemygun.name',
    skinRef: 'gun_default',
    rarity: 'common', // 白 — mob loadout, never player-facing

    cooldownSec: 1.5, // 90 frames @60fps
    bullets: 1,
    spreadDeg: 0,
    bulletSpeed: 10, // grid/s
    damage: 1,
    ballistic: 'straight',
    lifespanSec: 3.0,
    bulletRadius: 0.15,
    muzzleGrid: 0.625, // grid (demo 20px/32)
    bulletZ: 0.5,
  },

  // ── Elemental weapons (design/03 "distinct behavior" — each layers an on-hit
  //    status the combat systems interpret; see content/damage.ts). ─────────────

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

  // ── Frame library (design/03 landing order, ROADMAP 1.1) — one showcase weapon
  //    per new frame beyond straight/saber. Each is physical so the frame's own
  //    behavior reads clearly, independent of the element layer above. ──────────

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

  // ── Frame-library elemental variants (design/03's "N frames × 5 elements" combo
  //    was only ever realized on `straight` — Phase 1.1's 7 newer frames shipped
  //    physical-only. First two elemental siblings, same shape as their physical
  //    counterpart with the frame's own numbers, an element layered on, and the same
  //    "one tier up" rarity step the original flamer/cryobolt/etc. set (03/05). ──────

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
    turnRateDegPerSec: 220, // slightly less brisk than seeker — the chill is the payoff
    lifespanSec: 2.8,
    bulletRadius: 0.16,
    muzzleGrid: 0.9375,
    bulletZ: 0.5,
  },
};
