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
//   face   = lintel stone, then the recess (a dark tunnel, not a painted panel), then the leaf,
//            then whichever of the two states' lights is live: a locked door's hazard bloom or an
//            open one's light from beyond (`THROUGH_*`/`SPILL_*` — see their block below for why
//            an open door needed one at all).
//
// **THE LEAF IS FIT BY WIDTH AND CROPPED, NEVER SQUASHED.** Both swatches are portrait 147x217 and
// 156x224 — their sizes AFTER this pass re-trimmed their margins, not the 221x320 above, which
// this line went on claiming long enough to make the crop look twice as generous as it was
// (`doorStandCoverage.test.ts` reads the shipped IHDR now). An opening is 64 x 104 through a room
// boundary and 128 x 104 through a kerb: ONE height for every door since 2026-09-03
// (`wallGeometry.DOOR_H`), where the kerb case was 128 x 22 and fitting both axes would have
// squashed the art 8:1. Instead it is scaled by WIDTH, bottom-anchored, and any overflow is
// cropped off the TOP via a source frame: a 64-wide opening shows the whole leaf under a band of
// lintel stone, a 128-wide one its bottom 55% — the frame feet and the hazard stripes — at the
// room's own stone scale. `doorLeafFrame` is the pure half of that rule, tested without a canvas.
import { Graphics, Sprite, Texture } from 'pixi.js';
import { Entity } from './Entity';
import type { RectPx } from './wallGeometry';
import { addBlockEdge, addCapLayers, addWallFace, drawBlockShading, type WallSkin } from './wallRender';
import { blockCapTop, NO_JOINS, type WallJoins } from './wallRuns';
import { XRAY_DEEP_LABEL, XRAY_LABEL, type FadeLayer } from './occlusion';
import { applyLeaf, doorLeafFrame, fitArtToOpening, leafHeight } from './doorLeaf';
// The still LIGHT and SHADE layers moved to `doorLights.ts` 2026-09-03 (500-line convention,
// CLAUDE.md form 1) to make room for the animation pass; the MOTION lives in `doorFx.ts`. Both
// are re-exported below so every pre-split import path stays valid.
import {
  buildOpenFloorTile,
  drawGlow,
  drawOpenRecessShade,
  drawRecess,
  drawSill,
  drawSpill,
  drawThroughLight,
} from './doorLights';
import { DoorFx, flameBandRect } from './doorFx';

// Re-exported so the pre-split import paths (`import { doorLeafFrame } from './doorRender'` and
// `import { drawSpill, drawThroughLight } from './doorRender'`, used by the four door test files
// and by `doorLightCoverage.test.ts`) stay valid — CLAUDE.md's "keep the original path alive as a
// thin re-export" rule for a file-length split.
export { doorLeafFrame };
export { drawGlow, drawOpenRecessShade, drawRecess, drawSill, drawSpill, drawThroughLight };

/** Textures a door is drawn from: the wall's own two swatches (so the stone around the opening
 *  is the room's stone) plus the two leaf elevations. Any of them missing falls back to palette
 *  Graphics, the same contract as every other swatch in this layer. */
export interface DoorSkin extends WallSkin {
  leaf: Texture | undefined;
  /** The room's own floor swatch. Drawn, tiled, across the OPEN state's recess (see
   *  `buildOpenFloorTile`) so a passable door's tunnel visibly continues the room's floor instead
   *  of being a flat colour — undefined falls back to a flat tone, the same optional-swatch
   *  contract every other field here has. */
  floor: Texture | undefined;
  /** The open state's own illustrated curtain-of-light (2026-08-30b) — see the constant block
   *  above `buildOpenFloorTile` for why the floor tile alone still wasn't enough. Undefined falls
   *  back to the procedural `drawThroughLight` ramp, same optional-swatch contract as `leaf`. */
  curtain: Texture | undefined;
}

/** One built door: the standing fixture plus the in-place lock-state swap `RoomBuilder.updateDoors`
 *  needs (design/05 "exactly two visual states" — a flip must not cost a room rebuild). */
export interface DoorFixture {
  readonly view: Entity;
  /** The layers the occlusion x-ray fades when this fixture hides a character: its cap, and
   *  everything below the cap/face fold (leaf, recess, lintel, and both states' lights). Same
   *  split as a wall — see `occlusion.xrayLayers`. */
  readonly capLayers: readonly FadeLayer[];
  readonly deepLayers: readonly FadeLayer[];
  setLocked(locked: boolean, leaf: Texture | undefined): void;
  /** One render frame of this door's motion (`doorFx.ts`). `near` is 0 across the room and 1 with
   *  the player standing in the doorway. Driven by `RoomBuilder.tickFixtures`, which is also what
   *  decides a door is on screen at all — an off-screen door is never ticked. */
  tick(dt: number, near: number): void;
  /** The player walked into this door and did not get through it — `GameLoop` derives that on the
   *  client and calls this; nothing about it reaches the sim. No-op on an open door. */
  reject(): void;
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
  index = 0,
): DoorFixture {
  const seg = new Entity();
  const capTop = blockCapTop(r, height, joins);
  const capH = -height - capTop;

  const leafDrawH = leafHeight(r.w, height, skin.leaf);
  // The art the leaf is CURRENTLY showing — `setLocked` needs the OUTGOING texture to hand to the
  // crossfade ghost, and the caller only ever passes it the incoming one.
  let currentLeaf = skin.leaf;

  // 1. The wall's own elevation across the WHOLE face: the lintel above the leaf, and the
  //    passage's stone behind it once the recess has darkened it.
  //
  //    Deliberately WITHOUT `occlusion.deepFadeReach`, which a wall block passes so the deep pass
  //    cannot reach its base: that bound is derived from a focus standing NORTH of the footprint,
  //    and a door's passage floor is inside its own footprint. A character in the doorway stands
  //    on rows the derivation excludes, so the whole face has to stay in the fading group here —
  //    the same reason the recess, the leaf and the glow are all in it.
  addWallFace(seg, r, height, skin);

  // 2. Recess — the tunnel behind the leaf. A LOCKED door draws the full-depth dark bands only,
  //    same as before; an OPEN one instead shows the room's own floor tiled across the opening,
  //    faintly darkened by the same ramp at a much lighter pair of alphas, so the passage floor
  //    visibly continues past the threshold instead of reading as a hole in the wall — see
  //    `OPEN_RECESS_ALPHA_TOP` for why. Both built up front and toggled by `.visible`, same
  //    pattern as glow/through/spill below, so `setLocked` never rebuilds.
  //    Since 2026-09-03 the `.visible`/`alpha` of every state-specific layer below belongs to
  //    `DoorFx` (it crossfades them through a lock change instead of cutting), so nothing here
  //    sets either — they are handed over as the two state groups at the end of this function.
  const recessLocked = new Graphics();
  drawRecess(recessLocked, r.w, leafDrawH);
  seg.addChild(recessLocked);

  const openFloor = buildOpenFloorTile(r.w, leafDrawH, skin.floor);
  seg.addChild(openFloor);

  const openShade = new Graphics();
  drawOpenRecessShade(openShade, r.w, leafDrawH);
  seg.addChild(openShade);

  // 3. The light from the room beyond (open only), UNDER the leaf: the arch art's own stone is
  //    what shapes it, so it reaches the floor of the passage and no part of the frame.
  const through = new Graphics();
  drawThroughLight(through, r.w, leafDrawH);
  through.blendMode = 'add';
  seg.addChild(through);

  // 3b. The open state's own illustrated curtain-of-light (2026-08-30b, live report after the
  //     floor-tile pass above had already shipped: *"依然不行...被阻挡时的火焰很明显，但是可以通过
  //     的效果太弱了"* — the locked leaf is a whole illustrated hazard panel, so nothing built out
  //     of gradients was ever going to match its weight). Same additive slot as `through` (behind
  //     the leaf, confined to the opening by its transparent middle for free) — when this art is
  //     loaded it REPLACES `through` rather than layering over it, and `through` falls back to
  //     carrying the cue alone when the art hasn't loaded yet, same optional-swatch contract as
  //     `leaf`/`floor`. Fit by the same `doorLeafFrame` rule as the leaf: a kerb door crops to the
  //     curtain's own BOTTOM, which is its brightest, densest band, not an arbitrary slice.
  let curtain: Sprite | undefined;
  if (skin.curtain) {
    curtain = new Sprite();
    // `fitArtToOpening` sets texture/width/height only — same as the leaf below, whose sprite
    // is positioned BEFORE `applyLeaf` runs. Missing this left the curtain's default (0, 0)
    // anchor drawing it from the threshold DOWNWARD into the room floor instead of upward into
    // the opening, invisible in play despite being visible/additive/correctly sized — caught by
    // dumping the live fixture's children rather than by any test, since no assertion here
    // checks a sprite's POSITION (only its size and the state machine around it).
    curtain.position.set(0, -leafDrawH);
    fitArtToOpening(curtain, r.w, leafDrawH, skin.curtain);
    curtain.blendMode = 'add';
    seg.addChild(curtain);
  }
  // The procedural ramp is the no-art FALLBACK for the curtain, never a layer under it — with the
  // art loaded it is off for the fixture's whole life and never joins the open group below.
  if (curtain) through.visible = false;


  // 4. Leaf, plus the ghost a lock change crossfades FROM. One sprite could only cut between the
  //    two elevations; the ghost holds the outgoing art and fades out over `doorFx`'s transition.
  const leaf = new Sprite();
  leaf.position.set(0, -leafDrawH);
  applyLeaf(leaf, r.w, leafDrawH, skin.leaf, locked);
  seg.addChild(leaf);

  const leafGhost = new Sprite();
  leafGhost.position.set(0, -leafDrawH);
  seg.addChild(leafGhost);

  // 5. The two states' floor-level signals, both additive so they lift what is under them rather
  //    than washing it out, both over the leaf, exactly one of them visible.
  const glow = new Graphics();
  drawGlow(glow, r.w, leafDrawH);
  glow.blendMode = 'add';
  seg.addChild(glow);

  const spill = new Graphics();
  drawSpill(spill, r.w, leafDrawH);
  spill.blendMode = 'add';
  seg.addChild(spill);

  // 6. The motion (`doorFx.ts`), over every other opening layer: the flame overlay has to reach an
  //    opaque hazard leaf, and a mote crossing the threshold has to draw over the pool lighting it.
  //    `flameBandRect` maps the measured fire band through the leaf's own top crop, so a kerb door
  //    animates whatever of the fire survived that crop and builds no flame layers if none did.
  const frame = skin.leaf ? doorLeafFrame(r.w, height, skin.leaf.width, skin.leaf.height) : null;
  const fx = new DoorFx(
    r.w,
    leafDrawH,
    frame && skin.leaf
      ? flameBandRect(r.w, leafDrawH, frame.srcY, frame.srcH, skin.leaf.height)
      : { x: 0, y: 0, w: 0, h: 0 },
    {
      leafGhost,
      lockedBase: [recessLocked],
      lockedLit: [glow],
      openBase: [openFloor, openShade],
      openLit: curtain ? [curtain, spill] : [through, spill],
    },
    index,
    locked,
  );
  // `behind` belongs in the same slot as `through`/`curtain` and for the same reason — under the
  // leaf, so the arch art's own stone masks it — but it can only be built once the fixture's own
  // layers exist, so it is moved into place here rather than added in order above.
  seg.addChildAt(fx.behind, seg.getChildIndex(leaf));
  seg.addChild(fx.over);

  // Everything so far is the opening — the group that fades only when a cap fade cannot save a
  // character standing in the doorway (`occlusion.needsDeepFade`), which for a door is the common
  // case rather than the rare one: the passage floor is entirely inside the fixture's own art.
  //
  // Every layer whose alpha `DoorFx` owns is deliberately left OUT of that group and represented
  // in it by `fx.xrayLayer` instead — see that field for why two writers on one `alpha` silently
  // disables the fade on exactly the layers a character in a doorway most needs faded.
  const capFrom = seg.children.length;
  addCapLayers(seg, r, capTop, capH, skin);
  const fxOwned = new Set<unknown>([recessLocked, openFloor, openShade, through, curtain, glow, spill, leafGhost, fx.behind, fx.over]);
  for (let i = 0; i < capFrom; i++) {
    const c = seg.children[i]!;
    if (!fxOwned.has(c)) c.label = XRAY_DEEP_LABEL;
  }

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
  const deepLayers: FadeLayer[] = [...seg.children.filter((c) => c.label === XRAY_DEEP_LABEL), fx.xrayLayer];

  return {
    view: seg,
    capLayers,
    deepLayers,
    setLocked(next: boolean, tex: Texture | undefined): void {
      const changed = next !== fx.isLocked;
      // The ghost takes the art we are LEAVING before the leaf takes the art we are going to, so
      // the crossfade has both elevations on screen for the transition's duration.
      if (changed) applyLeaf(leafGhost, r.w, leafDrawH, currentLeaf, fx.isLocked);
      applyLeaf(leaf, r.w, leafDrawH, tex, next);
      currentLeaf = tex;
      fx.setLocked(next, changed);
    },
    tick(dt: number, near: number): void {
      fx.tick(dt, near);
    },
    reject(): void {
      fx.reject();
    },
  };
}
