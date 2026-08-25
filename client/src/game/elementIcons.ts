import type { Graphics } from 'pixi.js';
import type { DamageType } from '@dd/engine';
import { elementColor } from './theme';

/**
 * The ICON half of design/13's locked dual-channel element law.
 *
 * The doc's wording is a rule, not a suggestion: *"Every weapon / enemy / status also
 * carries a small matching element icon badge (flame / snowflake / bolt / skull / gem).
 * Colour sets the mood, the icon is the legibility backstop (small size, colour-blind,
 * dark background). This dual channel is **locked**."* Until now only the colour channel
 * existed — `ELEMENT_COLORS` drove bullet trails, status auras, enemy `tint` and the
 * mounted weapon's tint, and nothing anywhere drew the second channel. Every elemental
 * read in the game was therefore one hue away from being unreadable, which is precisely
 * the failure the second channel exists to catch.
 *
 * Vectors, not art, for the same reason `ui/hudIcons.ts` is (design/13's own HUD-art
 * rule): a badge is tinted per element from an already-locked palette and has to stay
 * crisp at any DPR, and five more PNGs would be five more files to keep on-model.
 *
 * **Every glyph is a SOLID MASS, never a stroke.** These are drawn at r = 4-8 px in the
 * world, and `art/props/prompts.md` records the class of bug this avoids: a shape that
 * measures as perfectly correct and is a single invisible pixel wide at the size it is
 * actually displayed. That constraint is why ice is a fat six-pointed star rather than a
 * literal six-armed snowflake — a real snowflake's arms are strokes.
 *
 * Each glyph is drawn inside the box (cx±r, cy±r) and MUST stay inside it; callers lay
 * out around that box without measuring, same contract as `drawHudIcon`.
 *
 * ## Two silhouette collisions inside this game's own vocabulary, and how they are resolved
 *
 * `design/13` locks a **skull** for poison and a **gem** for physical, and both already
 * meant something else here:
 *
 * - **skull** was `drawHudIcon('enemies')`, the enemies-remaining stat chip. Resolved in
 *   the chip's favour of the *doc*: the element badge keeps the locked skull, and the HUD
 *   chip moved to a single-eyed critter head — which is more on-fiction anyway (`13`:
 *   enemies are *"living crystal, single glowing eye"*; nothing in this world has a
 *   skull, which is exactly what makes a skull read as "toxic" rather than as "a mob").
 * - **gem** vs `drawHudIcon('banked')`'s material crystal, and vs `Pickup`'s material
 *   drop. Resolved by silhouette rather than by renaming: a material is a TALL four-point
 *   crystal shard, physical's gem is a WIDE brilliant cut with a flat table and a girdle.
 *   Different aspect, different top edge — the two do not converge at small size.
 *
 * The general lesson, already in the art notes for generated art and true for vectors
 * too: before adding a small shape, ask what else in this game is that shape.
 */

/** Punched-out detail (the skull's eye sockets, the gem's table). Matches the badge
 *  chip's own fill so a hole reads as a hole; `drawElementGlyph` takes it as a parameter
 *  because a glyph drawn straight onto the HUD panel and one drawn on a world badge sit
 *  on different backgrounds. */
export const ELEMENT_GLYPH_HOLE = 0x0b0e14;

/** The badge chip: a dark rounded plate the glyph sits on. Not decoration — `13` names
 *  "dark background" as one of the three conditions the icon channel has to survive, and
 *  a bare glyph over a lit stone floor or a tinted body fails exactly there. */
const BADGE_FILL = ELEMENT_GLYPH_HOLE;
const BADGE_FILL_ALPHA = 0.82;
const BADGE_RING_ALPHA = 0.9;
/** Chip radius as a multiple of the glyph radius — enough margin that the glyph never
 *  touches the ring, since a glyph merging into its own border is what turns two
 *  different badges into the same blob at 12 px. */
const BADGE_PAD = 1.5;

function starPoints(cx: number, cy: number, points: number, outer: number, inner: number, rot: number): number[] {
  const pts: number[] = [];
  for (let i = 0; i < points * 2; i++) {
    const rad = i % 2 === 0 ? outer : inner;
    const a = rot + (i * Math.PI) / points;
    pts.push(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad);
  }
  return pts;
}

/**
 * Draw one element glyph, unbacked. `holeColor` is what a punched detail is filled with —
 * pass the colour of whatever is immediately behind the glyph.
 *
 * `physical` is included deliberately. `ELEMENT_COLORS` omits it (a physical bullet takes
 * its faction colour, which is right for world FX), but the icon channel has no such
 * fallback: "no badge" and "physical" would be the same picture, so a physical weapon
 * would be indistinguishable from one whose badge simply failed to draw.
 */
export function drawElementGlyph(
  g: Graphics,
  element: DamageType,
  cx: number,
  cy: number,
  r: number,
  color: number,
  holeColor: number = ELEMENT_GLYPH_HOLE,
): void {
  switch (element) {
    case 'fire': {
      // Flame — a solid teardrop with the tip up and the mass low, plus a brighter inner
      // core. The core is the same "lit facet on a solid body" trick `drawHudIcon`'s
      // crystal uses, and it is what keeps the shape from reading as a plain leaf.
      g.poly([
        cx, cy - r,
        cx + r * 0.36, cy - r * 0.26,
        cx + r * 0.64, cy + r * 0.24,
        cx + r * 0.40, cy + r * 0.82,
        cx, cy + r,
        cx - r * 0.40, cy + r * 0.82,
        cx - r * 0.64, cy + r * 0.24,
        cx - r * 0.30, cy - r * 0.20,
        cx - r * 0.08, cy - r * 0.56,
      ]).fill({ color });
      g.poly([
        cx, cy - r * 0.30,
        cx + r * 0.30, cy + r * 0.26,
        cx, cy + r * 0.66,
        cx - r * 0.30, cy + r * 0.26,
      ]).fill({ color: 0xffffff, alpha: 0.45 });
      break;
    }
    case 'ice': {
      // Snowflake — a six-pointed star with FAT arms (inner 0.46) rather than six thin
      // spokes. At r = 5 px a real snowflake's arms are sub-pixel; a hexagram keeps the
      // sixfold-symmetry read, which is the part that says "frost", in solid mass.
      g.poly(starPoints(cx, cy, 6, r, r * 0.46, -Math.PI / 2)).fill({ color });
      break;
    }
    case 'lightning': {
      // Bolt — one solid zigzag. The only glyph here with no mirror symmetry, which is
      // most of why it stays distinct from the star beside it at any size.
      g.poly([
        cx + r * 0.22, cy - r,
        cx - r * 0.58, cy + r * 0.12,
        cx - r * 0.04, cy + r * 0.12,
        cx - r * 0.24, cy + r,
        cx + r * 0.58, cy - r * 0.18,
        cx + r * 0.04, cy - r * 0.18,
      ]).fill({ color });
      break;
    }
    case 'poison': {
      // Skull — cranium over a jaw, two punched sockets. See the collision note in this
      // file's header for why the skull is here and not on the enemies stat chip.
      g.circle(cx, cy - r * 0.22, r * 0.80).fill({ color });
      g.roundRect(cx - r * 0.46, cy + r * 0.26, r * 0.92, r * 0.60, 1).fill({ color });
      g.circle(cx - r * 0.32, cy - r * 0.24, r * 0.24).fill({ color: holeColor });
      g.circle(cx + r * 0.32, cy - r * 0.24, r * 0.24).fill({ color: holeColor });
      break;
    }
    case 'physical': {
      // Gem — a WIDE brilliant cut: flat table on top, girdle at its widest just below,
      // culet at the bottom. Deliberately not the tall four-point shard `drawHudIcon`'s
      // 'banked' crystal and `Pickup`'s material drop both use, which in this game means
      // "refined crystal you carry out", not "physical damage".
      g.poly([
        cx - r * 0.58, cy - r * 0.46,
        cx + r * 0.58, cy - r * 0.46,
        cx + r, cy - r * 0.04,
        cx, cy + r,
        cx - r, cy - r * 0.04,
      ]).fill({ color });
      g.poly([
        cx - r * 0.58, cy - r * 0.46,
        cx + r * 0.58, cy - r * 0.46,
        cx + r * 0.34, cy - r * 0.04,
        cx - r * 0.34, cy - r * 0.04,
      ]).fill({ color: 0xffffff, alpha: 0.4 });
      break;
    }
  }
}

/**
 * The standalone badge: dark chip, element-coloured ring, glyph. This is the form that
 * rides on a world object (an elemental mob, a mounted weapon's housing) where there is
 * no panel behind it and no text beside it naming the element.
 *
 * `r` is the GLYPH radius; the chip is `r * BADGE_PAD`, so a caller reserving space
 * should reserve that.
 */
export function drawElementBadge(g: Graphics, element: DamageType, cx: number, cy: number, r: number): void {
  const color = elementColor(element);
  const chip = r * BADGE_PAD;
  g.circle(cx, cy, chip).fill({ color: BADGE_FILL, alpha: BADGE_FILL_ALPHA });
  g.circle(cx, cy, chip - 0.5).stroke({ color, width: 1, alpha: BADGE_RING_ALPHA });
  drawElementGlyph(g, element, cx, cy, r, color, BADGE_FILL);
}

/** The chip radius `drawElementBadge` will draw for a given glyph radius — exposed so a
 *  caller can lay out around the badge (or size an occluder for it) without duplicating
 *  the padding constant. */
export function elementBadgeRadius(glyphRadius: number): number {
  return glyphRadius * BADGE_PAD;
}
