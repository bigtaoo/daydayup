// New 2026-08-28: the void's FAR SIDE. `wallVoidEdge`/`wallVoidReturn` (2026-08-27) gave the void
// a near rim — the stone a wall shows where its east/west side ends at nothing. This is what that
// rim's ramp now falls onto instead of flat backdrop.
//
// **WHY GROUND AND NOT A PIT OR SKY.** All three were costed against this projection before one
// was built, and the projection settles it:
//
//  * A PIT is unbuildable here, for the same reason the original bug existed. What sells a pit is
//    the far bank's INNER wall descending from the rim — and across an east/west void that wall
//    faces east/west, which `screen.y = gy - z` gives exactly zero projected width. The one
//    surface that would carry the depth is the one this projection cannot draw. A pit FLOOR does
//    draw (it is horizontal), but z < 0 pushes it DOWN the screen, so a pit `d` px deep appears
//    `d` px SOUTH of its own footprint, over the room below it, while the Y-sort (`zIndex = gy`)
//    puts it BEHIND that room. Visible depth is therefore bounded by the empty screen space south
//    of the void, which for an interior empty cell with rooms on all sides is about zero: the
//    deeper it is authored, the less of it is seen.
//  * SKY works in the projection (a backdrop owes it nothing) but inverts the contrast the near
//    rim was just tuned against. `wallVoidReturn` draws the EAST arris LIT specifically because
//    the backdrop is luma ~6; against a bright field that arris stops separating and has to become
//    a dark silhouette, taking `VOID_RETURN_TINT_EAST`/`_WEST` and the squared falloff with it.
//    It also splits at the two scopes the rim deliberately unified — an interior cell reads as a
//    light well, but past the map's outer boundary there is no horizon to key on, and
//    `wallVoidEdge` reports `Infinity` for the gap there, so there is nothing to derive one from.
//  * GROUND is a horizontal plane at z = 0. It draws exactly the way floor draws, so there is no
//    zero-width surface anywhere in it; it keeps the backdrop dark, so the lit arris, both tints
//    and the squared ramp all stand unchanged; and it is ONE rule at both scopes — an interior
//    empty cell becomes a courtyard, past the boundary becomes the surrounding land, and an
//    `Infinity` gap needs no special case because the plane simply runs to the view's edge.
//
// **THE RISK IT HAS TO MANAGE IS READING AS FLOOR.** A walkable-looking void is worse than a black
// one. Three things keep it separate, and none of them is the texture alone: a different swatch
// (`terrainSwatch.ts` — generated noise, not masonry), a value well under the lit floor, and a fog
// layer that flattens its contrast the way distance does. The rim keeps doing the edge.
//
// **IT IS DELIBERATELY NOT UNDER THE SCENE LIGHT.** `layers.terrain` is a child of `world` but a
// SIBLING of `layers.lit`, so `SceneLightFilter` never touches it. That is the whole reason it is
// visible at all: the 2026-08-27 frame that closed the camera list found that a large part of what
// read as "the void" was the light pass darkening the rooms beyond, not the void itself. Putting
// this plane inside `lit` would hand it straight back to the pass that was crushing that area to
// black, i.e. rebuild the bug under a new name. Its distance cue is the fog constant below, which
// is a fixed haze rather than a per-pixel falloff — correct rather than lazy, since every part of
// the void is at the same "beyond the wall" remove, and aerial perspective at one distance IS
// uniform.
import { Container, Sprite, Texture, TilingSprite } from 'pixi.js';
import type { Layers } from './layers';
import type { BiomePalette } from '../theme';
import { TERRAIN_TILE_PX, terrainSwatch } from './terrainSwatch';

/** How much `palette.void` is laid over the plane. Lifts its blacks toward the backdrop colour and
 *  flattens its contrast — the part a tint alone cannot do, since a tint only multiplies and can
 *  never raise a value toward the haze. */
export const TERRAIN_FOG_ALPHA = 0.35;

/** A view rect in WORLD px — `FxController`'s `litArea`, i.e. the inverse camera transform applied
 *  to the viewport. */
export interface TerrainView {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The far-side ground plane: one tiling swatch and one fog sheet, both mounted on
 * `layers.terrain`.
 *
 * Two display objects and two draw calls, fixed — NOT per void region. Nothing here computes where
 * the void is, because nothing has to: the floor paints over this plane wherever there is floor and
 * the walls paint over it wherever there is stone, so what is left showing IS the void, exactly and
 * for free. That is why there is no counterpart to `wallVoidEdge`'s span arithmetic on this side.
 */
export class Terrain {
  private readonly plane: TilingSprite;
  private readonly fog: Sprite;

  constructor(layers: Layers) {
    this.plane = new TilingSprite({ texture: Texture.EMPTY, width: 1, height: 1 });
    // `Texture.WHITE` + tint + alpha rather than a `Graphics` rect: this is resized every frame
    // from `fitTerrain`, and a Graphics would rebuild its geometry each time. A Sprite resize is
    // two numbers.
    this.fog = new Sprite({ texture: Texture.WHITE, width: 1, height: 1 });
    this.fog.alpha = TERRAIN_FOG_ALPHA;
    layers.terrain.addChild(this.plane, this.fog);
  }

  /** Recolour for the biome — called from `RoomBuilder.build`, beside `Backdrop.setPalette`. */
  setPalette(palette: BiomePalette): void {
    this.plane.texture = terrainSwatch(palette.terrain);
    this.fog.tint = palette.void;
  }
}

/**
 * Fit the plane to this frame's visible world rect.
 *
 * A free function over the CONTAINER rather than a method on `Terrain`, matching
 * `groundCulling.cullGroundLayer`: `FxController` is constructed with nothing but `Layers`, and
 * this keeps it that way.
 *
 * Sized to the VIEW and not to the world box. The camera clamps to the world on both axes except
 * for a north overscan of `MAX_WALL_HEIGHT` (`FxController.updateCamera`'s `overscanTop`) and the
 * centring it falls back to when a world is smaller than the viewport — so a fixed margin around
 * the world box would be a guess at two different quantities, and a wrong guess shows as a hard
 * terrain edge with backdrop beyond it. The view rect is what is actually on screen, so it cannot
 * be wrong by construction.
 *
 * `tilePosition` is the negated view origin, which anchors the swatch to WORLD space: without it
 * the texture would be pinned to the sprite and swim under a panning camera.
 */
export function fitTerrain(container: Container, view: TerrainView): void {
  for (const child of container.children) {
    child.x = view.x;
    child.y = view.y;
    if (child instanceof TilingSprite) {
      child.width = view.w;
      child.height = view.h;
      child.tilePosition.set(-view.x, -view.y);
    } else if (child instanceof Sprite) {
      child.width = view.w;
      child.height = view.h;
    }
  }
}

/** The swatch's tile size, re-exported so a caller checking world anchoring does not have to
 *  import the bake module too. */
export { TERRAIN_TILE_PX };
