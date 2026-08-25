import type { Graphics } from 'pixi.js';
import { RARITY_ORDER, RARITY_TIERS, type RarityTier } from '@dd/engine';
import { RARITY_COLORS } from './theme';

/**
 * design/13's last purely-art-direction blank, closed: *"weapon **rarity** (白→蓝→紫→橙→金,
 * `14`) must read via border + a per-rarity ornament/emissive overlay on the sprite, without
 * colliding with the element language. Concrete overlay spec is still open."*
 *
 * ## The collision the spec has to solve, with the numbers
 *
 * The doc's worry is not hypothetical — it is already true of the two shipped palettes. Four
 * of the five rarity hues sit on top of a reserved element hue:
 *
 * | rarity | hex | element | hex |
 * |---|---|---|---|
 * | `fine` blue | `#63B3ED` | ice | `#81D4FA` |
 * | `legend` orange | `#F6AD55` | fire | `#FF7043` |
 * | `legendary` gold | `#F6E05E` | lightning | `#FFF176` |
 * | `common` white | `#E2E8F0` | physical | `#E2E8F0` — *the same value* |
 *
 * So no re-picking of hues can fix this. As long as rarity's carrier is HUE, rarity and
 * element are competing for one channel, and `13` locks that channel to element ("this dual
 * channel is **locked**", governing bullet trails, auras, enemy tint and weapon crystal).
 *
 * ## The spec
 *
 * **Rarity's channel is COUNT. Element's is hue. Neither can express the other, so the two
 * can never be confused** — which is a stronger guarantee than any pair of palettes could
 * give, and it is why this is the shape worth locking rather than a nicer set of oranges.
 *
 * 1. **Count** — `pipCount(tier)` discrete marks, = the tier's index in `RARITY_ORDER`:
 *    common 0, fine 1, epic 2, legend 3, legendary 4. Countable at a glance in that range,
 *    and monotone, so "more marks = better" needs no legend.
 * 2. **Position** — on an arc across the TOP of the object, centred, symmetric. A fixed
 *    place, so the marks are found without being hunted for, and above the object so they
 *    never cover the silhouette they are describing.
 * 3. **Colour is reinforcement only** — the marks take `RARITY_COLORS[tier]`, never anything
 *    else does. The object itself keeps its element hue. A colour-blind player, or one
 *    looking at a 4-pip mark through a poison biome's green cast, still counts four.
 * 4. **Emissive ramps with tier** — the marks blend additively and their alpha climbs with
 *    the tier, so a legendary announces itself across a room and a fine one does not. This is
 *    the "emissive overlay" half of `13`'s sentence; it is a redundant third channel on
 *    purpose, layered on top of count rather than replacing it.
 * 5. **`common` draws NOTHING.** A baseline drop should not decorate itself — that is the
 *    whole meaning of the tier — and it keeps the overwhelmingly common case at zero added
 *    geometry, which matters on a floor carrying a dozen drops (see `src/perf/README.md` on
 *    unbatched `Graphics`).
 *
 * ## Where it is NOT drawn, and why
 *
 * Not on the actor's own MOUNTED weapon. The mount is ~15 world px, it sweeps a full circle
 * around the body every frame (design/13's universal tether mount) and it is frequently
 * behind the body — so marks there would be small, moving and intermittently hidden, i.e.
 * exactly the conditions a legibility backstop is supposed to survive rather than share. The
 * equipped weapon's tier already reads from the HUD `WeaponCard`'s rarity-bordered chip, 40 px
 * away and stationary. The overlay's job is the case with no card: a weapon lying on the floor.
 */

/** Marks for a tier — its index in `RARITY_ORDER`, so `common` is 0 and `legendary` is 4. */
export function pipCount(tier: RarityTier): number {
  return RARITY_ORDER.indexOf(tier);
}

/** Arc the marks are spread over, centred on straight-up. Wide enough that four marks are
 *  visibly separate, narrow enough that the outermost pair still reads as "above" and not as
 *  "beside". */
const ARC_STEP_RAD = 0.46;
const ARC_CENTRE_RAD = -Math.PI / 2;
/** Mark radius as a fraction of the arc radius — a solid dot, per the same minimum-solid-mass
 *  rule `elementIcons.ts`'s header records: at the ~13 px arc a ground drop uses, anything
 *  thinner than this is a sub-pixel speck at real gameplay zoom. */
const PIP_R_RATIO = 0.155;
const PIP_R_MIN = 1.4;
/** Additive alpha at the bottom of the ladder (`fine`) and at the top (`legendary`). */
const PIP_ALPHA_MIN = 0.62;
const PIP_ALPHA_MAX = 1;

/**
 * Draw a tier's rarity marks on an arc of radius `r` around (cx, cy). Appends to `g` — the
 * caller owns clearing, same contract as `drawElementGlyph`.
 *
 * `g` should be an ADDITIVE Graphics for the emissive read to work (point 4 above); the
 * function does not set `blendMode` itself, because a Graphics' blend mode is a property of
 * the whole object and the caller may be batching other marks into it.
 */
export function drawRarityPips(g: Graphics, tier: RarityTier, cx: number, cy: number, r: number): void {
  const n = pipCount(tier);
  if (n <= 0) return; // common — see point 5
  const color = RARITY_COLORS[RARITY_TIERS[tier].colorKey];
  const pipR = Math.max(PIP_R_MIN, r * PIP_R_RATIO);
  // Alpha over the four drawn tiers (fine..legendary → 1..4), so `fine` sits at the floor and
  // `legendary` at the ceiling rather than the ramp starting from the tier that draws nothing.
  const maxN = RARITY_ORDER.length - 1;
  const alpha = PIP_ALPHA_MIN + ((PIP_ALPHA_MAX - PIP_ALPHA_MIN) * (n - 1)) / (maxN - 1);
  for (let i = 0; i < n; i++) {
    const a = ARC_CENTRE_RAD + (i - (n - 1) / 2) * ARC_STEP_RAD;
    g.circle(cx + Math.cos(a) * r, cy + Math.sin(a) * r, pipR).fill({ color, alpha });
  }
}
