// New 2026-08-19 (volume pass): a static light pool per room, painted on the floor.
//
// WHY. Measured across a full-floor extract of the shipped level, the floor's luma is 39-53
// EVERYWHERE — every room, every corner, wall-adjacent or open. There is no room-scale lighting
// in the game at all, which has two consequences that no amount of per-object shading can fix:
// every room looks identically lit, so a floor of five rooms reads as one flat sheet with
// furniture on it; and a black cast shadow has nothing to be darker THAN, which is why a wall's
// shadow measured a 5% modulation on the near-black ember floor and simply could not be seen.
//
// design/01 parks a real lightmap layer (multiply-blended, between entities and fx) as a later
// milestone, and this is deliberately NOT that: no light sources, no dynamic contribution, no
// second render target. It is the cheap static half — a soft darkening toward each room's
// perimeter — which buys the two things the milestone was wanted for (a room has a centre and
// corners; a shadow has somewhere brighter to sit against) for a handful of stroked rects on the
// ground layer. The lightmap milestone stays open for the dynamic half.
import type { Graphics } from 'pixi.js';
import type { RectPx } from './wallGeometry';

/** How far the falloff reaches in from the room's edge, as a fraction of its SHORTER side, and
 *  the ceiling on that in world px so a large arena doesn't get an enormous gradient. */
const FALLOFF_FRACTION = 0.2;
const FALLOFF_MAX_PX = 110;
/** Bands, and the alpha the outermost one reaches. Non-overlapping strokes, so each band's alpha
 *  is exactly its ramp value — the same reason the cap gradient and the sphere shading are built
 *  this way. Kept moderate: a wall's base hug and its cast shadow both land in this same region,
 *  and three dark things stacked in one corner reads as a hole rather than as ambience. */
const BANDS = 12;
const EDGE_ALPHA = 0.26;
const LIGHT_COLOR = 0x000000;

/**
 * Paint one room's falloff into `g` (one shared Graphics for the whole floor, on
 * `layers.ground` above the floor tiling).
 *
 * Concentric stroked rects from the room's own bounds inward, fading to nothing by
 * `FALLOFF_*`. A rect rather than a radial pool because these rooms ARE rectangles and their
 * corners are where the enclosure should read; a circular pool in a square room lights the
 * corners least along the diagonal, which is the wrong axis.
 */
export function drawRoomLight(g: Graphics, room: RectPx): void {
  const reach = Math.min(FALLOFF_MAX_PX, Math.min(room.w, room.h) * FALLOFF_FRACTION);
  if (reach <= 0) return;
  const width = reach / BANDS;
  for (let i = 0; i < BANDS; i++) {
    // t: 1 at the room's edge, → 0 at the inner end of the falloff.
    const t = 1 - (i + 0.5) / BANDS;
    const inset = i * width + width / 2;
    g.rect(room.x + inset, room.y + inset, room.w - inset * 2, room.h - inset * 2)
      .stroke({ color: LIGHT_COLOR, width, alpha: t * t * EDGE_ALPHA });
  }
}
