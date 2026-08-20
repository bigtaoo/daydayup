// Split out of wallRender.ts (2026-08-19, 500-line convention): a pillar as a stone cylinder,
// in the same tonal language a standing wall is drawn in. Sibling of `wallRender.ts` — neither
// imports the other; both take their shared silhouette/crease/coping numbers from `wallTone.ts`,
// which is what keeps the split acyclic.
import { Graphics } from 'pixi.js';
import { mixHex, type BiomePalette } from '../theme';
import {
  BASE_AO_BANDS,
  BASE_AO_FRACTION,
  BASE_AO_MAX,
  COPING_ALPHA,
  EDGE_ALPHA,
  EDGE_COLOR,
  EDGE_WIDTH,
} from './wallTone';

/** Cylinder proportions: how deep the top ellipse is relative to the shaft's width, how far
 *  it overhangs, how far the base extends past the ground point, and how round the shaft's
 *  bottom corners are (small — a cylinder's sides are straight; only the base curves). */
const PILLAR_CAP_RY_FRACTION = 0.22;
const PILLAR_CAP_OVERHANG_PX = 2;
const PILLAR_BASE_PX = 10;
const PILLAR_CORNER_FRACTION = 0.12;

/**
 * Stone tones for a pillar, charcoal-navy per `art/biome/prompts.md`. Explicit rather than
 * derived, for the reason `buildPillarBody` documents: the biome palette's own pillar hues are
 * pre-art fallbacks that no longer describe the shipped swatches, and the swatches themselves
 * are too coarse to sample at pillar scale. `PILLAR_BIOME_MIX` folds a little of the biome's
 * wall colour back in so ice/lightning/fire rooms still differ from each other.
 *
 * Retuned 2026-08-19 against the same measured frame that set `wallRender`'s tonal hierarchy.
 * The top surface came out at luma 105 while the brightest stone anywhere else in the room —
 * a wall cap — was 44, so once the walls read as stone the pillars read as a different, paler
 * material lit by a different light: they were the brightest thing in frame by a factor of two.
 * The top is now ~92 on screen, the value a wall cap lands on, and BOTH limbs came down with
 * it — a top surface has to stay the brightest plane on the object (the texture-mapped attempt
 * failed exactly there and read as an open-topped well), so the lit limb had to drop below it
 * rather than the top alone dropping onto the limb.
 */
const PILLAR_LIT = 0x4e555f; // west limb, catching the key light
const PILLAR_MID = 0x424954; // the shaft's own local colour
const PILLAR_DARK = 0x141720; // east limb, turned away
const PILLAR_TOP = 0x5b6472; // the top surface — the most exposed plane on the object
const PILLAR_BIOME_MIX = 0.16;
/** Bands across the shaft. Each is filled with an INTERPOLATED COLOUR rather than stacked as an
 *  alpha overlay: a 4x render of the first attempt (9 alpha bands) showed nine hard vertical
 *  seams, because overlapping translucent rects step in opacity, not in tone. Interpolating the
 *  fill instead makes the step invisible at this count while staying pure Graphics — no
 *  gradient-fill API (Pixi 8's needs a canvas, which this repo's tests do not have), no
 *  per-pillar filter. */
const PILLAR_RAMP_STEPS = 22;
/** Where across the shaft the terminator sits (0 = west limb, 1 = east limb). */
const PILLAR_TERMINATOR = 0.36;

/** Faint stone mottling on the shaft, as `[x fraction, y fraction, radius fraction, alpha]` —
 *  a fixed table rather than noise so a pillar is deterministic and testable. New 2026-08-19:
 *  the colour-interpolated ramp alone is a mathematically perfect gradient, which is precisely
 *  what makes it read as moulded plastic next to a wall carrying a real stone swatch. Dark
 *  alphas only; a light speck on a curved surface reads as a hole. */
const PILLAR_MOTTLE: ReadonlyArray<readonly [number, number, number, number]> = [
  [0.28, 0.22, 0.1, 0.1],
  [0.62, 0.36, 0.13, 0.08],
  [0.42, 0.55, 0.09, 0.11],
  [0.74, 0.68, 0.08, 0.07],
  [0.2, 0.74, 0.11, 0.09],
  [0.52, 0.86, 0.07, 0.08],
  [0.36, 0.12, 0.06, 0.07],
];

/** The top ellipse's radii, for a shaft `bodyW` px wide. Shared with `pillarArtExtent` so the
 *  occlusion x-ray measures the same overhang the cap is actually drawn at. */
function pillarCapRadii(bodyW: number): { capRx: number; capRy: number } {
  return {
    capRx: bodyW / 2 + PILLAR_CAP_OVERHANG_PX,
    capRy: Math.max(8, bodyW * PILLAR_CAP_RY_FRACTION),
  };
}

/**
 * How far a pillar's art reaches from its own ground point, in local px: `halfW` to either side
 * and `top` northward (negative). Like a wall block, a pillar is drawn UPWARD from a grounded
 * origin, so its art covers a full `height` of walkable floor north of the footprint plus the
 * cap ellipse's own depth — that band is what `RoomBuilder` hands the occlusion x-ray
 * (`occlusion.Occluder`).
 */
export function pillarArtExtent(bodyW: number, height: number): { halfW: number; top: number } {
  const { capRx, capRy } = pillarCapRadii(bodyW);
  return { halfW: capRx, top: -(height + capRy) };
}

/**
 * A pillar as a stone cylinder in the same tonal language as a standing wall — a lit top
 * ellipse, a shaft shaded across its curve, faint mottling, a base contact crease, and the same
 * dark silhouette. Local coords with the origin at the pillar's ground point, so `bodyW`/
 * `height` are what `RoomBuilder` already computes.
 *
 * Hand-toned rather than textured, after three attempts (2026-08-18):
 *
 *   1. **The original was pale mauve.** Pillars were flat `Graphics` filled from
 *      `palette.pillar`/`palette.pillarTop`, which mix the biome's ELEMENT hue into a slate
 *      base — on ember that lands on `0x564850`. Those are code-only FALLBACK hues chosen
 *      before any real biome art existed, and every shipped swatch is charcoal-navy stone. Once
 *      the walls read as real stone, four pale-mauve cylinders read as placeholder props
 *      someone forgot to replace: the worst thing left in the frame.
 *   2. **Texturing them from the wall swatches was worse.** A pillar's cap is a ~35 px ellipse
 *      and its shaft ~80 px, so a `TilingSprite` window that small lands on one arbitrary dark
 *      patch of a 256 px swatch — no legible stone pattern, just a dark blob, and with the
 *      brick elevation on the shaft the whole thing read as an open-topped well.
 *   3. **Hand-toned shading, drawn as a real cylinder, is what works** — and needs no mask, no
 *      texture and no filter. This is that.
 */
export function buildPillarBody(bodyW: number, height: number, palette: BiomePalette): Graphics {
  const g = new Graphics();
  const { capRx, capRy } = pillarCapRadii(bodyW);
  const corner = bodyW * PILLAR_CORNER_FRACTION;
  const bodyH = height + PILLAR_BASE_PX;
  const stone = (base: number) => mixHex(base, palette.wall, PILLAR_BIOME_MIX);
  const lit = stone(PILLAR_LIT);
  const mid = stone(PILLAR_MID);
  const dark = stone(PILLAR_DARK);

  // Shaft, band by band across the curve. The bands are drawn on top of one solid rounded body
  // so the bottom corners stay round without a clip: each band is inset vertically by nothing
  // but its own overlap, and the rounded fill underneath is what the silhouette follows.
  g.roundRect(-bodyW / 2, -height, bodyW, bodyH, corner).fill({ color: mid });
  for (let i = 0; i < PILLAR_RAMP_STEPS; i++) {
    const t = (i + 0.5) / PILLAR_RAMP_STEPS;
    const color = t <= PILLAR_TERMINATOR
      ? mixHex(lit, mid, t / PILLAR_TERMINATOR)
      : mixHex(mid, dark, (t - PILLAR_TERMINATOR) / (1 - PILLAR_TERMINATOR));
    const x = -bodyW / 2 + bodyW * (i / PILLAR_RAMP_STEPS);
    const w = bodyW / PILLAR_RAMP_STEPS + 0.5; // overlap so no seam shows between bands
    // Inset from the very top/bottom so the rounded corners of the fill above stay visible.
    g.rect(x, -height + corner * 0.5, w, bodyH - corner).fill({ color });
  }

  // Stone mottling, so the shaft is not a mathematically clean gradient.
  for (const [fx, fy, fr, alpha] of PILLAR_MOTTLE) {
    g.ellipse(-bodyW / 2 + bodyW * fx, -height + height * fy, bodyW * fr, bodyW * fr * 1.3)
      .fill({ color: 0x000000, alpha });
  }

  // Base contact crease — the same smooth ramp a wall face gets, same constants.
  const aoH = height * BASE_AO_FRACTION;
  const aoStep = aoH / BASE_AO_BANDS;
  for (let i = 0; i < BASE_AO_BANDS; i++) {
    const t = (i + 0.5) / BASE_AO_BANDS;
    g.roundRect(-bodyW / 2, -aoH + i * aoStep, bodyW, aoStep + PILLAR_BASE_PX * (i === BASE_AO_BANDS - 1 ? 1 : 0), corner)
      .fill({ color: 0x000000, alpha: t * BASE_AO_MAX });
  }

  // Silhouette, then the top surface over it (the cap's near half is in front of the shaft),
  // then its lit coping.
  g.roundRect(-bodyW / 2, -height, bodyW, bodyH, corner)
    .stroke({ color: EDGE_COLOR, width: EDGE_WIDTH, alpha: EDGE_ALPHA });
  g.ellipse(0, -height, capRx, capRy).fill({ color: stone(PILLAR_TOP) });
  g.ellipse(0, -height, capRx, capRy)
    .stroke({ color: EDGE_COLOR, width: EDGE_WIDTH, alpha: EDGE_ALPHA });
  g.ellipse(0, -height, capRx * 0.94, capRy * 0.9)
    .stroke({ color: 0xffffff, width: 1.5, alpha: COPING_ALPHA });
  return g;
}
