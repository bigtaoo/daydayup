/**
 * Unit height standard — target for `client/src/render/unitSize.ts` once
 * DayDayUp's real render pipeline replaces the current Graphics placeholders
 * (design/12: "nothing here is built yet"). Until that file exists, this is
 * the source of truth; when it lands, keep both in sync (whichever changes
 * first, mirror it into the other).
 *
 * Used by the export bake-down (IOController) to size textures to the absolute
 * target display resolution instead of the artist's arbitrary canvas size.
 * The artist picks the tier in the export panel.
 */

export type SizeTierKey = 'S' | 'M' | 'L' | 'XL';

/**
 * Target on-screen height (px) per tier: S 0.85× · M 1.00× · L 1.18× · XL 1.50×.
 * The export bake uses SCREEN px (not authoring px): the figure's baked texture
 * footprint becomes TARGET_SCREEN_PX × SUPERSAMPLE, matched to what the runtime
 * actually displays after it scales the rig to TARGET_SCREEN_PX.
 */
export const TARGET_SCREEN_PX: Record<SizeTierKey, number> = {
  S:  46,
  M:  54,
  L:  64,
  XL: 81,
};

/**
 * Texture supersample factor — keeps the figure crisp on high-DPR screens.
 */
export const SUPERSAMPLE = 2;

/** Tier labels for the export dropdown (XL is mythic-creature only). */
export const SIZE_TIER_LABELS: Record<SizeTierKey, string> = {
  S:  'S · Small (ranged/flying)',
  M:  'M · Normal (baseline)',
  L:  'L · Tall (shield/heavy)',
  XL: 'XL · Giant (mythic creatures only)',
};
