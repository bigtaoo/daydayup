// Split out of Actor.ts (2026-08-25, 500-line convention) — the same shape and for the same
// reason as `healthBar.ts`: a pure drawing function over a caller-owned `Graphics`, no state and
// no display object of its own, so `Actor` keeps owning WHEN to redraw and this file owns what
// the aura looks like. Form (1) from CLAUDE.md, the preferred one — there is no shared private
// state here to justify a class.
//
// The lingering status aura (design/03/07): a concentric glowing ring per active on-hit effect,
// so a burning / chilled / poisoned actor reads for as long as the DoT lasts rather than only in
// the one-frame flash on the hit. Lightning has no lingering status (its chain is instant), so it
// deliberately has no aura.
import type { Graphics } from 'pixi.js';
import type { DamageType, StatusState } from '@dd/engine';
import { THEME } from '../theme';
import { SHADOW_SQUASH } from './Entity';
import { drawElementGlyph } from '../elementIcons';

/** One aura per lingering effect. `bit` is both the cache key's bit and the ring order. */
const AURAS: ReadonlyArray<{
  bit: number;
  element: DamageType;
  color: number;
  active: (s: StatusState) => boolean;
}> = [
  { bit: 1, element: 'fire', color: THEME.colors.statusBurn, active: (s) => s.burnTicks > 0 },
  { bit: 2, element: 'ice', color: THEME.colors.statusChill, active: (s) => s.chillTicks > 0 },
  { bit: 4, element: 'poison', color: THEME.colors.statusPoison, active: (s) => s.poison.length > 0 },
];

/** The burn bit, exported because `Actor` hands the burn edge to `ActorFilters.setBurning`
 *  (the heat-haze shader) off the same mask and must not carry its own copy of the number. */
export const AURA_BIT_BURN = 1;

/** Ring radius, as a multiple of the body radius, for ring index `i`. */
const RING_BASE = 1.15;
const RING_STEP = 0.22;
const RING_WIDTH = 3;
const RING_ALPHA = 0.55;

/** Where an aura's element glyph sits on its ring, and how big. Upper-LEFT (`-3π/4`) for two
 *  reasons that both come from things already on screen: the health bar occupies the space
 *  straight above the body, and the key light in every shaded surface in this game comes from the
 *  upper left (`wallTone`/`pillarRender`), so the glyph sits on the ring's lit shoulder rather
 *  than in its shadowed one. Radius follows the ring so a boss's bigger aura carries a bigger
 *  glyph, floored so a small mob's is still a solid mark rather than a speck. */
const GLYPH_ANGLE = (-Math.PI * 3) / 4;
const GLYPH_R_RATIO = 0.3;
const GLYPH_R_MIN = 3;

/** The active-effect bitmask for a status — `Actor` caches this to skip redundant redraws. */
export function auraMaskOf(status: StatusState): number {
  let mask = 0;
  for (const a of AURAS) if (a.active(status)) mask |= a.bit;
  return mask;
}

/**
 * Repaint `g` as the aura for `mask` (from `auraMaskOf`), centred on its own origin. Clears
 * first, so this is the whole of the aura's appearance; a zero mask leaves it empty.
 */
export function drawStatusAura(g: Graphics, mask: number, radiusPx: number): void {
  g.clear();
  if (mask === 0) return;
  let ring = 0;
  for (const a of AURAS) {
    if (!(mask & a.bit)) continue;
    const rad = radiusPx * (RING_BASE + ring * RING_STEP);
    // An ellipse, not a circle (2026-08-18 depth pass): an aura wraps the body in a TILTED
    // view, so it foreshortens vertically exactly like the ground shadow does. A true circle is
    // the single loudest "this is a flat decal" cue a round overlay can give, which is what the
    // shield's own report was about.
    g.ellipse(0, 0, rad, rad * SHADOW_SQUASH).stroke({ color: a.color, width: RING_WIDTH, alpha: RING_ALPHA });
    // The ICON half of design/13's locked dual-channel law, for the STATUS channel: a burning,
    // chilled and poisoned actor were three rings differing only in HUE, which is the exact
    // single-channel read that doc says must never be the whole cue. The glyph rides ON its own
    // ring — so N stacked statuses stay individually attributable to N rings — and follows the
    // ring's vertical foreshortening, since the aura is an ellipse for the same tilted-view
    // reason the shadow is.
    drawElementGlyph(
      g,
      a.element,
      Math.cos(GLYPH_ANGLE) * rad,
      Math.sin(GLYPH_ANGLE) * rad * SHADOW_SQUASH,
      Math.max(GLYPH_R_MIN, rad * GLYPH_R_RATIO),
      a.color,
    );
    ring++;
  }
}
