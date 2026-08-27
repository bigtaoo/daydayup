// Which standing block is currently hiding the character, and how fast it gets out of the way
// (design/01 "Limits of fake 3D" — the occlusion x-ray). Split out of RoomBuilder rather than
// folded into it: the rule is pure geometry plus a fade integrator, and keeping it Pixi-free
// (the caller injects the `apply` callback that puts a fade on screen) is what makes it
// testable without a canvas. Sibling of `wallRender.ts`/`pillarRender.ts`, imports neither.

/**
 * Where one standing block's art sits, in world px, reduced to the four numbers the occlusion
 * test needs.
 *
 * - `left`/`right` — the world x span the art paints.
 * - `top` — the NORTHERNMOST world row it paints. Everything in this view is drawn upward from
 *   a grounded origin (`screen.y = gy - z`), so for a wall block this is
 *   `sortY - height - capDepth` and for a pillar `gy - height - capRy`: the art always
 *   intrudes one full height north of the footprint that owns it.
 * - `sortY` — the block's own `zIndex`, i.e. the ground line it Y-sorts on (a wall's south
 *   edge, a pillar's centre). Anything with a SMALLER `gy` draws before it, and is therefore
 *   drawn over by it.
 * - `foldY` — the row from which this block's art stays OPAQUE while only its cap is fading: a
 *   wall's cap/face fold (`sortY - height`), since the x-ray moves the cap and leaves the front
 *   face standing. A pillar has no such row — it fades whole — and reports `sortY`, which makes
 *   its opaque band empty. See `needsDeepFade`.
 */
export interface Occluder {
  left: number;
  right: number;
  top: number;
  sortY: number;
  foldY: number;
}

/** Ground point and DRAWN body size of the character the x-ray is protecting. Drawn, not
 *  collision: the question is whether stone lands on pixels of the character, which is a
 *  question about the silhouette (`Skin.bodyDrawnR` / the skin's own rest bounds). `halfW`
 *  deliberately excludes the weapon — a gun tip clipped by a block's corner is not worth
 *  x-raying a whole wall for. */
export interface OcclusionFocus {
  x: number;
  y: number;
  halfW: number;
  bodyH: number;
}

/**
 * How much of the body's height a block has to cover before it is worth x-raying, as a fraction
 * of that height measured up from the feet.
 *
 * Not zero, and this is not a tolerance — it is what keeps the x-ray off the room's SOUTH kerb
 * (`wallGeometry.WALL_H_KERB`, 22 px). The player's own wall clearance keeps their ground point
 * 16 px north of a kerb's footprint, so a kerb's cap reaches all of 6 px above their feet: the
 * character was never hidden, and fading the whole southern lip of the room every time the
 * player walks along it would be a bigger artifact than the 6 px it fixes. At 0.45 anything that
 * swallows the legs still triggers, and anything that clips the soles does not.
 */
const MIN_COVER_FRACTION = 0.45;

/**
 * Does this block draw over enough of the character to hide them?
 *
 * Four independent rejections, and the middle two are the whole reason this is not simply "is
 * the character north of the wall":
 *
 * 1. `y >= sortY` — the character stands on or south of the block's own ground line, so the
 *    Y-sort already puts them in front. Nothing to do.
 * 2. The block's art does not reach far enough above their feet. A body is drawn UPWARD from
 *    its ground point, never below it, so `y - top` is exactly how much of it the block covers
 *    — negative when the character stands north of everything the block paints (the block is
 *    in front of them in the sort, but its art is entirely below their feet).
 * 3. Less than `MIN_COVER_FRACTION` of the body is covered.
 * 4. No x overlap between the drawn body and the art.
 */
export function occludes(o: Occluder, f: OcclusionFocus): boolean {
  if (f.y >= o.sortY) return false;
  if (f.y - o.top < f.bodyH * MIN_COVER_FRACTION) return false;
  return f.x + f.halfW > o.left && f.x - f.halfW < o.right;
}

/**
 * Would fading this block's CAP leave the character buried anyway?
 *
 * True when the block's front FACE — the part a cap fade does not touch — is itself covering as
 * much of the body as it takes to trigger the x-ray in the first place. Reusing
 * `MIN_COVER_FRACTION` here rather than inventing a second number is deliberate: the question is
 * the same one ("is this much of the character behind stone worth acting on"), asked about the
 * surface that is left after the first pass.
 *
 * It takes a tall wall over a shallow footprint to get here. A 70 px interior block over a 64 px
 * footprint cannot — the engine's clearance keeps the body's feet 10 px above the fold, so the
 * face covers none of it and the cap is the whole story. A 104 px room boundary over a 32 px one
 * can, and that is where the sweep in `occlusionCoverage.test.ts` found what a cap-only fade left
 * behind: 75% of the body still buried where a kerb stands in front of the boundary, and 100%
 * where nothing does. Both are the total-invisibility failure this pass exists to remove.
 *
 * The cost is real and is why this is a fallback rather than the default: dropping the face
 * reveals whatever is BEHIND the wall, which at a room boundary is the next wall's own bright cap
 * showing through as a pale band. Measured against the alternative on a live frame, a visible
 * character behind a hazy wall beats a wall in front of an invisible one — but only where the cap
 * fade genuinely cannot do the job, which is 1.4% of the shipped floor.
 */
export function needsDeepFade(o: Occluder, f: OcclusionFocus): boolean {
  return f.y - o.foldY >= f.bodyH * MIN_COVER_FRACTION;
}

/**
 * How far BELOW the cap/face fold the deep pass can ever need to reach, in px, for a block whose
 * art is `height` tall over a footprint `footprintDepth` deep.
 *
 * This is the number that keeps the deep pass from reading as a pane of glass. `needsDeepFade`
 * says *whether* a block's front face has to go translucent; it says nothing about *how much of
 * it*, and dropping the whole face was measured on a live frame to remove the block's base, its
 * plinth and its contact with the floor — none of which was ever covering the character. On the
 * shipped arena's deep blocks (70 px of art over a 32 px footprint) the rows a body can actually
 * occupy are the top 38 px: 46% of the face was going translucent for no one.
 *
 * The bound is geometric rather than tuned. A focus is a character standing NORTH of the block —
 * it cannot overlap the footprint, so its ground point is at most `r.y` (= `sortY - footprintDepth`)
 * and its own wall clearance only ever pushes it further north — and a body is drawn UPWARD from
 * its ground point, never below it. So the lowest face row any body can reach is
 * `sortY - footprintDepth`, i.e. `height - footprintDepth` px below the fold at `sortY - height`.
 * `occlusionCoverage`/`arenaWallCoverage` assert that on every swept sample the deep pass fires
 * for, which is what makes this a fact about the projection instead of a margin someone picked.
 *
 * Clamped at 0 rather than allowed negative: a kerb is 22 px of art over a 32 px footprint, so its
 * face is entirely below every reachable body and the deep pass can never touch it at all — which
 * is the same thing `needsDeepFade` already refuses to do there, said in geometry.
 */
export function deepFadeReach(height: number, footprintDepth: number): number {
  return Math.max(0, height - footprintDepth);
}

/**
 * How much of its own opacity a block keeps while it is hiding the character.
 *
 * Not zero, and not a hidden block: the point of the last several rendering passes was to make
 * a wall read as a solid stone mass, and a block that vanishes outright would trade this bug
 * for a hole in the room. At this value the character reads clearly through the stone (a
 * near-white rig body over ~50-luma stone composites to ~130) while the block's cast shadow,
 * its front face and its full-strength silhouette all stay on screen — see `xrayLayers` for
 * why only the cap moves at all.
 */
export const XRAY_FADE = 0.34;

/** ms to fade out of the way, and (slower, so a block the player is walking along doesn't
 *  strobe) back to solid. Both are the time for the FULL `1 → XRAY_FADE` range. */
const FADE_OUT_MS = 90;
const FADE_IN_MS = 220;

/** One integration step of the fade toward whichever end `occluding` asks for. Clamps onto the
 *  target rather than overshooting, which also makes a long frame (a stall, a hit-stop) settle
 *  instead of oscillating. */
export function stepFade(current: number, occluding: boolean, dtMs: number): number {
  const target = occluding ? XRAY_FADE : 1;
  const span = 1 - XRAY_FADE;
  const step = (Math.max(0, dtMs) / (occluding ? FADE_OUT_MS : FADE_IN_MS)) * span;
  const delta = target - current;
  if (Math.abs(delta) <= step) return target;
  return current + Math.sign(delta) * step;
}

/** One set of layers that fade together, and the callback that puts their fade on screen. */
export interface FadeGroup {
  /** 1 = fully solid, `XRAY_FADE` = fully seen-through. Owned by `updateOcclusion`. */
  fade: number;
  apply(fade: number): void;
}

/** A standing block and its two fade groups: the CAP, which moves whenever the block is hiding
 *  the character, and the REST of its art, which moves only when the cap alone cannot help
 *  (`needsDeepFade`). The silhouette is in neither and never fades. */
export interface FadeableOccluder {
  readonly box: Occluder;
  readonly cap: FadeGroup;
  readonly deep: FadeGroup;
}

/**
 * Advance every block's fade one render frame. `foci` is every character that must stay visible
 * — the local player AND every live enemy (live report *"如果只有怪物在墙下面的话，就看不到怪物了"*:
 * a block used to be judged against the local player alone, so a monster standing in the exact
 * band the player was fixed out of in `c8fd4fa` got no x-ray at all). Empty between spawns / on a
 * menu, which fades everything back to solid.
 *
 * A block hides if it hides ANY focus, and takes the deep fade if it needs one for any focus that
 * is hiding — both an OR across the list, not "the first focus decides for everyone".
 *
 * `apply` is called only on a frame where the value actually moved — a room has a couple of
 * dozen blocks and all but one of them are at rest on any given frame.
 */
export function updateOcclusion(
  occluders: readonly FadeableOccluder[],
  foci: readonly OcclusionFocus[],
  dtMs: number,
): void {
  for (const o of occluders) {
    let hiding = false;
    let deep = false;
    for (const f of foci) {
      if (!occludes(o.box, f)) continue;
      hiding = true;
      if (needsDeepFade(o.box, f)) {
        deep = true;
        break; // nothing stronger than "deep" to find from another focus
      }
    }
    stepGroup(o.cap, hiding, dtMs);
    stepGroup(o.deep, deep, dtMs);
  }
}

function stepGroup(g: FadeGroup, occluding: boolean, dtMs: number): void {
  const next = stepFade(g.fade, occluding, dtMs);
  if (next === g.fade) return;
  g.fade = next;
  g.apply(next);
}

/** Marks a standing block's CAP layers — the ones the x-ray fades whenever the block is hiding
 *  the character. Set by `wallRender.buildWallBlock`, read back by `xrayLayers`. */
export const XRAY_LABEL = 'xray';

/** Marks the layers that fade only in the `needsDeepFade` case: a wall's front face and the
 *  shading over it. Never the silhouette, which stays at full strength in both cases. */
export const XRAY_DEEP_LABEL = 'xray-deep';

/** The subset of a Pixi `Container` this module touches — a hand-narrowed interface (CLAUDE.md
 *  form ②) so the fade can be tested against plain objects. */
export interface FadeLayer {
  alpha: number;
  label: string | null;
}

/**
 * The layers of a built block that are allowed to go translucent, i.e. the ones tagged
 * `XRAY_LABEL`.
 *
 * A wall block fades its CAP ONLY, and that is the whole difference between an x-ray that still
 * looks like architecture and one that punches a hole in the room. The cap is the surface that
 * covers the character (the art reaches `height` px north of the footprint, and the player's own
 * clearance keeps them well inside that band, so what is drawn over them is the raised top
 * surface, never the front face). Leaving the face, the shading and the silhouette at full
 * strength keeps a solid brick elevation and a hard outline under a top that has gone to glass —
 * measured against a live frame with the whole block faded, which loses the stone entirely.
 *
 * A pillar is the exception and deliberately passes its body straight in (no labels): its art
 * is a 70 px SHAFT rising from its own ground point, and the shaft — not the little cap ellipse
 * on top of it — is what a character standing behind it disappears into.
 */
export function xrayLayers<T extends FadeLayer>(layers: readonly T[]): T[] {
  return layers.filter((l) => l.label === XRAY_LABEL);
}

/** The layers that fade only when the cap alone cannot help — see `needsDeepFade`. */
export function deepXrayLayers<T extends FadeLayer>(layers: readonly T[]): T[] {
  return layers.filter((l) => l.label === XRAY_DEEP_LABEL);
}

/**
 * Bind an `Occluder` to the layers whose opacity tracks it.
 *
 * Each layer's authored alpha is captured once here (a cap's additive key light carries its own),
 * so the fade scales them rather than flattening them all to one value.
 */
export function fadeableBlock(
  box: Occluder,
  capLayers: readonly FadeLayer[],
  deepLayers: readonly FadeLayer[] = [],
): FadeableOccluder {
  return { box, cap: fadeGroup(capLayers), deep: fadeGroup(deepLayers) };
}

function fadeGroup(layers: readonly FadeLayer[]): FadeGroup {
  const dimmed = layers.map((view) => ({ view, base: view.alpha }));
  return {
    fade: 1,
    apply(fade: number): void {
      for (const l of dimmed) l.view.alpha = l.base * fade;
    },
  };
}
