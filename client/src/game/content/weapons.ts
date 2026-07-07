// Weapon content — first-version real numbers for the demo's two weapons.
//
// This is the seed of the `@dd/engine/content/weapons.ts` catalog described in
// design/09-content-data.md. Authored in HUMAN UNITS (seconds, grid-units/second,
// degrees, integer damage) exactly as 09 mandates; the engine converts to
// ticks / Fp / brad ONCE at construction (06/09). The demo today is still float +
// px/frame (client/src/game/weapons/*.ts); these values are what those weapons
// become after the 06 determinism migration. Numbers are DRAFT [tunable] — only
// ever edit constants here, never the mechanics (09 "numbers live in one place").
//
// ── World scale (the anchor for every conversion) ────────────────────────────
//   1 grid unit = 32 px.  Demo playerRadius 16px = 0.5 grid (diameter 1 grid),
//   matching funny's 0.5-cell footprint. Demo runs @60fps; the sim runs @30Hz
//   (06 TICK_RATE). So: grid/s = (px/frame · 60) / 32.
//   Conversions (shown per-field below so the arithmetic is auditable):
//     toTicks(sec)   = round(sec · 30)
//     toFp(grid)     = round(grid · 1000)
//     toFpS(grid/s)  = round(gridPerSec · 1000)          // fp per second
//     degToBrad(deg) = round(deg / 360 · 65536)          // 16-bit brad (06)

export const WORLD = {
  pxPerGrid: 32,
  tickRate: 30, // Hz (06)
  fpScale: 1000, // (06)
  bradFull: 65536, // 16-bit binary-radians (06)
} as const;

// ── Schema (subset of 09's WeaponSpec; grows with the ballistic library) ──────

export type BallisticId = 'straight'; // 03/07 shape library extends this later

interface WeaponBase {
  id: string;
  nameKey: string; // i18n KEY only — never display text (09)
  skinRef: string; // SkinDef id (02) — the view swaps by this, not by weapon logic
  /** Seconds before the weapon can be used again. For ranged this IS the fire rate. */
  cooldownSec: number;
}

export interface RangedSpec extends WeaponBase {
  kind: 'ranged';
  bullets: number; // pellets per shot
  spreadDeg: number; // total cone; per-pellet jitter drawn from combatPrng (07). 0 = pinpoint
  bulletSpeed: number; // grid/s
  damage: number; // integer; flat-armor subtract at hit (07)
  ballistic: BallisticId;
  lifespanSec: number; // bullet self-expires after this
  bulletRadius: number; // grid (07 swept-circle collision)
  bulletZ: number; // muzzle height band, grid (07 z-gating: shoot over low cover)
  piercing?: boolean;
}

export interface MeleeSpec extends WeaponBase {
  kind: 'melee';
  damage: number; // integer; per-target once per swing (07)
  arcDeg: number; // full swing sector; hit test uses half of this each side
  rangeGrid: number; // reach from actor centre, grid
  swingSec: number; // ACTIVE hit-window (subset of cooldownSec), 07 step 7
  knockback: number; // impulse grid/s applied to target vx/vy in swing dir (07)
  deflect: boolean; // can block/deflect bullets — the ranged-vs-melee trade-off gate (03/05)
  blockHalfDeg: number; // blockArc() half-angle (07 step 6)
  blockRangeGrid: number; // blockArc() radius, grid
}

export type WeaponSpec = RangedSpec | MeleeSpec;

// ── The two demo weapons ──────────────────────────────────────────────────────
//
// Economy this is balanced against (first pass, matches the demo):
//   player HP 6 · basic enemy HP 3 · player move 6 grid/s (demo 3.2px/frame).
// Design intent (03/05): the GUN is safe ranged chip damage; the SABER trades
// reach for higher burst + AoE arc + the deflect mechanic. Picking the gun means
// giving up parry — a genuine trade-off, not a strictly-worse choice.

export const WEAPON_SPECS: Record<string, WeaponSpec> = {
  // ── Blaster (starter pistol) ────────────────────────────────────────────────
  // Demo: fireRate 12f, bulletSpeed 5.5px/f, lifetime 180f, damage 1.
  //   cooldownSec 0.20  → round(0.20·30) = 6 ticks   (5 shots/s)
  //   bulletSpeed 10    → toFpS = 10000 fp/s → 330 fp/tick ≈ 9.9 grid/s (trunc)
  //   lifespanSec 3.0   → 90 ticks  (max travel ≈ 30 grid — whole-room; clamp later if too far)
  //   damage 1          → 3 shots (0.6 s) to drop a 3-HP enemy: DPS 5
  //   spreadDeg 0       → pinpoint (03 demo "emits a straight bullet")
  blaster: {
    id: 'blaster',
    kind: 'ranged',
    nameKey: 'weapon.blaster.name',
    skinRef: 'gun_default',
    cooldownSec: 0.2, // = fire rate; 5 shots/s
    bullets: 1,
    spreadDeg: 0,
    bulletSpeed: 10, // grid/s  (demo 5.5px/f·60/32 = 10.3, rounded)
    damage: 1,
    ballistic: 'straight',
    lifespanSec: 3.0,
    bulletRadius: 0.15, // grid (demo 5px/32 = 0.156)
    bulletZ: 0.5, // fired at chest height → clears ground-hug hazards, blocked by tall cover (07)
  },

  // ── Saber (starter melee) ─────────────────────────────────────────────────────
  // Demo: swingRate 22f, damage 2, arc 0.9π, range 46px, blockHalf 0.42π, blockRange 54px.
  //   cooldownSec 0.37  → round(0.37·30) = 11 ticks  (~2.7 swings/s)
  //   swingSec 0.13     → 4 ticks active hit-window (the recoil anim can run longer, render-only)
  //   damage 2          → 2 swings to drop a 3-HP enemy, but hits EVERY enemy in the arc
  //   arcDeg 162        → degToBrad = 29491; hit test uses half = 81° = 14746 brad each side
  //   rangeGrid 1.44    → toFp = 1440 fp  (demo 46px/32)
  //   knockback 6       → 6000 fp/s impulse, plays out via the movement integrator next tick (07)
  //   deflect true      → the whole point; blockHalfDeg 76 (13835 brad), blockRange 1.69 grid
  saber: {
    id: 'saber',
    kind: 'melee',
    nameKey: 'weapon.saber.name',
    skinRef: 'sword_default',
    cooldownSec: 0.37, // recovery between swings
    damage: 2,
    arcDeg: 162, // 0.9π (demo)
    rangeGrid: 1.44, // demo 46px
    swingSec: 0.13, // active hit window ⊂ cooldown
    knockback: 6, // grid/s impulse
    deflect: true, // ranged loadouts have no parry (03/05)
    blockHalfDeg: 76, // 0.42π (demo)
    blockRangeGrid: 1.69, // demo 54px
  },
};
