/**
 * The two starter weapons (design/03/05), split out of weaponSpecs.ts (CLAUDE.md
 * "500-line file convention", form ① — WEAPON_SPECS is a content table with zero
 * shared state between entries, so it splits cleanly by the catalog's own existing
 * section groupings). Design intent: the GUN is safe ranged chip damage; the SABER
 * trades reach for higher burst + AoE arc + the deflect mechanic. Picking the gun
 * means giving up parry — a genuine trade-off, not a strictly-worse choice.
 *
 * Economy this is balanced against (first pass, matches the demo):
 *   player HP 6 · basic enemy HP 3 · player move 6 grid/s (demo 3.2px/frame).
 */
import type { WeaponSpec } from '../weaponTypes';

export const STARTER_WEAPON_SPECS: Record<string, WeaponSpec> = {
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
};
