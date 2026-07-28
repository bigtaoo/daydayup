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
  score: { kill: 5, material: 10, waveClear: 40, victory: 200 },

  colors: {
    ground: 0x161a24,
    gridLine: 0x1f2532,
    player: 0x4fd1c5,
    playerFront: 0xe6fffa,
    enemy: 0xf56565,
    pillar: 0x3b4252,
    pillarTop: 0x4c566a,
    wall: 0x2a3140, // AABB solid tiles (design/07/09 ROADMAP 1.2) — flat room walls
    wallEdge: 0x4c566a, // wall outline, matches the pillar top for a consistent read
    extractGlow: 0x68d391, // extraction checkpoint prompt tint (design/05)
    shadow: 0x000000,
    bulletEnemy: 0xf6ad55,
    bulletPlayer: 0x63b3ed,
    gun: 0xcbd5e0,
    sword: 0xe2e8f0,
    swordGlow: 0x90cdf4,
    shield: 0x76e4f7, // cyan — the shield pool + its shatter burst (design/07 two-pool)
    deflect: 0x63b3ed, // parry/deflect flash (a melee swing batting a bullet back)
    clash: 0xffd27f, // two opposing bullets meeting and cancelling — a mid-air spark
    muzzle: 0xffe08a,
    pickupHeal: 0x68d391,
    pickupMaterial: 0xf6e05e, // the run's carry-out currency (design/05/14)
    pickupWeapon: 0xf6ad55, // amber — a new gun to swap in
    pickupBuff: 0xd6bcfa, // violet — a run buff (design/14 in-run power)
    pickupCrate: 0xa0aec0, // slate — an unresolved arena crate (design/15), contents unknown until revealed
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

// Per-biome ground/wall palette (design/13 "per-biome background palettes" — the
// element hex table is locked, so these are DERIVED from it, not hand-picked hexes).
// Rule (design/13 "environment desaturated, hazards saturated"): the room itself stays
// close to the existing neutral dark palette, with only a SMALL mix of the biome's
// element hue — the raw saturated hex is reserved for bullets/status FX/loot, so a
// wall painted full ember-orange would fight bullets/auras for attention instead of
// making them pop. `BIOME_ID_TO_ELEMENT` maps a `DungeonConfig.biomeId` (today only
// 'ember' exists, content/world/rooms/ember.ts) to the stable element vocabulary
// ELEMENT_COLORS already uses, so a future biome only needs one new entry there, not a
// parallel colour table. No new art — this is what "per-biome palette" asks for.
function mixHex(base: number, tint: number, amount: number): number {
  const br = (base >> 16) & 0xff, bg = (base >> 8) & 0xff, bb = base & 0xff;
  const tr = (tint >> 16) & 0xff, tg = (tint >> 8) & 0xff, tb = tint & 0xff;
  const mix = (b: number, t: number) => Math.round(b + (t - b) * amount);
  return (mix(br, tr) << 16) | (mix(bg, tg) << 8) | mix(bb, tb);
}

type BiomeElement = 'fire' | 'ice' | 'lightning' | 'poison' | 'neutral';

// 'neutral' has no element hue to hint at — it's not in this table, so it stays
// EXACTLY today's existing palette (below), byte-identical, never run through
// mixHex (mixing toward the bright #E2E8F0 neutral hex would visibly LIGHTEN it —
// that hex is meant for FX/icons, not as a wall tint amount).
const BIOME_ELEMENT_HEX: Record<Exclude<BiomeElement, 'neutral'>, number> = {
  fire: CONFIG.colors.statusBurn,
  ice: CONFIG.colors.statusChill,
  lightning: CONFIG.colors.statusShock,
  poison: CONFIG.colors.statusPoison,
};

export interface BiomePalette {
  ground: number;
  gridLine: number;
  pillar: number;
  pillarTop: number;
  wall: number;
  wallEdge: number;
}

const NEUTRAL_PALETTE: BiomePalette = {
  ground: CONFIG.colors.ground,
  gridLine: CONFIG.colors.gridLine,
  pillar: CONFIG.colors.pillar,
  pillarTop: CONFIG.colors.pillarTop,
  wall: CONFIG.colors.wall,
  wallEdge: CONFIG.colors.wallEdge,
};

const BIOME_PALETTES: Record<BiomeElement, BiomePalette> = {
  neutral: NEUTRAL_PALETTE,
  ...(Object.fromEntries(
    (Object.entries(BIOME_ELEMENT_HEX) as Array<[Exclude<BiomeElement, 'neutral'>, number]>).map(([element, hex]) => [
      element,
      {
        ground: mixHex(NEUTRAL_PALETTE.ground, hex, 0.1),
        gridLine: mixHex(NEUTRAL_PALETTE.gridLine, hex, 0.14),
        pillar: mixHex(NEUTRAL_PALETTE.pillar, hex, 0.14),
        pillarTop: mixHex(NEUTRAL_PALETTE.pillarTop, hex, 0.18),
        wall: mixHex(NEUTRAL_PALETTE.wall, hex, 0.14),
        wallEdge: mixHex(NEUTRAL_PALETTE.wallEdge, hex, 0.22),
      },
    ]),
  ) as Record<Exclude<BiomeElement, 'neutral'>, BiomePalette>),
};

// `biomeId` = `GameState.dungeonConfig?.biomeId` (undefined outside dungeon mode, e.g.
// the flat EngineConfig.floors path or a PvP arena — both fall back to 'neutral',
// i.e. today's existing palette unchanged).
const BIOME_ID_TO_ELEMENT: Record<string, BiomeElement> = {
  ember: 'fire',
};

export function biomePalette(biomeId: string | undefined): BiomePalette {
  return BIOME_PALETTES[biomeId ? (BIOME_ID_TO_ELEMENT[biomeId] ?? 'neutral') : 'neutral'];
}

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
