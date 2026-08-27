// New 2026-08-20 (the scene pass after walls/characters): how a dungeon door is DRAWN. Sibling
// of `wallRender.ts`/`pillarRender.ts` — free functions over one footprint, no scene state, no
// room model — and it deliberately borrows that file's block shell (`addCapLayers`,
// `drawBlockShading`, `addBlockEdge`, `drawWallShadow`) rather than growing its own stone look.
//
// **WHY THIS FILE EXISTS.** `door_locked_raw.png` / `door_open_raw.png` are FRONT ELEVATIONS,
// drawn to be seen standing up: a portrait stone frame around a hazard-striped slab, and the
// same frame as an empty arch with a transparent middle. Until this pass `RoomBuilder` laid them
// FLAT on `layers.ground`, stretched to the passage AABB — 221x320 of portrait art squeezed into
// a 64x128 rect, and for a north-south passage into a 128x64 LANDSCAPE one. That is exactly the
// mistake the 2026-08-18 wall pass fixed for walls (design/13: the biome swatches "were being
// laid flat on the wall's own footprint, so the tilted view's promised small front face existed
// on pillars and nowhere else") — still live for the one fixture the player most needs to read at
// a glance. Measured on a live frame of level 1: the locked door read as a red rug lying on the
// floor in a gap between two 104 px stone masses, and the open one as a mangled 128x64 hoop.
//
// **THE GEOMETRY, AND WHY IT NEEDS NO ORIENTATION BRANCH.** A door's `passageAabb` is the hole in
// a wall: its short axis is the wall's own thickness, its long axis the width of the gap. So the
// mass ABOVE a doorway lands, under `screen.y = gy - z`, in exactly the place a wall block's CAP
// lands — the footprint displaced one height north — and the opening itself lands where that
// block's FACE goes. A door is therefore a wall block whose face is an opening instead of stone,
// which is one construction for both orientations:
//
//   cap    = the wall over the lintel, tiled from the same world-aligned swatch as the runs on
//            either side, so a room's crown line runs unbroken THROUGH the doorway (design/01:
//            the crown is the longest unbroken horizontal line in a room and what the eye reads
//            a back wall by).
//   face   = lintel stone, then the recess (a dark tunnel, not a painted panel), then the leaf.
//
// **THE LEAF IS FIT BY WIDTH AND CROPPED, NEVER SQUASHED.** Both swatches are 221x320-ish
// portrait; an opening is 64 wide x 104 tall on a perimeter wall and 128 x 22 on a kerb (the
// boundary between two vertically stacked rooms, which cannot stand tall without hiding the
// player — `wallGeometry.WALL_H_KERB`). Scaling to fit both axes would squash the kerb case 8:1.
// Instead the art is scaled by WIDTH, bottom-anchored, and any overflow is cropped off the TOP
// via a source frame: a tall door shows the whole leaf under a band of lintel stone, a kerb door
// shows the leaf's own base — its frame feet and the bottom hazard stripe — at the same stone
// scale as everything else in the room. `doorLeafFrame` is the pure half of that rule, tested
// without a canvas.
import { Graphics, Rectangle, Sprite, Texture, type TextureSource } from 'pixi.js';
import { Entity } from './Entity';
import type { RectPx } from './wallGeometry';
import { addBlockEdge, addCapLayers, addWallFace, drawBlockShading, type WallSkin } from './wallRender';
import { blockCapTop, NO_JOINS, type WallJoins } from './wallRuns';
import { XRAY_DEEP_LABEL, XRAY_LABEL, type FadeLayer } from './occlusion';

/** Textures a door is drawn from: the wall's own two swatches (so the stone around the opening
 *  is the room's stone) plus the two leaf elevations. Any of them missing falls back to palette
 *  Graphics, the same contract as every other swatch in this layer. */
export interface DoorSkin extends WallSkin {
  leaf: Texture | undefined;
}

/**
 * The recess behind the leaf — what makes a doorway a hole rather than a panel.
 *
 * Bands from the top of the opening downward, so the passage is darkest where it is deepest. It
 * matters most for an OPEN door, whose art is a frame around a transparent middle: with no recess
 * you see the room's floor tiling straight through the arch and the wall stops reading as solid.
 *
 * It darkens the wall's own elevation swatch rather than replacing it (`addWallFace` runs first
 * over the whole face) — the first version filled the opening with flat near-black and, on a
 * 22 px kerb door where the leaf art crops to almost nothing, that was the entire fixture: a
 * black rectangle punched in the room. Stone in deep shade reads as a passage; a void reads as a
 * rendering bug. Hence also the ceiling on the top band's alpha.
 */
const RECESS_COLOR = 0x05070a;
const RECESS_BANDS = 8;
const RECESS_ALPHA_TOP = 0.72;
const RECESS_ALPHA_FLOOR = 0.34;

/** The sill: a hairline of lit stone along the opening's own floor line, the one cue that says
 *  the passage's floor is a step rather than a continuation of the room. Same white-coping trick
 *  `wallRender`'s silhouette uses on a cap's north edge. */
const SILL_ALPHA = 0.22;

/**
 * A locked door's hazard bloom, additive, in two pieces: a pool on the floor immediately south
 * of the threshold, and a wash over the leaf itself.
 *
 * design/13 "environment desaturated, hazards saturated" — a locked door is the one fixture that
 * is allowed to shout, because "you cannot leave yet" is information the player needs from across
 * the room, and on a kerb-height opening the silhouette is only 22 px tall so colour has to carry
 * the whole read. Additive rather than a tint for the reason `wallTone.CAP_BOOST_ALPHA` documents:
 * a wash toward red would flatten the leaf's own contrast, an additive term lifts it and leaves
 * the stone frame's amplitude intact.
 */
const GLOW_COLOR = 0xff3a1e;
/** Pool rings, widest first: `rx` as a multiple of the opening's width, all at `GLOW_RING_ALPHA`.
 *  Graduated for the same reason `wallRender.CAST_PASSES` is — one ellipse at one alpha shows its
 *  own hard edge and reads as a painted rug on the floor, which is what the first version looked
 *  like; five rings still showed three of their edges. Nine at a third of the alpha each ramps
 *  smoothly and lands in the same place: A/B'd against the same frame with the layer hidden, the
 *  pool moves a 200x90 px region by a MEAN of +4.0 luma (max +27, 41% of pixels moving more than
 *  3/255) — real, unlike the wall relief filter this project measured at 0.06% and deleted. */
const GLOW_POOL: readonly number[] = [1.35, 1.2, 1.05, 0.9, 0.76, 0.62, 0.5, 0.38, 0.28];
const GLOW_RING_ALPHA = 0.035;
const GLOW_POOL_SQUASH = 0.46; // the same foreshortening every round thing in this view shares
const GLOW_WASH_ALPHA = 0.1;

/** One built door: the standing fixture plus the in-place lock-state swap `RoomBuilder.updateDoors`
 *  needs (design/05 "exactly two visual states" — a flip must not cost a room rebuild). */
export interface DoorFixture {
  readonly view: Entity;
  /** The layers the occlusion x-ray fades when this fixture hides a character: its cap, and
   *  everything below the cap/face fold (leaf, recess, lintel, glow). Same split as a wall —
   *  see `occlusion.xrayLayers`. */
  readonly capLayers: readonly FadeLayer[];
  readonly deepLayers: readonly FadeLayer[];
  setLocked(locked: boolean, leaf: Texture | undefined): void;
}

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

/**
 * One dungeon door as a standing fixture, ready to add to the Y-sorted `entities` layer.
 *
 * Same coordinate contract as `wallRender.buildWallBlock`: the container is placed on the
 * passage's SOUTH edge so it Y-sorts as one object standing on that line, the opening occupies
 * local `-height..0`, and the cap the footprint's own depth above that. `height` is the height of
 * the wall this door is cut into (`wallRuns.doorFlankHeight`), which is what keeps a door in a
 * kerb from standing between the camera and the player it frames.
 */
export function buildDoorBlock(
  r: RectPx,
  height: number,
  skin: DoorSkin,
  locked: boolean,
  joins: WallJoins = NO_JOINS,
): DoorFixture {
  const seg = new Entity();
  const capTop = blockCapTop(r, height, joins);
  const capH = -height - capTop;

  const leafDrawH = leafHeight(r.w, height, skin.leaf);

  // 1. The wall's own elevation across the WHOLE face: the lintel above the leaf, and the
  //    passage's stone behind it once the recess has darkened it.
  //
  //    Deliberately WITHOUT `occlusion.deepFadeReach`, which a wall block passes so the deep pass
  //    cannot reach its base: that bound is derived from a focus standing NORTH of the footprint,
  //    and a door's passage floor is inside its own footprint. A character in the doorway stands
  //    on rows the derivation excludes, so the whole face has to stay in the fading group here —
  //    the same reason the recess, the leaf and the glow are all in it.
  addWallFace(seg, r, height, skin);

  // 2. Recess.
  const recess = new Graphics();
  drawRecess(recess, r.w, leafDrawH);
  seg.addChild(recess);

  // 3. Leaf.
  const leaf = new Sprite();
  leaf.position.set(0, -leafDrawH);
  applyLeaf(leaf, r.w, leafDrawH, skin.leaf, locked);
  seg.addChild(leaf);

  // 4. Hazard bloom (locked only) — additive, so it lifts the leaf rather than washing it out.
  const glow = new Graphics();
  drawGlow(glow, r.w, leafDrawH);
  glow.blendMode = 'add';
  glow.visible = locked;
  seg.addChild(glow);

  // Everything so far is the opening — the group that fades only when a cap fade cannot save a
  // character standing in the doorway (`occlusion.needsDeepFade`), which for a door is the common
  // case rather than the rare one: the passage floor is entirely inside the fixture's own art.
  const capFrom = seg.children.length;
  addCapLayers(seg, r, capTop, capH, skin);
  for (let i = 0; i < capFrom; i++) seg.children[i]!.label = XRAY_DEEP_LABEL;

  // The same stone shading a wall block gets — cap depth gradient, side bands, cap/face fold,
  // base contact crease. Reused rather than re-tuned: a door is a piece of the wall it stands in,
  // and every one of those numbers was measured against these same two swatches (`wallTone.ts`).
  const shading = drawBlockShading(r, height, joins);
  shading.label = XRAY_DEEP_LABEL;
  seg.addChild(shading);

  // The sill, over the shading (its base crease would otherwise bury it), and the silhouette.
  const sill = new Graphics();
  drawSill(sill, r.w);
  sill.label = XRAY_DEEP_LABEL;
  seg.addChild(sill);
  addBlockEdge(seg, r, height, capTop, joins);

  seg.place(r.x, r.y + r.h);

  const capLayers = seg.children.filter((c) => c.label === XRAY_LABEL);
  const deepLayers = seg.children.filter((c) => c.label === XRAY_DEEP_LABEL);

  return {
    view: seg,
    capLayers,
    deepLayers,
    setLocked(next: boolean, tex: Texture | undefined): void {
      applyLeaf(leaf, r.w, leafDrawH, tex, next);
      glow.visible = next;
    },
  };
}

/** How tall the leaf is drawn — the whole rule lives in `doorLeafFrame`; with no art at all the
 *  opening is the full height of the fixture (the recess alone then reads as the doorway). */
function leafHeight(openingW: number, height: number, leaf: Texture | undefined): number {
  if (!leaf) return height;
  return doorLeafFrame(openingW, height, leaf.width, leaf.height).drawH;
}

/** The leaf sprite: art cropped by `doorLeafFrame` (never squashed), or — with no swatch loaded —
 *  the same flat hazard-red / inert-grey rect `RoomBuilder` used to fall back to, now standing up
 *  instead of lying on the floor. */
function applyLeaf(
  sprite: Sprite,
  openingW: number,
  drawH: number,
  leaf: Texture | undefined,
  locked: boolean,
): void {
  if (leaf) {
    const { srcY, srcH } = doorLeafFrame(openingW, drawH, leaf.width, leaf.height);
    sprite.texture = cropTop(leaf, srcY, srcH);
    sprite.tint = 0xffffff;
  } else {
    sprite.texture = Texture.WHITE;
    sprite.tint = locked ? 0xe53e3e : 0x4c566a;
  }
  sprite.width = openingW;
  sprite.height = drawH;
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

/** The sill: one lit hairline along the opening's own floor line. Its own function so the assembly
 *  test can look for exactly this geometry among the fixture's children — the silhouette
 *  (`addBlockEdge`) also strokes along y = 0, so "is there a line at the threshold" cannot tell the
 *  two apart. Exported for tests. */
export function drawSill(g: Graphics, openingW: number): void {
  g.moveTo(0, 0).lineTo(openingW, 0).stroke({ color: 0xffffff, width: 1, alpha: SILL_ALPHA });
}

/** The tunnel behind the leaf: bands darkening upward over the opening. Exported for tests. */
export function drawRecess(g: Graphics, openingW: number, openingH: number): void {
  if (openingH <= 0) return;
  const bandH = openingH / RECESS_BANDS;
  for (let i = 0; i < RECESS_BANDS; i++) {
    // t: 1 at the top of the opening (deepest), → 0 at the floor.
    const t = 1 - (i + 0.5) / RECESS_BANDS;
    const alpha = RECESS_ALPHA_FLOOR + (RECESS_ALPHA_TOP - RECESS_ALPHA_FLOOR) * t;
    g.rect(0, -openingH + i * bandH, openingW, bandH).fill({ color: RECESS_COLOR, alpha });
  }
}

/** A locked door's bloom: a graduated pool on the floor around the threshold plus a wash over the
 *  leaf. Exported for tests. */
export function drawGlow(g: Graphics, openingW: number, openingH: number): void {
  for (const rx of GLOW_POOL) {
    g.ellipse(openingW / 2, 0, openingW * rx, openingW * rx * GLOW_POOL_SQUASH)
      .fill({ color: GLOW_COLOR, alpha: GLOW_RING_ALPHA });
  }
  g.rect(0, -openingH, openingW, openingH).fill({ color: GLOW_COLOR, alpha: GLOW_WASH_ALPHA });
}
