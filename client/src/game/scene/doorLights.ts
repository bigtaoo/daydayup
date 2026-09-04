// Split out of doorRender.ts 2026-09-03 (500-line convention, CLAUDE.md form 1 — independent
// function modules): every LIGHT and SHADE layer a door is composited from, as free functions
// over one opening size. No shared private state with the assembly in doorRender.ts, which
// re-exports all of these so the pre-split import path (import { drawGlow } from './doorRender',
// used by four door test files) stays valid.
//
// These are the STILL layers — each is drawn once when a door is built and then only toggled by
// visible. What MOVES lives in doorFx.ts, which reads four of the colours/shapes below so the
// animated layers and the static ones stay one palette.
import { Graphics, Texture, TilingSprite } from 'pixi.js';
import type { RectPx } from './wallGeometry';
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

/**
 * The OPEN state's own recess alphas — the same band shape as a locked door's, over the room's own
 * floor swatch instead of over more wall stone (`buildOpenFloorTile`).
 *
 * **Why this exists (2026-08-30, second pass the same day as the through/spill/rim lighting
 * above).** That pass gave an open door light, but the base it sits on top of was left untouched:
 * `drawRecess`'s default alphas darken the SAME wall-stone elevation for both states, so a
 * passable door and a locked one differ only in how much light is added on top of an otherwise
 * identical dark tunnel. Live report, after the lighting pass had already shipped: *"可以通过时的门，
 * 好了一些，但离我想要的效果还差很远"* (better, but still far from the effect wanted) — circling the
 * opening itself, not the light. The tunnel needs to say "floor" before the light says "lit".
 *
 * Numbers are far lighter than the locked pair: the floor swatch is what has to read, and the
 * locked alphas (0.72/0.34) would bury it under almost the same near-black wash the flat colour
 * used to be. Kept as bands rather than one flat alpha for the same reason as every other ramp in
 * this file — a single value draws its own hard edge at the top of the opening.
 */
const OPEN_RECESS_ALPHA_TOP = 0.42;
const OPEN_RECESS_ALPHA_FLOOR = 0.04;

/** No-floor-art fallback for the open recess: a flat tone between the room floor and the near-black
 *  `RECESS_COLOR`, so degraded content (no swatches loaded at all) still tells a locked tunnel from
 *  an open one at the base layer, not only via the light layered on top of it. */
const OPEN_RECESS_FALLBACK_COLOR = 0x2a2f3a;

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
 *
 * Since 2026-09-03d "immediately south of the threshold" is only where a door in an EAST-WEST wall
 * puts its pool — `DoorFloorPlane` below decides, because for the other 13 shipped doors the ground
 * south of the threshold is more wall.
 */
export const GLOW_COLOR = 0xff3a1e;
/** Pool rings, widest first: `rx` as a multiple of `DoorFloorPlane.span`, all at `GLOW_RING_ALPHA`.
 *  Graduated for the same reason `wallRender.CAST_PASSES` is — one ellipse at one alpha shows its
 *  own hard edge and reads as a painted rug on the floor, which is what the first version looked
 *  like; five rings still showed three of their edges. Nine at a third of the alpha each ramps
 *  smoothly and lands in the same place: A/B'd against the same frame with the layer hidden, the
 *  pool moves a 200x90 px region by a MEAN of +4.0 luma (max +27, 41% of pixels moving more than
 *  3/255) — real, unlike the wall relief filter this project measured at 0.06% and deleted. */
export const GLOW_POOL: readonly number[] = [1.35, 1.2, 1.05, 0.9, 0.76, 0.62, 0.5, 0.38, 0.28];
const GLOW_RING_ALPHA = 0.035;
export const GLOW_POOL_SQUASH = 0.46; // the same foreshortening every round thing in this view shares
const GLOW_WASH_ALPHA = 0.1;

/**
 * A passable door's light from beyond — the open state's mirror of the hazard bloom above.
 *
 * **WHY.** Before this, "open" was defined only by SUBTRACTION: the locked state minus the red
 * pool, minus the hazard leaf. Everything with a positive signal in it was `visible = locked`, so
 * a passable door said "walk through me" by the ABSENCE of a cue — and what was left measured as
 * the darkest thing around: the arch's interior at luma 19 against a 37 floor (design/01), framed
 * by stone the same value as the wall it is cut into, sitting in the darkest band `roomLight`
 * paints (its falloff darkens toward a room's edge, and a door is always on one). A black
 * rectangle in a stone frame is what a WALL looks like. Live report, with a screenshot circling
 * one: the locked state reads well, but *"when it is passable it looks like a black wall — it is
 * hard to tell at once that this is a door you can walk through"*.
 *
 * **The cue is light, not a second saturated colour.** design/13 is "environment desaturated,
 * hazards saturated": a locked door is allowed to shout because "you cannot leave yet" is urgent,
 * a doorway is not. The passage leads to a lit room, so light comes OUT of it — one physical
 * claim, three pieces:
 *
 *   through — the passage's own floor, lit from beyond, ramped up from the threshold. Drawn
 *             BEHIND the leaf so the arch art's own stone masks it: the light shows through the
 *             transparent middle and nowhere else, with no inset constant keyed to where a
 *             particular PNG's jambs happen to sit. It is the exact inverse of `drawRecess`'s
 *             ramp, which stays — the recess is what makes the opening a hole, this is what puts
 *             a lit floor at the bottom of it.
 *   spill   — a pool on the room floor in front of the doorway (`DoorFloorPlane` says which side
 *             that is): the same nine graduated rings as
 *             `GLOW_POOL`, warm white, at two thirds the alpha. Deliberately the same SHAPE as the
 *             hazard pool so "a pool at the door" is ONE symbol the player learns once, with
 *             colour saying which state. This is also the piece that carries a KERB door, where a
 *             22 px opening leaves no room for the ramp above — 11 of the 24 shipped doors.
 *   rim     — the aperture's edge catching that light on its way out: warm bands up both jambs,
 *             brightest at the threshold, dying out going up. What stops the arch from reading as
 *             flush with the flat wall beside it. NOT across the lintel's underside: the top of
 *             the opening is where the recess is deliberately darkest, and a lit line up there
 *             would flatten the one depth cue the recess exists for.
 */
export const THROUGH_COLOR = 0xffd9a8;
const THROUGH_BANDS = 10;
/**
 * How far up the opening the floor light reaches, as a fraction of the opening's height, and its
 * alpha at the threshold — falling linearly to nothing at the top of the ramp. Banded rather than
 * one fill for the fourth time in this file's neighbourhood (`CAST_PASSES`, the nine bloom rings,
 * the mottle bands): a single alpha draws its own hard edge and reads as a painted panel.
 *
 * Both numbers were swept on a live frame of level 1's 64x92 perimeter door rather than reasoned
 * about, and the sweep is the argument for them. Reach 0.45 lit only the sill and left the fixture
 * still reading as mostly-dark; 0.75 climbed high enough to look like haze in the passage instead
 * of light on its floor; 0.60 puts the bright end on the floor and lets it die by mid-opening.
 * Alpha then set the value the floor lands at, everything else held: 0.15 → 61, 0.20 → 69,
 * 0.22 → 72, 0.26 → 78, against a room floor of 49 beside the door and 66 out in the open, and a
 * lit cap crown of 56. 0.26 made the doorway the brightest thing in the frame — brighter than the
 * crown, which design/01 calls what the eye reads a back wall by. 0.22 clears the near floor by
 * +23 and sits just above the open floor, which is the read wanted: the brightest thing in the
 * DOORWAY, not in the room. Top of the opening: 19.6 in both states, untouched.
 */
const THROUGH_REACH = 0.6;
const THROUGH_ALPHA = 0.22;
/**
 * The floor pool: `GLOW_POOL`'s rings verbatim, so the two states differ in colour and strength
 * and in nothing else.
 *
 * NOT the hazard pool's alpha, because alpha is not the comparable quantity: `GLOW_COLOR` is a
 * saturated red at luma 98 and `THROUGH_COLOR` a warm white at luma 221, so ring for ring this
 * pool lands 2.3x harder at the same number. Measured on the same door with the layer hidden and
 * shown, over the same 200x90 region the hazard pool was measured on: at 0.024 the open lights
 * moved a KERB doorway by a mean of +22.5 luma against the hazard bloom's +14.8 on the same
 * fixture, i.e. the state that is not allowed to shout was shouting 1.5x louder, and the floor
 * around it went visibly tan. 0.018 lands at +14.4 — the same magnitude as the hazard, carried by
 * warmth instead of red, with the floor keeping its own colour.
 */
const SPILL_RING_ALPHA = 0.018;
/** The lit reveal up each jamb: how far up, how wide (world px, clamped on a narrow opening), and
 *  the alpha at the threshold. `t * t` rather than `t` so it dies out fast — a rim carried at even
 *  strength up a 92 px opening outlines the doorway like a wireframe, which is the mistake the
 *  2026-08-18 wall pass made with a salmon outline on a standing block. Swept the same way as the
 *  ramp above and the weakest of the three pieces by some distance: at 0.2 it is not visible on a
 *  live frame at 6x, at 0.6 it stops being a lit edge and becomes a bright bar with its own hard
 *  side running down the flanking wall. 0.34 separates the arch from the wall next to it and does
 *  not draw a line. */
const RIM_BANDS = 6;
const RIM_REACH = 0.6;
const RIM_WIDTH = 3;
const RIM_ALPHA = 0.34;
/** The sill: one lit hairline along the opening's own floor line. Its own function so the assembly
 *  test can look for exactly this geometry among the fixture's children — the silhouette
 *  (`addBlockEdge`) also strokes along y = 0, so "is there a line at the threshold" cannot tell the
 *  two apart. Exported for tests. */
export function drawSill(g: Graphics, openingW: number): void {
  g.moveTo(0, 0).lineTo(openingW, 0).stroke({ color: 0xffffff, width: 1, alpha: SILL_ALPHA });
}

/**
 * The tunnel behind the leaf: bands darkening upward over the opening, from `alphaFloor` at the
 * threshold to `alphaTop` at the lintel. Defaults are the LOCKED pair; the open state calls this
 * with the far lighter `OPEN_RECESS_ALPHA_*` pair instead, over the floor tile rather than more
 * wall stone (`buildOpenFloorTile`) — same shape, so the two states share one ramp function and
 * differ only in what they darken and by how much. Exported for tests.
 */
export function drawRecess(
  g: Graphics,
  openingW: number,
  openingH: number,
  alphaTop: number = RECESS_ALPHA_TOP,
  alphaFloor: number = RECESS_ALPHA_FLOOR,
): void {
  if (openingH <= 0) return;
  const bandH = openingH / RECESS_BANDS;
  for (let i = 0; i < RECESS_BANDS; i++) {
    // t: 1 at the top of the opening (deepest), → 0 at the floor.
    const t = 1 - (i + 0.5) / RECESS_BANDS;
    const alpha = alphaFloor + (alphaTop - alphaFloor) * t;
    g.rect(0, -openingH + i * bandH, openingW, bandH).fill({ color: RECESS_COLOR, alpha });
  }
}

/** The open recess's own darkening ramp — `drawRecess` at the far lighter `OPEN_RECESS_ALPHA_*`
 *  pair, over the floor tile rather than more wall stone. Its own function, same pattern as every
 *  other composited layer in this file (`drawGlow`/`drawThroughLight`/`drawSpill`), so a test can
 *  match it by digest rather than re-deriving the constants. Exported for tests. */
export function drawOpenRecessShade(g: Graphics, openingW: number, openingH: number): void {
  drawRecess(g, openingW, openingH, OPEN_RECESS_ALPHA_TOP, OPEN_RECESS_ALPHA_FLOOR);
}

/**
 * The open state's own floor: the room's floor swatch tiled across the opening, bottom-anchored at
 * the threshold. No swatch loaded falls back to `OPEN_RECESS_FALLBACK_COLOR`, the same
 * optional-swatch contract as every other field on `DoorSkin`. A zero-height opening (the
 * `drawRecess` guard's own case) returns an empty, harmless Graphics rather than a degenerate
 * zero-size `TilingSprite`.
 */
export function buildOpenFloorTile(
  openingW: number,
  openingH: number,
  floorTex: Texture | undefined,
): TilingSprite | Graphics {
  if (openingH <= 0) return new Graphics();
  if (floorTex) {
    const tile = new TilingSprite({ texture: floorTex, width: openingW, height: openingH });
    tile.position.set(0, -openingH);
    return tile;
  }
  const g = new Graphics();
  g.rect(0, -openingH, openingW, openingH).fill({ color: OPEN_RECESS_FALLBACK_COLOR });
  return g;
}

/**
 * Where a door's floor-level decals lie, and which part of them is on real floor.
 *
 * **WHY THIS EXISTS (2026-09-03d).** Every floor-level layer this file and `doorFx.ts` draw — both
 * states' pools, the travelling pulse ring, the lock-change burst — was drawn from the threshold
 * SOUTHWARD, on the assumption that what lies in front of a doorway is room floor. True for a door
 * in an east-west wall; false for one in a north-south wall, where the ground south of the
 * fixture's own base line is **the same wall continuing** — `wallRuns.bordersDoorNorth`'s case,
 * which `doorSpillCoverage.test.ts` already measured 12 times across the five shipped floors for a
 * different symptom of it (that run's cap swallowing the door's ART).
 *
 * Measured over all 24 shipped doors (`doorFloorPlaneCoverage.test.ts` re-measures it, and is the
 * test that would have caught this): the 13 whose passage is 64x128 each have runs standing on
 * their south edge, 32-320 px deep, covering all 64 px of the fixture's width — and `blockCapTop`'s
 * `doorClip` puts that run's cap top EXACTLY on the door's threshold. The pool reaches 39.7 px
 * south (`GLOW_POOL[0] * GLOW_POOL_SQUASH * 64`) and the pulse 38.3 px, so **100% of both landed
 * inside that cap**, which Y-sorts after the door (`Entity.zIndex` is the ground y, and the run's
 * is its own south edge) and painted over them. On a live frame that read as a ring with its middle
 * bitten out, which is how it was reported — two arcs flanking the doorway and nothing between.
 *
 * The unifying rule, and why this is one plane rather than an orientation branch per layer: **a
 * floor decal lies on the floor the fixture's own stone is not standing on.** For an east-west wall
 * that is the strip south of the threshold — today's shape, unchanged, and what every swept number
 * in this file was measured on. For a north-south wall it is the floor EAST and WEST of the wall,
 * beside the arch the player walks through. Travel is along the passage's SHORT axis (it is a hole
 * in a wall), the same discriminator `floorRender.drawDoorWear` uses for the worn patch across a
 * doorway, so the two floor-level door decals now agree about which way a door faces.
 *
 * **Where along that floor, and how big (2026-09-04).** Both answers come from the DRAWN opening —
 * `openingW` x `drawH` — and not from the passage AABB, because the passage is not what the player
 * sees. Live report on the first version, with a screenshot circling a `sides` door's ring:
 * *"位置有点偏上了...而且有的门大，有的小，最好那个圈能跟随门的大小进行缩放"* (a bit too high; and
 * doors come in different sizes, so the ring should scale with the door).
 *
 *   centre — a `sides` ring sat at `-r.h / 2`, half the PASSAGE's 128 px depth up-screen, while the
 *            arch standing on that threshold is `leafDrawH` = 94.5 px tall (`RoomBuilder` builds
 *            every door at `DOOR_H`, and 217 rows of leaf art fitted to a 64 px opening want 94.5
 *            of height). So the ring floated 16.8 px above the middle of the fixture the eye reads
 *            as the door, on all 13 of them. It is now the drawn opening's own mid-height, clamped
 *            into the passage. `south` is untouched: there the drawn opening meets its floor at
 *            the threshold, which is already where its ring is centred.
 *   size   — every radius was a multiple of `openingW` alone, which is proportional to the door
 *            and still much too big to read as part of one: 2.7 door widths across. `doorSpan`
 *            below is the multiple instead — a fraction of the drawn opening's own size.
 */
export interface DoorFloorPlane {
  /** Local x of the decals' centre — the middle of the drawn opening either way. */
  readonly cx: number;
  /** Local y of that centre: 0 (the threshold) for `south`, half the DRAWN opening's height
   *  up-screen (i.e. the middle of the arch the player sees) for `sides`. */
  readonly cy: number;
  /** Which part of a ring centred there is on floor. `south` — the fixture's stone stands north of
   *  the centre, so the southern half is drawn. `sides` — the wall runs north-south THROUGH the
   *  centre, so the two side lobes are drawn and `cx` doubles as the half-thickness they clear. */
  readonly floor: 'south' | 'sides';
  /** The radius unit: every floor ring this door draws — the nine pool fills, `doorFx`'s travelling
   *  pulse, its lock-change burst — is a multiple of this. See `doorSpan`. */
  readonly span: number;
}

/**
 * How far the widest of a door's floor rings reaches: a fraction of the drawn opening's own size.
 *
 * **The fraction (2026-09-04).** Every ring used to be a multiple of `openingW` itself, so the
 * widest pool ring was 1.35 x the opening's width in RADIUS — an ellipse 2.7 door-widths across,
 * and the travelling pulse 2.6. That is proportional to the door (a 64 px arch and a 128 px one
 * get the same multiple), which is why the live report guessed the ring was a fixed size unrelated
 * to the fixture: *"有的门大，有的小，最好那个圈能跟随门的大小进行缩放"*. What was wrong was not the
 * proportion but the reach — at 2.6 widths the ring is out in the middle of the room, too far from
 * its own doorway for the eye to attach the two. 0.55 puts the widest pool ring about 1.5 door
 * widths across and the pulse about 1.4, chosen by the reporter from that range.
 *
 * The ALPHAS above are untouched and their swept luma figures still hold where they were measured —
 * the pool is the same nine rings at the same alpha each, so its peak (all nine overlapping, at the
 * doorway) is unchanged; what shrank is how far the outermost ones spread.
 *
 * **The size it is a fraction OF.** `openingW` is right for a door whose leaf is taller than the
 * opening is wide — light out of a tall slot pools about as wide as the slot — and wrong for one
 * cropped SHORTER than it is wide, which is what `doorLeafFrame` does to all 11 of the shipped
 * 128 px doorways (217 rows of leaf art fitted to a 128 px width want 189 px of height and get the
 * wall's own 104). Those doors are 23% shorter than they are wide and were wearing the halo of a
 * square one. The geometric mean of the drawn box says so; the `min` clamps it back to the width,
 * so a door that is TALLER than it is wide is sized by the opening the light comes through rather
 * than by how much wall happens to stand above it.
 */
const RING_REACH = 0.55;

export function doorSpan(openingW: number, drawH: number): number {
  const w = Math.max(0, openingW);
  return RING_REACH * Math.min(w, Math.sqrt(w * Math.max(0, drawH)));
}

/**
 * The radius of a TRAVELLING ring (`doorFx`'s pulse and its lock-change burst) partway through its
 * outward journey — `from` and `to` are the multiples of `span` it grows between, `t` runs 0..1.
 *
 * The start is pushed out to the wall's own half-thickness on a `sides` plane, because a ring
 * narrower than that draws literally nothing (`floorArcSpans`) — the wall is standing on it. At the
 * pre-2026-09-04 reach the buried part was under half the travel and the ring still had most of its
 * journey left when it cleared the stone; at 0.55 of a 64 px arch the whole sweep would finish
 * inside the wall and the pulse would vanish on the 13 doors cut through a north-south one. Starting
 * at the face keeps what that clamp is for — a ring that EMERGES from the doorway rather than
 * appearing over it — and spends the travel on floor the player can see.
 */
export function ringTravel(plane: DoorFloorPlane, from: number, to: number, t: number): number {
  const start = Math.max(plane.span * from, plane.floor === 'sides' ? plane.cx : 0);
  const end = Math.max(plane.span * to, start);
  return start + (end - start) * t;
}

/** The plane for one passage AABB and the height its leaf actually draws at (`doorLeaf.leafHeight`).
 *  `w <= h` is `floorRender.drawDoorWear`'s own test for a passage crossed along x (a hole in a
 *  north-south wall); the shipped rects are 64x128 or 128x64 and never square, so the tie-break only
 *  decides a shape no shipped floor has. The `sides` centre is clamped into the passage's own depth,
 *  so an arch taller than the hole it stands in cannot push its floor decals out the far side. */
export function doorFloorPlane(r: RectPx, drawH: number): DoorFloorPlane {
  const span = doorSpan(r.w, drawH);
  return r.w <= r.h
    ? { cx: r.w / 2, cy: -Math.min(Math.max(0, drawH), r.h) / 2, floor: 'sides', span }
    : { cx: r.w / 2, cy: 0, floor: 'south', span };
}

/** The threshold plane for a bare opening width: what every call site with no passage rect to hand
 *  (the unit tests, a `DoorFx` built without one) drew before the plane existed. `drawH` defaults to
 *  the width, i.e. to `span === openingW`, so such a call site keeps the pre-span radii exactly. */
export function thresholdPlane(openingW: number, drawH: number = openingW): DoorFloorPlane {
  return { cx: openingW / 2, cy: 0, floor: 'south', span: doorSpan(openingW, drawH) };
}

/** How many segments one arc span is drawn from — 20 for the `south` span, so that plane samples
 *  the exact 21 points the pre-plane ellipse did. */
const ARC_SEGS = 20;

/**
 * A floor ring, stroked, centred on `plane` and drawn only where the fixture's own stone is not
 * standing on it.
 *
 * A full `g.ellipse(cx, 0, ...)` is what the pulse and the burst were first drawn as, and it put
 * their northern halves straight up the door's own stone — a 2 px stroke at 0.3 alpha crossing the
 * hazard leaf and the flanking wall, which on a live frame read as a stray red line through the
 * masonry rather than as a ring on the floor. `GLOW_POOL` gets away with a full ellipse because it
 * is nine FILLS at 0.035; a stroke has nowhere to hide.
 *
 * Segments rather than an arc call: Pixi's `arc` is circular, and the foreshortening
 * (`GLOW_POOL_SQUASH`, the same every round thing in this view shares) is what makes a ring lie on
 * the ground instead of standing up in the air. One `stroke()` over however many subpaths the plane
 * leaves — two for `sides`, and NONE while a `sides` ring is still narrower than the wall's own
 * thickness, which is what makes that pulse emerge from the doorway instead of over it.
 *
 * Lives here rather than in `doorFx.ts` (where the pulse and the burst are) because the plane is
 * this file's and the pool fills below share it.
 */
export function strokeFloorArc(
  g: Graphics,
  plane: DoorFloorPlane,
  rx: number,
  color: number,
  width: number,
  alpha: number,
): void {
  const spans = floorArcSpans(plane, rx);
  if (spans.length === 0) return;
  const ry = rx * GLOW_POOL_SQUASH;
  for (const [from, to] of spans) {
    for (let i = 0; i <= ARC_SEGS; i++) {
      const th = from + ((to - from) * i) / ARC_SEGS;
      const x = plane.cx + Math.cos(th) * rx;
      const y = plane.cy + Math.sin(th) * ry;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
  }
  g.stroke({ color, width, alpha });
}

/**
 * The angular spans of that ring which lie on floor.
 *
 * `south` is the half from 0 to pi — screen y grows downward, so that is the southern one, and it
 * is the pre-plane behaviour unchanged. `sides` is the two spans clear of the wall's own thickness:
 * `|cos th| * rx >= cx`, i.e. within `acos(cx / rx)` of 0 (east) and of pi (west), and nothing at
 * all while `rx <= cx`. Exported for tests, which is cheaper than reading spans back out of a
 * Graphics's path to ask "did this ring know where the floor was".
 */
export function floorArcSpans(plane: DoorFloorPlane, rx: number): readonly (readonly [number, number])[] {
  if (plane.floor === 'south') return [[0, Math.PI]];
  if (rx <= plane.cx) return [];
  const a = Math.acos(plane.cx / rx);
  return [
    [-a, a],
    [Math.PI - a, Math.PI + a],
  ];
}

/** The graduated pool both states share: `GLOW_POOL`'s rings, centred on the plane. Unlike the
 *  stroked ring above these are NOT cut back to the floor — nine fills at 0.035 spreading over the
 *  fixture's own stone read as bloom coming off the doorway, the same latitude the pre-plane
 *  version already took over the leaf (and `drawGlow` adds an explicit wash there anyway). */
function fillFloorPool(g: Graphics, plane: DoorFloorPlane, color: number, alpha: number): void {
  for (const ratio of GLOW_POOL) {
    const rx = plane.span * ratio;
    g.ellipse(plane.cx, plane.cy, rx, rx * GLOW_POOL_SQUASH).fill({ color, alpha });
  }
}

/** A locked door's bloom: a graduated pool on the floor around the doorway plus a wash over the
 *  leaf. Exported for tests. */
export function drawGlow(
  g: Graphics,
  openingW: number,
  openingH: number,
  plane: DoorFloorPlane = thresholdPlane(openingW),
): void {
  fillFloorPool(g, plane, GLOW_COLOR, GLOW_RING_ALPHA);
  g.rect(0, -openingH, openingW, openingH).fill({ color: GLOW_COLOR, alpha: GLOW_WASH_ALPHA });
}

/**
 * An open door's light from the room beyond: bands brightening DOWNWARD to the threshold, over
 * the bottom `THROUGH_REACH` of the opening. The mirror image of `drawRecess`'s ramp, and drawn
 * on top of it — the recess makes the opening a hole, this puts a lit floor at the bottom of it.
 *
 * Belongs behind the leaf: the arch elevation is opaque stone with a transparent middle, so
 * letting it mask this layer confines the light to the opening for free. Exported for tests.
 */
export function drawThroughLight(g: Graphics, openingW: number, openingH: number): void {
  if (openingH <= 0) return;
  const bandH = (openingH * THROUGH_REACH) / THROUGH_BANDS;
  for (let i = 0; i < THROUGH_BANDS; i++) {
    // t: 1 at the threshold (brightest), → 0 at the top of the ramp.
    const t = 1 - (i + 0.5) / THROUGH_BANDS;
    g.rect(0, -(i + 1) * bandH, openingW, bandH).fill({ color: THROUGH_COLOR, alpha: t * THROUGH_ALPHA });
  }
}

/**
 * An open door's spill: the floor pool south of the threshold, plus the lit reveal up each jamb.
 *
 * The pool is `drawGlow`'s rings verbatim in warm white — one shape for both states, colour
 * carrying which — and it is what a kerb door's 22 px opening has instead of the ramp above.
 * The rim is what separates the arch from the flat wall next to it. Exported for tests.
 */
export function drawSpill(
  g: Graphics,
  openingW: number,
  openingH: number,
  plane: DoorFloorPlane = thresholdPlane(openingW),
): void {
  fillFloorPool(g, plane, THROUGH_COLOR, SPILL_RING_ALPHA);
  if (openingH <= 0) return;
  const bandH = (openingH * RIM_REACH) / RIM_BANDS;
  const w = Math.min(RIM_WIDTH, openingW / 2);
  for (let i = 0; i < RIM_BANDS; i++) {
    const t = 1 - (i + 0.5) / RIM_BANDS;
    const alpha = t * t * RIM_ALPHA;
    const y = -(i + 1) * bandH;
    g.rect(0, y, w, bandH).fill({ color: THROUGH_COLOR, alpha });
    g.rect(openingW - w, y, w, bandH).fill({ color: THROUGH_COLOR, alpha });
  }
}
