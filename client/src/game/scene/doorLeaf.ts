// Split out of doorRender.ts 2026-08-30 (500-line convention, CLAUDE.md form ① — independent
// function modules): everything about fitting the LEAF ART into an opening, no shared private
// state with the rest of that file. `doorRender.ts` re-exports `doorLeafFrame` so the original
// import path stays valid for callers/tests that already use it.
import { Rectangle, Sprite, Texture, type TextureSource } from 'pixi.js';

/**
 * The source rect of the leaf art and the size it is drawn at, for an opening `w × h`.
 *
 * Scale is fixed by WIDTH; the art keeps its aspect ratio and whatever does not fit vertically is
 * cropped off the TOP (a doorway's base is the half that carries the hazard stripe and the frame's
 * feet, and the top is the half a lintel would hide anyway). If the art is SHORTER than the
 * opening at that scale, it is bottom-anchored and the leftover band above it is lintel stone —
 * never stretched to reach the top.
 *
 * Pure: no Pixi, no textures, just the four numbers. `srcY`/`srcH` are in texture pixels,
 * `drawH` in world px.
 */
export function doorLeafFrame(
  openingW: number,
  openingH: number,
  artW: number,
  artH: number,
): { srcY: number; srcH: number; drawH: number } {
  if (artW <= 0 || artH <= 0) return { srcY: 0, srcH: 0, drawH: 0 };
  const scale = openingW / artW;
  const naturalH = artH * scale;
  if (naturalH <= openingH) return { srcY: 0, srcH: artH, drawH: naturalH };
  const srcH = openingH / scale;
  return { srcY: artH - srcH, srcH, drawH: openingH };
}

/** How tall the leaf is drawn — the whole rule lives in `doorLeafFrame`; with no art at all the
 *  opening is the full height of the fixture (the recess alone then reads as the doorway). */
export function leafHeight(openingW: number, height: number, leaf: Texture | undefined): number {
  if (!leaf) return height;
  return doorLeafFrame(openingW, height, leaf.width, leaf.height).drawH;
}

/**
 * Fit ANY art texture into an opening by width, cropping overflow off the TOP — the rule every
 * fixed-frame sprite standing in a doorway shares. Was inlined into `applyLeaf` alone until the
 * open state's curtain-of-light (2026-08-30) needed the exact same fit — same reasoning as the
 * leaf's own doc comment: on a kerb-height opening this crops to the art's own BOTTOM, which for
 * the curtain is its brightest, densest band, not an arbitrary slice.
 */
export function fitArtToOpening(sprite: Sprite, openingW: number, drawH: number, art: Texture): void {
  const { srcY, srcH } = doorLeafFrame(openingW, drawH, art.width, art.height);
  sprite.texture = cropTop(art, srcY, srcH);
  sprite.width = openingW;
  sprite.height = drawH;
}

/** The leaf sprite: art cropped by `doorLeafFrame` (never squashed), or — with no swatch loaded —
 *  the same flat hazard-red / inert-grey rect `RoomBuilder` used to fall back to, now standing up
 *  instead of lying on the floor. */
export function applyLeaf(
  sprite: Sprite,
  openingW: number,
  drawH: number,
  leaf: Texture | undefined,
  locked: boolean,
): void {
  if (leaf) {
    fitArtToOpening(sprite, openingW, drawH, leaf);
    sprite.tint = 0xffffff;
  } else {
    sprite.texture = Texture.WHITE;
    sprite.tint = locked ? 0xe53e3e : 0x4c566a;
    sprite.width = openingW;
    sprite.height = drawH;
  }
}

/** `leaf` with its top `srcY` rows dropped, sharing the same GPU source. A no-op (the texture
 *  itself) when nothing needs cropping, so the common tall-door case allocates nothing. */
function cropTop(leaf: Texture, srcY: number, srcH: number): Texture {
  if (srcY <= 0.5) return leaf;
  const f = leaf.frame;
  return new Texture({
    source: leaf.source as TextureSource,
    frame: new Rectangle(f.x, f.y + srcY, f.width, srcH),
  });
}
