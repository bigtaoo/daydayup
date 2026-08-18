// Split out of RoomBuilder (2026-08-18, 500-line convention + separation of concerns): how a
// standing wall is DRAWN. `wallGeometry.ts` decides how tall each segment is; this file turns
// one footprint + height into the extruded block Entity and the shadow it throws on the
// floor. Free functions over a Graphics/Entity — no scene state, no room model.
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
//      A volume needs its three surfaces separated: top brightest, front mid, side darkest.
//   3. **No side thickness.** A block's east/west sides project to exactly zero width under
//      `screen.y = gy - z` (there is no horizontal skew in this projection), so a
//      north-south run showed only a cap and a small end face. The east side is now drawn
//      as an inset dark band — a deliberate cheat, inset rather than extruded so it can
//      never overlap the neighbouring segment of the same run.
import { Graphics, TilingSprite, type Texture } from 'pixi.js';
import { Entity } from './Entity';
import { SHADOW_SLANT_X, SHADOW_SLANT_Y } from './Entity';
import { mixHex, type BiomePalette } from '../theme';
import type { RectPx } from './wallGeometry';

/**
 * Multiply tint per surface. These three numbers ARE the volume — everything else here is
 * supporting detail.
 *
 * Tuned against a live render (2026-08-18) rather than picked on paper, and the live render
 * changed the answer twice. The first attempt was cap 1.0 / face 0.72, which looked wrong for
 * a reason that only shows up on real art: the two swatches do not start from the same value.
 * `wall_<element>.png` (the cap) is a LIGHT grey stone — it was authored as a top-down surface
 * that had to stand out against a near-black floor — while `wallface_<element>.png` is dark
 * charcoal brick. A 0.72 face on top of that gap was not far enough for the fold between the
 * two surfaces to read as one solid turning a corner, and a deep north-south block (level 1's
 * blocks are up to 6 grid cells deep, so ~70% of what you see of one is its cap) came out as
 * a pale slab with a thin dark hem. Pulling the face down hard — and leaving the cap bright,
 * which is what a top surface under an upper-left key light should be — is what makes the two
 * read as top-and-front of the same block.
 */
const CAP_TINT = 0xf2f4f8; // ~0.95 — barely off the swatch's own value; the top IS the lit face
const FACE_TINT = 0x7f869a; // ~0.5 — a vertical surface catches far less of an overhead light
const SIDE_SHADE = 0.5; // east side band, as an alpha of black over cap+face

/** The block's silhouette outline. Was `palette.wallEdge` until 2026-08-18, which is a LIGHT
 *  salmon/steel for every biome — authored to be the highlight edge of a wall lying FLAT on
 *  the floor, where a light rim is right. On a standing block, stroked 2 px and then magnified
 *  by the room camera, it read as a bright wireframe box drawn over the art: in the live render
 *  it was the single loudest thing in the frame, louder than any of the shading. design/13 asks
 *  for a flat-cel silhouette, and a silhouette is DARK. */
const EDGE_COLOR = 0x0a0c12;
const EDGE_ALPHA = 0.62;
const EDGE_WIDTH = 1.5;

/** A 1 px lit coping along the cap's far (north) edge — the one place a bright rim belongs,
 *  since that edge is the block's top corner turning away from the camera into the light. */
const COPING_ALPHA = 0.22;

/** Width of the faked east-side band and the lit west edge, in world px, capped at a share of
 *  the wall's own width so a thin stub isn't entirely side. */
const SIDE_BAND_PX = 13;
const SIDE_BAND_MAX_FRACTION = 0.34;
const LIT_EDGE_PX = 4;

/** The dark contact band at the very bottom of the front face, where the wall meets the
 *  floor: `[height fraction of the wall, alpha]`, widest/faintest first. Ambient occlusion —
 *  the crease a vertical surface makes with a horizontal one is the darkest place in any
 *  room, and its absence is why a wall face can look like a poster. */
const BASE_AO: ReadonlyArray<readonly [number, number]> = [
  [0.3, 0.14],
  [0.16, 0.18],
  [0.07, 0.22],
];

/** Cast-shadow passes: `[slant multiplier, alpha]`. The far pass is the penumbra, the near
 *  one darkens the region closest to the base. Both slant by the same fixed key-light
 *  direction every shadow in this project uses (`Entity`'s SHADOW_SLANT_*). */
// Alphas raised from 0.20/0.16/0.26 on 2026-08-18 after looking at the live render: the ember
// floor is near-black charcoal, so a 20%-black quad over it is genuinely imperceptible. What
// the shadow actually has to modulate on this biome is the floor's LAVA CRACKS — the only
// bright thing on the ground — and dimming those needs real opacity. On a light-floor biome
// this will read as an ordinary soft shadow.
const CAST_PASSES: ReadonlyArray<readonly [number, number]> = [
  [1, 0.34],
  [0.45, 0.26],
];
/** A tight dark hug right at the footprint, independent of height — the contact shadow. */
const CONTACT_GROW_PX = 3;
const CONTACT_ALPHA = 0.4;
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

  seg.addChild(drawBlockShading(r, height));

  // The flat-cel silhouette design/13 asks for, and the cue that separates one standing wall
  // from the one behind it. Dark, not `palette.wallEdge` — see EDGE_COLOR. No lit rim line at
  // the cap/face joint either: the face art carries its own lit coping course there, and a
  // second highlight on top of it read as a stray bright bar.
  const edge = new Graphics();
  edge.rect(0, capTop, r.w, height + r.h).stroke({ color: EDGE_COLOR, width: EDGE_WIDTH, alpha: EDGE_ALPHA });
  edge.moveTo(0, capTop).lineTo(r.w, capTop).stroke({ color: 0xffffff, width: 1, alpha: COPING_ALPHA });
  seg.addChild(edge);

  seg.place(r.x, r.y + r.h);
  return seg;
}

/**
 * The shading that turns cap + face into a solid: a lit west edge, a dark inset east side
 * band standing in for the block's own thickness, and the ambient-occlusion crease where the
 * face meets the floor. Local coords, same space as `buildWallBlock`. Exported for tests.
 */
export function drawBlockShading(r: RectPx, height: number): Graphics {
  const g = new Graphics();
  const capTop = -height - r.h;
  const band = Math.min(SIDE_BAND_PX, r.w * SIDE_BAND_MAX_FRACTION);
  const litEdge = Math.min(LIT_EDGE_PX, r.w * SIDE_BAND_MAX_FRACTION);

  // West edge catches the key light: a thin bright strip down the whole block.
  g.rect(0, capTop, litEdge, height + r.h).fill({ color: 0xffffff, alpha: 0.1 });
  // East side in shadow, inset so it never crosses into the next segment of the same run.
  g.rect(r.w - band, capTop, band, height + r.h).fill({ color: 0x000000, alpha: SIDE_SHADE });
  // Contact crease along the base of the front face.
  for (const [hFrac, alpha] of BASE_AO) {
    const bandH = height * hFrac;
    g.rect(0, -bandH, r.w, bandH).fill({ color: 0x000000, alpha });
  }
  return g;
}

/**
 * Paint one wall's shadow onto `g` (a single shared Graphics on `layers.shadow`, so a room's
 * whole set of wall shadows costs one display object).
 *
 * A box of height `height` lit from the upper left throws its footprint down-right by
 * `height * SHADOW_SLANT_*`; the union of the footprint and that displaced copy is a hexagon
 * (the two rects' convex hull), which is what each pass fills. The near pass reuses the same
 * hull at a shorter slant so the region closest to the wall ends up darker — a penumbra
 * without a blur filter.
 */
export function drawWallShadow(g: Graphics, r: RectPx, height: number): void {
  for (const [mul, alpha] of CAST_PASSES) {
    const dx = height * SHADOW_SLANT_X * mul;
    const dy = height * SHADOW_SLANT_Y * mul;
    g.poly(sweptHull(r, dx, dy)).fill({ color: SHADOW_COLOR, alpha });
  }
  const c = CONTACT_GROW_PX;
  g.rect(r.x - c, r.y - c, r.w + c * 2, r.h + c * 2).fill({ color: SHADOW_COLOR, alpha: CONTACT_ALPHA });
}

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
 */
const PILLAR_LIT = 0x5c6470; // west limb, catching the key light
const PILLAR_MID = 0x424954; // the shaft's own local colour
const PILLAR_DARK = 0x1e222a; // east limb, turned away
const PILLAR_TOP = 0x69727f; // the top surface — the most exposed plane on the object
const PILLAR_BIOME_MIX = 0.16;
/** Bands across the shaft. Each is filled with an INTERPOLATED COLOUR rather than stacked as an
 *  alpha overlay: a 4x render of the first attempt (9 alpha bands) showed nine hard vertical
 *  seams, because overlapping translucent rects step in opacity, not in tone. Interpolating the
 *  fill instead makes the step invisible at this count while staying pure Graphics — no
 *  gradient-fill API, no per-pillar filter. */
const PILLAR_RAMP_STEPS = 22;
/** Where across the shaft the terminator sits (0 = west limb, 1 = east limb). */
const PILLAR_TERMINATOR = 0.36;

/**
 * A pillar as a stone cylinder in the same tonal language as a standing wall — a lit top
 * ellipse, a shaft shaded across its curve, a base contact crease, and the same dark
 * silhouette. Local coords with the origin at the pillar's ground point, so `bodyW`/`height`
 * are what `RoomBuilder` already computes.
 *
 * Lives here rather than in RoomBuilder (2026-08-18) because of what the live renders of this
 * pass showed, over three attempts:
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
  const capRy = Math.max(8, bodyW * PILLAR_CAP_RY_FRACTION);
  const capRx = bodyW / 2 + PILLAR_CAP_OVERHANG_PX;
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

  // Base contact crease, same shape and strength a wall's gets.
  for (const [hFrac, alpha] of BASE_AO) {
    const h = height * hFrac;
    g.roundRect(-bodyW / 2, -h, bodyW, h + PILLAR_BASE_PX, corner).fill({ color: 0x000000, alpha });
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
