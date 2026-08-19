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
import { Graphics, TilingSprite, type Texture } from 'pixi.js';
import { Entity } from './Entity';
import { SHADOW_SLANT_X, SHADOW_SLANT_Y } from './Entity';
import type { BiomePalette } from '../theme';
import type { RectPx } from './wallGeometry';
import {
  BASE_AO_BANDS,
  BASE_AO_FRACTION,
  BASE_AO_MAX,
  CAP_GRADIENT_BANDS,
  CAP_GRADIENT_MAX,
  CAP_GRADIENT_REACH_PX,
  CAP_LIGHT,
  CAP_LIGHT_BLEND,
  CAP_TINT,
  COPING_ALPHA,
  EDGE_ALPHA,
  EDGE_COLOR,
  EDGE_WIDTH,
  FACE_COPING_BANDS,
  FACE_COPING_FRACTION,
  FACE_COPING_SUPPRESS,
  FACE_TINT,
  FOLD_ALPHA,
  FOLD_WIDTH,
  LIT_EDGE_ALPHA,
  LIT_EDGE_COLOR,
  LIT_EDGE_PX,
  SIDE_ALPHA,
  SIDE_BAND_MAX_FRACTION,
  SIDE_BAND_PX,
  SIDE_COLOR,
  SIDE_STEPS,
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
export function buildWallBlock(r: RectPx, height: number, skin: WallSkin): Entity {
  const seg = new Entity();
  const capTop = -height - r.h;

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

  if (skin.cap) {
    const cap = new TilingSprite({ texture: skin.cap, width: r.w, height: r.h });
    cap.position.set(0, capTop);
    cap.tint = CAP_TINT;
    seg.addChild(cap);
  } else {
    const g = new Graphics();
    g.rect(0, capTop, r.w, r.h).fill({ color: skin.palette.pillarTop });
    seg.addChild(g);
  }

  // The cap's key light, additive so the stone keeps its own contrast (see `CAP_LIGHT`). Its own
  // child rather than part of `drawBlockShading`, because a blend mode is per display object and
  // everything else here composites normally.
  const capLight = new Graphics();
  capLight.rect(0, capTop, r.w, r.h).fill({ color: CAP_LIGHT });
  capLight.blendMode = CAP_LIGHT_BLEND;
  seg.addChild(capLight);

  seg.addChild(drawBlockShading(r, height));

  // The flat-cel silhouette design/13 asks for, and the cue that separates one standing wall
  // from the one behind it. Dark, not `palette.wallEdge` — see EDGE_COLOR. The lit coping runs
  // along the cap's north AND west edges (the two facing the key light); there is deliberately
  // none at the cap/face joint, which gets the dark fold line in `drawBlockShading` instead.
  const edge = new Graphics();
  edge.rect(0, capTop, r.w, height + r.h).stroke({ color: EDGE_COLOR, width: EDGE_WIDTH, alpha: EDGE_ALPHA });
  edge.moveTo(0, capTop).lineTo(r.w, capTop).stroke({ color: 0xffffff, width: 1, alpha: COPING_ALPHA });
  edge.moveTo(0, capTop).lineTo(0, -height).stroke({ color: 0xffffff, width: 1, alpha: COPING_ALPHA });
  seg.addChild(edge);

  seg.place(r.x, r.y + r.h);
  return seg;
}

/**
 * The shading that turns cap + face into a solid: the cap's depth gradient, the correction that
 * stops the face art's coping course out-shining the cap above it, a lit west chamfer, a dark
 * inset east band standing in for the block's own thickness, the hard cap/face fold, and the
 * crease where the face meets the floor. The cap's additive key light is NOT here — a blend mode
 * is per display object, see `buildWallBlock`. Local coords, same space as `buildWallBlock`.
 * Exported for tests.
 */
export function drawBlockShading(r: RectPx, height: number): Graphics {
  const g = new Graphics();
  const capTop = -height - r.h;
  const band = Math.min(SIDE_BAND_PX, r.w * SIDE_BAND_MAX_FRACTION);
  const litEdge = Math.min(LIT_EDGE_PX, r.w * SIDE_BAND_MAX_FRACTION);

  // Cap depth gradient, falling from the far edge toward the fold and bounded to
  // CAP_GRADIENT_REACH_PX of it (a north-south run's cap depth is its whole LENGTH).
  const capReach = Math.min(r.h, CAP_GRADIENT_REACH_PX);
  const capStep = capReach / CAP_GRADIENT_BANDS;
  for (let i = 0; i < CAP_GRADIENT_BANDS; i++) {
    const t = (i + 0.5) / CAP_GRADIENT_BANDS;
    g.rect(0, -height - capReach + i * capStep, r.w, capStep)
      .fill({ color: 0x000000, alpha: t * CAP_GRADIENT_MAX });
  }

  // The face swatch's own coping course, pulled back under the cap's value — see
  // FACE_COPING_SUPPRESS for why the art needs this and a uniform tint cannot do it.
  const copingH = height * FACE_COPING_FRACTION;
  const copingStep = copingH / FACE_COPING_BANDS;
  for (let i = 0; i < FACE_COPING_BANDS; i++) {
    const t = (i + 0.5) / FACE_COPING_BANDS; // 0 at the fold → 1 at the band's lower edge
    g.rect(0, -height + i * copingStep, r.w, copingStep)
      .fill({ color: 0x000000, alpha: (1 - t) * FACE_COPING_SUPPRESS });
  }

  // West chamfer catches the key light, east side turns away from it. Both stepped across their
  // width rather than drawn as one flat rect: a single alpha reads as a translucent panel laid
  // over the art, a ramp reads as a surface curving away. Strongest at the block's outer edge in
  // both cases, since that is where each surface has turned furthest.
  const chamferStep = litEdge / SIDE_STEPS;
  const sideStep = band / SIDE_STEPS;
  for (let i = 0; i < SIDE_STEPS; i++) {
    const t = (i + 0.5) / SIDE_STEPS; // 0 at the outer edge → 1 at the inner one
    g.rect(0 + i * chamferStep, capTop, chamferStep, height + r.h)
      .fill({ color: LIT_EDGE_COLOR, alpha: (1 - t) * LIT_EDGE_ALPHA });
    g.rect(r.w - band + i * sideStep, capTop, sideStep, height + r.h)
      .fill({ color: SIDE_COLOR, alpha: (0.45 + 0.55 * t) * SIDE_ALPHA });
  }

  // The cap/face fold.
  g.moveTo(0, -height).lineTo(r.w, -height).stroke({ color: EDGE_COLOR, width: FOLD_WIDTH, alpha: FOLD_ALPHA });

  // Contact crease along the base of the front face.
  const aoH = height * BASE_AO_FRACTION;
  const aoStep = aoH / BASE_AO_BANDS;
  for (let i = 0; i < BASE_AO_BANDS; i++) {
    const t = (i + 0.5) / BASE_AO_BANDS;
    g.rect(0, -aoH + i * aoStep, r.w, aoStep).fill({ color: 0x000000, alpha: t * BASE_AO_MAX });
  }
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
