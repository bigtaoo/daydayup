// Split out of RoomBuilder (2026-08-18, 500-line convention + separation of concerns): how a
// standing wall is DRAWN. `wallGeometry.ts` decides how tall each segment is, `wallRuns.ts`
// which footprints are one mass; this file turns one footprint + height into the extruded
// block Entity and the shadow it throws on the floor. Free functions over a Graphics/Entity —
// no scene state, no room model. Pillars live in the sibling `pillarRender.ts`; both read their
// tones from `wallTone.ts`, so everything standing in a room agrees on where the light is.
//
// This is the pass that answers the user's report *"墙看起来还是没有高度感，就像一张图贴在地
// 上"*. Standing walls already existed; what was missing was every cue that says a solid
// object is sitting ON a floor rather than printed INTO it:
//
//   1. **No cast shadow at all.** The pillars had one (`Entity.makeShadow`); a 70 px wall had
//      none. design/01 calls a height-driven shadow "the cheapest 3D cheat" and the walls
//      were the one tall thing in the room not using it.
//   2. **Cap and face were the same brightness.** The cap reused `wall_<element>.png` — the
//      same top-down swatch a FLAT wall is drawn with — at tint 0xffffff, so a surface
//      raised 70 px and a surface lying on the ground were pixel-for-pixel equally lit.
//   3. **No side thickness.** A block's east/west sides project to exactly zero width under
//      `screen.y = gy - z` (there is no horizontal skew in this projection), so a
//      north-south run showed only a cap and a small end face. The east side is now drawn
//      as an INSET dark band — a deliberate cheat, inset rather than extruded so it can
//      never overlap the neighbouring segment of the same run.
//
// Fourth pass, 2026-08-19, on a screenshot of level 1's start room — *"那段墙体看起来很奇
// 怪"*, pointing at the west perimeter run. All three defects it found are the same defect: every
// number here had been tuned on an EAST-WEST wall, where the cap is a 32 px band under a lit
// coping, and then applied unchanged to a north-south run, where the cap is 100% of what you see
// of the wall (224 px deep on the wall in question). Measured/A-B'd on the live frame:
//
//   4. **A flat additive key light on the cap** hit its target luma and flattened the swatch's
//      contrast RATIO from 2:1 to 1.4:1, so the wall read as pale concrete rather than stone.
//      Now a second copy of the swatch in `add` mode — same value, ratio intact (`CAP_BOOST_*`).
//   5. **The cap tiled from each block's own origin**, so a 64 px-wide run always windowed the
//      same left quarter of a 256 px swatch (on ember: one large stone, no pattern), and an L
//      corner met at a mismatched seam. Now tiled in world space.
//   6. **The east band and west chamfer spanned the block's whole art**, which on a north-south
//      run is a 13 px flat grey panel painted down 224 px of the wall's top. Now bounded to one
//      wall thickness of cap plus a taper (`SIDE_CAP_SOLID_PX`), with a narrow bevel
//      (`CAP_EDGE_*`) along the rest.
//
// ...and the report after that one — *"竖着的墙，直接盖在了横着的墙上面"* — was the SAME wall's
// corner, and its cause is `mergeWallRuns` merging only pairs whose union is a rectangle: an L or
// T corner is always two blocks, and each drew its full "this is where I end" set right in the
// middle of one continuous stone top. `wallRuns.wallJoins` now tells a block which of its edges
// are buried in a corner, and `WallJoins` masks the coping, the silhouette, the cap gradient and
// the fold out of them. See that function for the measured 66 -> 79 step this removes.
//
// ...and the report after THAT one changed the rule instead of a number: *"中间的墙体处理的很好，
// 但是上面那段就不对了"*. A seamless corner was never the ask. A block's art intrudes one wall
// HEIGHT north of its own footprint, so a deep north-south run climbs the far wall's brick face
// and interrupts the one surface the eye is using as the room's back wall. Such a run now TUCKS
// (`WallJoins.tuckNorth`): its cap is clipped so it stops just under that wall's CROWN course, the
// longest unbroken horizontal line in the room stays unbroken, and the junction — now a re-entrant
// corner rather than an overlap — gets a crease on both surfaces (`TUCK_*`). A deliberate
// stylisation, not a correction: the run's stone really is nearer than the brick it hides.
//
// The clip line took one more round to place. Stopping the run at the wall's FOOT was tried first
// and rejected (*"应该要覆盖到我标记的区域"*, over the brick above the run): the run is entitled to
// stand in front of the brick, just not in front of the crown. See `wallRuns.WallJoins` for the
// measurement that placed it and why only DEEP runs may tuck at all.
import { Graphics, TilingSprite, type Texture } from 'pixi.js';
import { Entity } from './Entity';
import { SHADOW_SLANT_X, SHADOW_SLANT_Y } from './Entity';
import type { BiomePalette } from '../theme';
import type { RectPx } from './wallGeometry';
import { blockCapTop, NO_JOINS, unjoinedSpans, type WallJoins } from './wallRuns';
import { XRAY_DEEP_LABEL, XRAY_LABEL } from './occlusion';
import {
  drawBaseContactCrease,
  drawCapDepthGradient,
  drawCapEdgeBevel,
  drawCapFold,
  drawFaceCopingSuppress,
  drawSideBands,
} from './wallShadingSurfaces';
import { drawCornerAO, drawTuckCapCrease, drawTuckFaceCrease } from './wallShadingJoins';
import {
  CAP_BOOST_ALPHA,
  CAP_BOOST_TINT,
  CAP_LIGHT,
  CAP_LIGHT_BLEND,
  CAP_TINT,
  COPING_ALPHA,
  EDGE_ALPHA,
  EDGE_COLOR,
  EDGE_WIDTH,
  FACE_TINT,
} from './wallTone';


/**
 * Cast-shadow passes: `[slant multiplier, alpha]`, widest/faintest first. Four graduated
 * passes rather than two (2026-08-19): the two-pass version had visibly straight polygon
 * edges — its convex hulls are hard-edged quads and at two alphas you see both of them, which
 * reads as a flat grey shape laid on the floor rather than as a shadow. Both slant by the fixed
 * key-light direction every shadow in this project uses (`Entity`'s SHADOW_SLANT_*).
 *
 * Alphas per pass are lower than the old two, but they composite over the same region, so the
 * region nearest the wall still ends up around 0.45 — measured east of a run as floor luma
 * 40 -> 26, which is the one place the old version already worked.
 */
const CAST_PASSES: ReadonlyArray<readonly [number, number]> = [
  [1, 0.14],
  [0.72, 0.13],
  [0.45, 0.13],
  [0.22, 0.12],
];

/**
 * Ambient occlusion hugging the OUTSIDE of the footprint: `[outset px, alpha]`, drawn as
 * strokes so the bands never overlap. New 2026-08-19, and it replaces a contact pass that
 * could never be seen.
 *
 * The old contact shadow filled the footprint itself — but a block's art spans
 * `south - height - depth .. south`, which covers its whole footprint and then intrudes one
 * wall height north of it, so every pixel of that fill was behind the block that cast it. Only
 * the 3 px `CONTACT_GROW_PX` rim showed. Painting the crease OUTSIDE the footprint instead is
 * both visible and physically the right place for it: a tall mass darkens the floor all the way
 * around its base, not only down-light of it. On a north-south run — where the cast shadow lies
 * entirely to the east and the run's own face is a small patch at its south end — this is the
 * cue that plants the mass on the floor at all.
 */
const BASE_HUG: ReadonlyArray<readonly [number, number]> = [
  [1.5, 0.34],
  [4, 0.26],
  [7, 0.19],
  [10.5, 0.12],
  [14, 0.06],
];
const HUG_WIDTH = 3;
const SHADOW_COLOR = 0x000000;

/** Textures + colours one wall block is drawn from. `cap` is the top-down swatch
 *  (`wall_<element>.png`), `face` the front elevation (`wallface_<element>.png`); either
 *  missing falls back to palette Graphics, same contract as every other swatch here. */
export interface WallSkin {
  palette: BiomePalette;
  cap: Texture | undefined;
  face: Texture | undefined;
}

/**
 * One wall segment as an extruded block, ready to add to the Y-sorted `entities` layer.
 *
 * Geometry is forced by `screen.y = gy - z`: the container is placed on the wall's SOUTH
 * edge, so `Entity.place` gives it `zIndex = that edge` and it Y-sorts against actors as one
 * object standing on that line. In local coords the front face then occupies `-height..0`
 * and the top cap the footprint's own depth above that. The face texture is used at exactly
 * one height and tiled horizontally only — its top rows are a lit coping and its bottom rows
 * a dark base — so `tileScale` stays uniform and it is never stretched to fit.
 */
export function buildWallBlock(
  r: RectPx,
  height: number,
  skin: WallSkin,
  joins: WallJoins = NO_JOINS,
): Entity {
  const seg = new Entity();
  const capTop = blockCapTop(r, height, joins);
  const capH = -height - capTop;

  if (skin.face) {
    const face = new TilingSprite({ texture: skin.face, width: r.w, height });
    face.position.set(0, -height);
    face.tileScale.set(height / skin.face.height);
    face.tint = FACE_TINT;
    seg.addChild(face);
  } else {
    // Same lit-from-upper-left banding the pillars use, so a missing swatch still reads as a
    // standing surface rather than a flat rectangle.
    const g = new Graphics();
    g.rect(0, -height, r.w, height).fill({ color: skin.palette.wall });
    g.rect(0, -height, r.w, height * 0.22).fill({ color: 0xffffff, alpha: 0.08 });
    g.rect(0, -height * 0.3, r.w, height * 0.3).fill({ color: 0x000000, alpha: 0.22 });
    seg.addChild(g);
  }

  // Every layer added between here and `drawBlockShading` is a CAP layer, and the cap is what a
  // character standing behind this block normally disappears into — so each is tagged for the
  // occlusion x-ray to fade (`occlusion.xrayLayers`). The face and the shading over it are tagged
  // separately (`XRAY_DEEP_LABEL`, applied below): they only move in the rarer case where the
  // body sits entirely below the cap/face fold and a cap fade would achieve nothing. The
  // silhouette is in neither group and never fades.
  const capFrom = seg.children.length;
  if (skin.cap) {
    // `tilePosition` puts the swatch in WORLD space rather than at each block's own origin. Two
    // reasons, both visible on the level-1 start room: an L corner is two independent blocks, and
    // per-block origins made their stone meet at a hard mismatched seam; and a narrow north-south
    // run (64 px of a 256 px swatch) always windowed the swatch's SAME left quarter, which on
    // ember is one large stone — so every such wall came out as a featureless slab regardless of
    // how good the swatch is. World-aligned, wall tops read as one continuous quarry.
    seg.addChild(capTile(skin.cap, r, capTop, capH, CAP_TINT, 1, 'inherit'));
    // The cap's key light: the SAME swatch a second time, additive, so the lift is multiplicative
    // and the stone keeps its contrast RATIO — see `CAP_BOOST_ALPHA` for the measurement that
    // replaced the flat additive constant with this. Its own child rather than part of
    // `drawBlockShading`, because a blend mode is per display object.
    seg.addChild(capTile(skin.cap, r, capTop, capH, CAP_BOOST_TINT, CAP_BOOST_ALPHA, CAP_LIGHT_BLEND));
  } else {
    const g = new Graphics();
    g.rect(0, capTop, r.w, capH).fill({ color: skin.palette.pillarTop });
    seg.addChild(g);
    // A flat fill has no contrast to preserve, so the fallback keeps the flat additive.
    const capLight = new Graphics();
    capLight.rect(0, capTop, r.w, capH).fill({ color: CAP_LIGHT });
    capLight.blendMode = CAP_LIGHT_BLEND;
    seg.addChild(capLight);
  }
  for (let i = capFrom; i < seg.children.length; i++) seg.children[i]!.label = XRAY_LABEL;
  // Everything drawn BEFORE the cap is the front face (one branch or the other above), and the
  // shading laid over both comes next — the deep group is those two.
  for (let i = 0; i < capFrom; i++) seg.children[i]!.label = XRAY_DEEP_LABEL;

  const shading = drawBlockShading(r, height, joins);
  shading.label = XRAY_DEEP_LABEL;
  seg.addChild(shading);

  // The flat-cel silhouette design/13 asks for, and the cue that separates one standing wall
  // from the one behind it. Dark, not `palette.wallEdge` — see EDGE_COLOR. The lit coping runs
  // along the cap's north AND west edges (the two facing the key light); there is deliberately
  // none at the cap/face joint, which gets the dark fold line in `drawBlockShading` instead.
  //
  // Drawn as four explicit sides rather than one `rect` stroke, because the NORTH side is the one
  // that may not exist: where the block butts a mass of at least its own height, its cap runs
  // straight on into that mass's cap and an outline there is a line drawn across one surface.
  const edge = new Graphics();
  const openNorth = unjoinedSpans(r.w, joins.north);
  for (const [a, b] of openNorth) edge.moveTo(a, capTop).lineTo(b, capTop);
  edge.moveTo(r.w, capTop).lineTo(r.w, 0).lineTo(0, 0).lineTo(0, capTop);
  edge.stroke({ color: EDGE_COLOR, width: EDGE_WIDTH, alpha: EDGE_ALPHA });
  if (openNorth.length > 0) {
    for (const [a, b] of openNorth) edge.moveTo(a, capTop).lineTo(b, capTop);
    edge.stroke({ color: 0xffffff, width: 1, alpha: COPING_ALPHA });
  }
  edge.moveTo(0, capTop).lineTo(0, -height).stroke({ color: 0xffffff, width: 1, alpha: COPING_ALPHA });
  seg.addChild(edge);

  seg.place(r.x, r.y + r.h);
  return seg;
}

/** One layer of the cap: the top-down swatch over the footprint, tiled in WORLD space so
 *  neighbouring blocks share one continuous stone field. Used twice — once for the surface, once
 *  as its additive key light. */
function capTile(
  texture: Texture,
  r: RectPx,
  capTop: number,
  capH: number,
  tint: number,
  alpha: number,
  blendMode: 'inherit' | typeof CAP_LIGHT_BLEND,
): TilingSprite {
  const tile = new TilingSprite({ texture, width: r.w, height: capH });
  tile.position.set(0, capTop);
  // Locked to the sprite's own WORLD origin rather than to the footprint, so clipping the top of a
  // tucked run's cap slides the sprite without sliding the stone inside it. The entity sits at
  // `r.y + r.h`, so this sprite's local (0,0) is world y `capTop + r.y + r.h`.
  tile.tilePosition.set(-r.x, -(capTop + r.y + r.h));
  tile.tint = tint;
  tile.alpha = alpha;
  tile.blendMode = blendMode;
  return tile;
}

/**
 * The shading that turns cap + face into a solid: the cap's depth gradient, the correction that
 * stops the face art's coping course out-shining the cap above it, a lit west chamfer, a dark
 * inset east band standing in for the block's own thickness (bounded so it cannot become a
 * painted stripe down a long run's top), a narrow bevel along the cap's own long edges, the hard
 * cap/face fold, the re-entrant corner a tuck makes with its neighbours on both sides, and the
 * crease where the face meets the floor. The cap's additive key light is NOT here — a blend mode
 * is per display object, see `buildWallBlock`. Local coords, same space as `buildWallBlock`.
 *
 * Each pass is its own function — `wallShadingSurfaces.ts` for the cues a block draws from its
 * own geometry alone, `wallShadingJoins.ts` for the ones that only exist because of a specific
 * neighbouring mass (split out 2026-08-20, 500-line convention: CLAUDE.md form ① — a batch of
 * independent Graphics-drawing functions with no shared private state beyond `g` itself). Order
 * here is load-bearing: Pixi paints fills in call order, and this is the same sequence the
 * `wallTone.ts` numbers were measured against. Exported for tests.
 */
export function drawBlockShading(r: RectPx, height: number, joins: WallJoins = NO_JOINS): Graphics {
  const g = new Graphics();
  drawCapDepthGradient(g, r, height, joins);
  drawFaceCopingSuppress(g, r, height);
  drawSideBands(g, r, height, joins);
  drawCapEdgeBevel(g, r, height, joins);
  drawCapFold(g, r, height, joins);
  drawTuckCapCrease(g, r, height, joins);
  drawTuckFaceCrease(g, r, height, joins);
  drawCornerAO(g, r, height, joins);
  drawBaseContactCrease(g, r, height);
  return g;
}

/**
 * Paint one wall's shadow onto `g` (a single shared Graphics on `layers.shadow`, so a room's
 * whole set of wall shadows costs one display object).
 *
 * A box of height `height` lit from the upper left throws its footprint down-right by
 * `height * SHADOW_SLANT_*`; the union of the footprint and that displaced copy is a hexagon
 * (the two rects' convex hull), which is what each pass fills, at four graduated slants so the
 * result ramps instead of showing its own polygon edges. Then `BASE_HUG` darkens the floor all
 * the way around the footprint — see its doc for why the old contact pass was invisible.
 */
export function drawWallShadow(g: Graphics, r: RectPx, height: number): void {
  for (const [mul, alpha] of CAST_PASSES) {
    const dx = height * SHADOW_SLANT_X * mul;
    const dy = height * SHADOW_SLANT_Y * mul;
    g.poly(sweptHull(r, dx, dy)).fill({ color: SHADOW_COLOR, alpha });
  }
  for (const [out, alpha] of BASE_HUG) {
    g.rect(r.x - out, r.y - out, r.w + out * 2, r.h + out * 2)
      .stroke({ color: SHADOW_COLOR, width: HUG_WIDTH, alpha });
  }
}

/**
 * Convex hull of an axis-aligned rect and the same rect translated by a strictly positive
 * `(dx, dy)` — six vertices, clockwise from the rect's north-west corner. This is the ground
 * silhouette of a box's shadow: two corners of the original, two of the displaced copy, and
 * the two shared corners where the sweep starts. Exported for tests.
 */
export function sweptHull(r: RectPx, dx: number, dy: number): number[] {
  return [
    r.x, r.y,
    r.x + r.w, r.y,
    r.x + r.w + dx, r.y + dy,
    r.x + r.w + dx, r.y + r.h + dy,
    r.x + dx, r.y + r.h + dy,
    r.x, r.y + r.h,
  ];
}
