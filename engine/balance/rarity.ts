/**
 * Intrinsic weapon rarity (design/03/09/14). Rarity is a FIXED property of a
 * weapon — not a per-instance roll, not an upgrade, and never levelled. This
 * replaces the old "rarity = number of affix rolls" model (affixes are cut, 14).
 *
 * A tier grants a *small* numeric edge (the `qualityMult`) plus — mainly — better
 * handling/usability (tighter spread, smoother fire rate, better arc). The edge is
 * deliberately never crushing (14): you reach for a high-rarity weapon because it
 * feels good, not because it deletes the screen, so PvE power stays off a hard
 * ladder. The base-quality numbers here are a first pass; design/09 lists their
 * final tuning (and the per-frame handling gradient) as content still "to design".
 *
 * Colour is the primary read (白→蓝→紫→橙→金, design/14). This layer owns only the
 * stable `colorKey`; the render layer maps that key to a concrete hue (colours are
 * a render concern — the sim never reads rarity), so the compare card / HUD can
 * show the tier without the engine carrying pixels.
 */

/** The five tiers, low→high (design/14 table: 普通/精良/史诗/传说/传奇). */
export type RarityTier = 'common' | 'fine' | 'epic' | 'legend' | 'legendary';

/** Ascending order — indexable for "higher than" comparisons and UI ramps. */
export const RARITY_ORDER: readonly RarityTier[] = [
  'common',
  'fine',
  'epic',
  'legend',
  'legendary',
];

/** The default a weapon carries when none is authored — baseline, no edge. */
export const DEFAULT_RARITY: RarityTier = 'common';

interface RarityTierDef {
  /**
   * Quality multiplier in PER-MILLE (1000 = ×1.0), matching the engine's per-mille
   * convention (cf. resist maps). Integer math keeps the applied result deterministic
   * — see `applyQuality`. A *small* edge (design/14 "never crushing"): +5% per step,
   * topping out at +20% for legendary.
   */
  qualityMult: number;
  /** Stable colour name the render layer maps to a hue (design/14 白蓝紫橙金). */
  colorKey: 'white' | 'blue' | 'purple' | 'orange' | 'gold';
}

export const RARITY_TIERS: Record<RarityTier, RarityTierDef> = {
  common: { qualityMult: 1000, colorKey: 'white' }, // 白 — baseline, 能用
  fine: { qualityMult: 1050, colorKey: 'blue' }, // 蓝 — 数值略升、手感更顺
  epic: { qualityMult: 1100, colorKey: 'purple' }, // 紫 — 明显好用
  legend: { qualityMult: 1150, colorKey: 'orange' }, // 橙 — 强且顺手
  legendary: { qualityMult: 1200, colorKey: 'gold' }, // 金 — 顶：最好但不碾压
};

/**
 * Apply a tier's quality multiplier to an authored integer stat, at CONVERT time
 * only (design/09 "convert once"). Per-mille integer math with a single round → the
 * result the deterministic core sees is committed identically for every client, so
 * this never introduces float divergence. Used by `toSimSpec` for weapon damage;
 * `common` (1000) is the identity, so a baseline weapon is byte-for-byte unchanged.
 */
export function applyQuality(baseStat: number, tier: RarityTier): number {
  return Math.round((baseStat * RARITY_TIERS[tier].qualityMult) / 1000);
}
