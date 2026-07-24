import { RARITY_TIERS, type WeaponSimSpec } from '@dd/engine';

// Global constants. Tuning values live here.
export const CONFIG = {
  playerSpeed: 3.2, // px / frame @60fps baseline
  playerRadius: 16,
  playerMaxHp: 6,

  bulletSpeed: 5.5,
  bulletRadius: 5,
  bulletLifetime: 180, // frames

  enemyFireInterval: 90, // frames
  enemyHp: 3,

  // ── Run structure (MVP loop) ──
  pickupRadius: 15, // collect distance padding beyond player radius
  healChance: 0.34, // fraction of kills that drop a health orb (else a coin)
  healAmount: 1,
  waveBreakFrames: 48, // pause between cleared wave and next spawn
  score: { kill: 5, coin: 10, waveClear: 40, victory: 200 },

  colors: {
    ground: 0x161a24,
    gridLine: 0x1f2532,
    player: 0x4fd1c5,
    playerFront: 0xe6fffa,
    enemy: 0xf56565,
    pillar: 0x3b4252,
    pillarTop: 0x4c566a,
    shadow: 0x000000,
    bulletEnemy: 0xf6ad55,
    bulletPlayer: 0x63b3ed,
    gun: 0xcbd5e0,
    sword: 0xe2e8f0,
    swordGlow: 0x90cdf4,
    deflect: 0x63b3ed, // parry/deflect flash (a melee swing batting a bullet back)
    clash: 0xffd27f, // two opposing bullets meeting and cancelling — a mid-air spark
    muzzle: 0xffe08a,
    pickupHealth: 0x68d391,
    pickupCoin: 0xf6e05e,
    pickupWeapon: 0xf6ad55, // amber — a new gun to swap in
    // Elemental status fx (design/03/07) — flashed on the 'status' event, and now
    // also the bullet-trail + lingering-aura colours (per-element render polish).
    statusBurn: 0xff7043, // fire — orange flame
    statusChill: 0x81d4fa, // ice — pale blue frost
    statusShock: 0xfff176, // lightning — bright yellow arc
    statusPoison: 0x9ccc65, // poison — sickly green
  },
} as const;

// Element → fx colour. `physical` is intentionally absent (falls back to the
// faction colour); the four elements reuse their status-fx hues so a fire bullet,
// its trail, and the burn aura it leaves all read as the same orange (design/03/07).
export const ELEMENT_COLORS: Partial<Record<import('@dd/engine').DamageType, number>> = {
  fire: CONFIG.colors.statusBurn,
  ice: CONFIG.colors.statusChill,
  lightning: CONFIG.colors.statusShock,
  poison: CONFIG.colors.statusPoison,
};

// Rarity → border/ornament colour (design/14 白蓝紫橙金). The engine owns only the
// stable `colorKey` (RARITY_TIERS[tier].colorKey); the render layer maps it to a hue
// here. Kept a channel apart from ELEMENT_COLORS: rarity lives on the border/sprite
// ornament, element hues stay reserved for combat FX, so the two never fight (14).
export const RARITY_COLORS: Record<
  (typeof RARITY_TIERS)[keyof typeof RARITY_TIERS]['colorKey'],
  number
> = {
  white: 0xe2e8f0, // 普通 common
  blue: 0x63b3ed, // 精良 fine
  purple: 0xb794f4, // 史诗 epic
  orange: 0xf6ad55, // 传说 legend
  gold: 0xf6e05e, // 传奇 legendary
};

/** Border/ornament hue for a weapon's intrinsic tier (design/14 compare-card read). */
export function rarityColor(spec: WeaponSimSpec): number {
  return RARITY_COLORS[RARITY_TIERS[spec.rarity].colorKey];
}
