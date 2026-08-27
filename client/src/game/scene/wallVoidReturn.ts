// New 2026-08-27, the drawing half of `wallVoidEdge.ts`: the stone a block shows on an
// east/west side that ends at nothing. Free functions over an Entity, same contract as
// `wallRender.ts`'s own — no scene state, no room model. Its own file rather than more of
// `wallRender.ts` because it is one self-contained cue with its own geometry mapping
// (CLAUDE.md form ①), and because it must run AFTER `addBlockEdge`: the return sits OUTSIDE
// the footprint, so it is the block's outermost surface, and its arris highlight belongs on
// top of the dark silhouette rather than under it.
//
// **Read `wallVoidEdge.ts` first for why this exists at all.** In one line: a void to the
// south is seen across a wall's FACE and a void to the east or west is seen across nothing,
// because this projection gives an east/west side zero width. This file invents that side.
//
// It is deliberately the CAP's swatch and not the face's. The face swatch is an elevation —
// its rows are a lit coping and a dark base, a vertical order that means nothing on a
// surface you see edge-on — while the cap swatch is the same stone the fold's other side is
// already showing, tiled in the same world space, so the mortar runs straight on over the
// arris. That continuity is most of what makes it read as a solid turning a corner rather
// than as a stripe painted beside it.
import { Graphics, TilingSprite, type Texture } from 'pixi.js';
import { powerRamp, rampFill } from '../../render/shadeRamp';
import { bakeLitCap } from './capLight';
import type { Entity } from './Entity';
import type { BiomePalette } from '../theme';
import type { RectPx } from './wallGeometry';
import { XRAY_LABEL } from './occlusion';
import type { VoidEdges, VoidSpan } from './wallVoidEdge';
import {
  LIT_EDGE_COLOR,
  VOID_CROWN_ALPHA,
  VOID_FALLOFF_POWER,
  VOID_RETURN_PX,
  VOID_RETURN_TINT_EAST,
  VOID_RETURN_TINT_WEST,
} from './wallTone';

/** Slack (world px) for "this span reaches the footprint's south edge". Same reasoning as
 *  `wallRuns`' own join tolerance: grid content through fixed point. */
const EDGE_TOLERANCE = 0.75;

/** What the return needs from the block's skin — structurally `wallRender.WallSkin`, spelled
 *  out here so this file does not import the module that imports it (CLAUDE.md's cycle rule). */
export interface ReturnSkin {
  palette: BiomePalette;
  cap: Texture | undefined;
}

/**
 * Add every void-facing return this block has, in the block's own local space.
 *
 * `capTop` is the block's already-clipped cap top (`wallRuns.blockCapTop`), so a tucked or
 * door-clipped run's return stops exactly where its cap does instead of hanging in the air
 * above it.
 */
export function addVoidReturns(
  seg: Entity,
  r: RectPx,
  height: number,
  capTop: number,
  voids: VoidEdges,
  skin: ReturnSkin,
): void {
  const from = seg.children.length;
  const g = new Graphics();
  for (const [side, spans] of [['east', voids.east], ['west', voids.west]] as const) {
    for (const span of spans) {
      const art = artSpan(span, r, height, capTop);
      if (!art) continue;
      const reach = reachInto(span);
      addReturnFace(seg, r, side, art, reach, skin);
      drawReturnFalloff(g, r, side, art, reach);
      if (side === 'east') creaseArris(g, r, art);
    }
  }
  if (g.context.instructions.length > 0) seg.addChild(g);
  else g.destroy();
  // Tagged with the CAP rather than with the silhouette: a block the occlusion x-ray is
  // fading has to fade whole. The silhouette (`addBlockEdge`) survives a fade on purpose —
  // it is a one-pixel outline and it is what keeps a ghosted block legible — but the return
  // is a filled surface, and one left solid beside a dissolved cap reads as a second object.
  for (let i = from; i < seg.children.length; i++) seg.children[i]!.label = XRAY_LABEL;
}

/**
 * A footprint-local y span mapped onto the block's own local y, or null if none of it is
 * drawn.
 *
 * The cap shows the footprint lifted by one wall height, so footprint y `t` is at local
 * `-height - (r.h - t)` — and a clip (`blockCapTop`) simply removes the northern end of that,
 * hence the clamp to `capTop`. A span that reaches the footprint's SOUTH edge continues down
 * the FACE, which is the same silhouette seen from the same side, so its span runs on to
 * local 0; one that stops short of the south edge ends at the fold.
 */
function artSpan(
  { from, to }: VoidSpan,
  r: RectPx,
  height: number,
  capTop: number,
): readonly [number, number] | null {
  const top = Math.max(capTop, -height - (r.h - from));
  const bottom = to >= r.h - EDGE_TOLERANCE ? 0 : -height - (r.h - to);
  return bottom - top > 0 ? [top, bottom] : null;
}

/**
 * How far this return may actually reach out, in world px: `VOID_RETURN_PX`, or half the void
 * if the void is narrower than twice that.
 *
 * HALF, because the wall on the far side of the same gap is drawing its own return inward and
 * the two must at most meet. Inert on everything shipped — the narrowest void on any shipped
 * map is `ember_l1` floor 2's 32 px, which is exactly the width two full returns need
 * (`wallComposition.test.ts` pins it, and pins that the clamp is not firing) — so this is
 * insurance against the next authored room rather than a correction to this one. Insurance
 * worth having: with no clamp the failure is silent, an overlap the author never sees because
 * it is 16 px of stone inside a crevice.
 */
function reachInto(span: VoidSpan): number {
  return Number.isFinite(span.gap) ? Math.min(VOID_RETURN_PX, span.gap / 2) : VOID_RETURN_PX;
}

/** The return's own surface: the cap's swatch carried past the footprint in the SAME world
 *  tiling, tinted for a vertical face. Falls back to the palette's flat wall tone when the
 *  swatch is missing, exactly as every other swatch here does. */
function addReturnFace(
  seg: Entity,
  r: RectPx,
  side: 'east' | 'west',
  [top, bottom]: readonly [number, number],
  reach: number,
  skin: ReturnSkin,
): void {
  const x = side === 'east' ? r.w : -reach;
  const tint = side === 'east' ? VOID_RETURN_TINT_EAST : VOID_RETURN_TINT_WEST;
  const cap = skin.cap ? bakeLitCap(skin.cap) ?? skin.cap : undefined;
  if (!cap) {
    const flat = new Graphics();
    flat.rect(x, top, reach, bottom - top).fill({ color: skin.palette.wall, alpha: 0.85 });
    seg.addChild(flat);
    return;
  }
  const tile = new TilingSprite({ texture: cap, width: reach, height: bottom - top });
  tile.position.set(x, top);
  // Same anchoring as `wallRender.capTile`: the tile origin is pinned to WORLD (0,0) so the
  // stone is continuous with the cap on the other side of the arris. The entity sits at
  // `r.y + r.h`, so this sprite's local (x, top) is world `(r.x + x, top + r.y + r.h)`.
  tile.tilePosition.set(-(r.x + x), -(top + r.y + r.h));
  tile.tint = tint;
  seg.addChild(tile);
}

/** The return's fall into the backdrop: black, nothing at the arris, full at its outer edge.
 *  One quad sampling the shared ramp, like every other graduated cue here — but a SQUARED one,
 *  so the 16 px holds its value and then plunges instead of being half-gone by its midpoint.
 *  See `powerRamp` for the measurement that chose it. */
function drawReturnFalloff(
  g: Graphics,
  r: RectPx,
  side: 'east' | 'west',
  [top, bottom]: readonly [number, number],
  reach: number,
): void {
  const x = side === 'east' ? r.w : -reach;
  const inner = side === 'east' ? r.w : 0;
  const outer = side === 'east' ? r.w + reach : -reach;
  g.rect(x, top, reach, bottom - top)
    .fill(rampFill(powerRamp(VOID_FALLOFF_POWER), inner, top, outer, top, { color: 0x000000, alpha: 1 }));
}

/** The lit arris along the east fold — see `VOID_CROWN_ALPHA` for why only the east side gets
 *  one. Half a pixel OUTSIDE the footprint so `addBlockEdge`'s dark silhouette, which is
 *  centred on the edge itself, survives underneath it as the arris' own shadow side. */
function creaseArris(g: Graphics, r: RectPx, [top, bottom]: readonly [number, number]): void {
  g.moveTo(r.w + 0.5, top)
    .lineTo(r.w + 0.5, bottom)
    .stroke({ color: LIT_EDGE_COLOR, width: 1, alpha: VOID_CROWN_ALPHA });
}
