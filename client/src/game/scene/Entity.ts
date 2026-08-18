import { Container, Graphics } from 'pixi.js';
import { THEME } from '../theme';

/** Nested-ellipse ground shadow (see `makeShadow`): `SHADOW_RINGS` ellipses stepping evenly
 *  from `SHADOW_R_OUTER` down to `SHADOW_R_INNER` times the body radius, each at the SAME low
 *  alpha. Because they composite, the total darkness ramps smoothly from ~`SHADOW_RING_ALPHA`
 *  at the outer edge to ~1-(1-a)^n at the core.
 *
 *  Count raised from 4 and the per-ring alpha cut on 2026-08-18 after looking at a 7x live
 *  render: four rings at 0.08/0.12/0.16/0.22 left four VISIBLE concentric edges under the
 *  character, which reads as a ripple or a targeting reticle rather than as a penumbra. Many
 *  faint rings is the same trick at a step size small enough to disappear. */
const SHADOW_RINGS = 9;
const SHADOW_R_OUTER = 1.45;
const SHADOW_R_INNER = 0.4;
const SHADOW_RING_ALPHA = 0.075;

/** Vertical foreshortening of everything round that lies on the ground plane or wraps a
 *  body in this tilted view (design/01). Shared with `EnergyShieldFilter`'s SHIELD_SQUASH
 *  and `Actor.setStatus`'s auras so they cannot drift apart. */
export const SHADOW_SQUASH = 0.62;

/** How much a shadow slides away from the key light per world px of height. The key light
 *  is fixed "upper-left" (`NormalLitFilter`'s KEY_DIR, `RoomBuilder`'s pillar banding), so
 *  shadows fall to the lower RIGHT — and further in x than in y, because the view is
 *  tilted. Same two numbers `scene/wallRender.ts` casts a wall's shadow with. */
export const SHADOW_SLANT_X = 0.42;
export const SHADOW_SLANT_Y = 0.22;

/** How fast a shadow shrinks/fades with height. Raised from 0.012 (2026-08-18): that value
 *  was tuned for a bullet's tens-of-px `z` and left the 4-7 px of an actor's hover at
 *  k = 0.95, i.e. invisible — which is the whole cue the hover exists to produce. Kept
 *  moderate rather than doubled again because the height-driven OFFSET above now carries
 *  most of that information; this only has to keep the two consistent. */
const SHADOW_LIFT_FALLOFF = 0.022;

// Base view for all world objects. Stage D: this is a PURE view — it owns no
// gameplay state and decides no outcomes. The engine is authoritative; the render
// layer only reads engine state and draws it (design/06/08).
//
// Motion is double-buffered for interpolation: the sim advances at a fixed 30 Hz,
// but the screen redraws at display rate (~60 fps). Each sim tick the Scene pushes
// a fresh position (cur → prev, then cur = new); each render frame lerps between
// prev and cur by `alpha` so movement reads smooth despite the slower sim. Ground
// coords are world px; screen.y = y - z (height); zIndex = y for the Y-sort. Angles
// are NOT interpolated (design decision: take the current facing, no wrap wobble).
export class Entity extends Container {
  // Interpolation buffers (world px).
  prevX = 0;
  prevY = 0;
  prevZ = 0;
  curX = 0;
  curY = 0;
  curZ = 0;
  facingRad = 0; // aim/shot direction (weapon)
  bodyFacingRad = 0; // movement direction (body/legs) — see Actor's upper/lower split

  /**
   * Explicit idle/move cue for a caller whose own tick ALSO collapses prev onto cur
   * (`Scene.positionLocal`'s predicted-pose snap, ROADMAP 3.3) — `Actor.interpolate`'s
   * default heuristic (curX/prevX delta) reads as permanently stationary once prev==cur,
   * which is exactly what that snap does every render frame. `null` (the default, reset
   * on every `pushState()`) means "derive it from the buffer delta as usual" — the
   * correct signal for every entity driven the normal way (`Scene.reconcile`, never
   * snapped mid-motion).
   */
  movingOverride: boolean | null = null;

  shadow: Graphics | null = null;

  /**
   * Extra render-only height, added on top of the sim's `z` for BOTH the screen transform
   * and the shadow (2026-08-18 depth pass). This is where a hovering body's idle rise
   * lives: `z` itself comes from the engine and is 0 for every actor (design/01 "Actors
   * stay grounded... `z` never gates gameplay"), so a hover expressed through the rig's
   * own animation clip alone moved the ART but left the shadow pinned at full size —
   * the one cue that says "this thing is off the floor". Never read by the sim; `zIndex`
   * still comes from the ground coordinate alone, so lifting cannot reorder anything.
   */
  protected visualZ = 0;

  /**
   * Fixed world-px offset for this entity's shadow, on top of the height-driven one below.
   * For a STATIC tall object (a pillar) the height that displaces its shadow is the drawn
   * body's, not `z` — which is 0, because the body is drawn upward from a grounded origin
   * rather than lifted by the transform. `RoomBuilder` sets this so a pillar's shadow falls
   * away from the key light exactly as far as a same-height wall's cast shadow does.
   */
  shadowOffsetX = 0;
  shadowOffsetY = 0;

  // Create an elliptical soft shadow, added to the shadow layer by the caller.
  //
  // Nested ellipses rather than one flat fill (2026-08-18 depth pass, user report
  // "希望能再强化一下立体效果"): a single uniform ellipse at alpha 0.35 reads as a die-cut disc
  // lying under the character, which is the opposite of the intended cue. Stacking many faint
  // rings from wide to small approximates a penumbra — the contact point reads dark and
  // definite while the outer edge falls off — using nothing but Graphics (a real blur would
  // mean a filter per actor, and a busy room has 30 of them). 0.62 vertical squash is this
  // project's one foreshortening constant, shared with the shield ring and the status auras.
  makeShadow(radius: number): Graphics {
    const s = new Graphics();
    for (let i = 0; i < SHADOW_RINGS; i++) {
      const t = i / (SHADOW_RINGS - 1);
      const scale = SHADOW_R_OUTER + (SHADOW_R_INNER - SHADOW_R_OUTER) * t;
      s.ellipse(0, 0, radius * scale, radius * scale * SHADOW_SQUASH).fill({
        color: THEME.colors.shadow,
        alpha: SHADOW_RING_ALPHA,
      });
    }
    this.shadow = s;
    return s;
  }

  // One-shot static placement (pillars): no interpolation, drawn where it stands.
  place(x: number, y: number, z = 0): void {
    this.prevX = this.curX = x;
    this.prevY = this.curY = y;
    this.prevZ = this.curZ = z;
    this.applyTransform(x, y, z);
  }

  // Ingest one sim-tick position: shift cur → prev, then set the new cur. `bodyFacingRad`
  // defaults to `facingRad` for entities with no separate body orientation (enemies,
  // bullets, pickups) — only the player view (Scene.ts) ever passes a distinct one.
  pushState(x: number, y: number, z: number, facingRad: number, bodyFacingRad: number = facingRad): void {
    this.prevX = this.curX;
    this.prevY = this.curY;
    this.prevZ = this.curZ;
    this.curX = x;
    this.curY = y;
    this.curZ = z;
    this.facingRad = facingRad;
    this.bodyFacingRad = bodyFacingRad;
    this.movingOverride = null; // back to the default buffer-delta heuristic until told otherwise
  }

  // Collapse prev onto cur — call right after a view is created so it appears at
  // its spawn position instead of lerping in from (0,0).
  snap(): void {
    this.prevX = this.curX;
    this.prevY = this.curY;
    this.prevZ = this.curZ;
  }

  // Interpolated ground position (world px), for the camera to follow smoothly.
  interpGroundX(alpha: number): number {
    return this.prevX + (this.curX - this.prevX) * alpha;
  }
  interpGroundY(alpha: number): number {
    return this.prevY + (this.curY - this.prevY) * alpha;
  }

  // Render-frame interpolation. alpha ∈ [0,1) is the fraction into the current tick.
  interpolate(alpha: number, _frameDt: number): void {
    this.applyTransform(
      this.prevX + (this.curX - this.prevX) * alpha,
      this.prevY + (this.curY - this.prevY) * alpha,
      this.prevZ + (this.curZ - this.prevZ) * alpha,
    );
  }

  // Write the Pixi transform + shadow from an interpolated ground position + height.
  // `visualZ` (the render-only hover) is folded in here rather than at every call site, so
  // `place()` and `interpolate()` and any future caller all get it.
  protected applyTransform(x: number, y: number, z: number): void {
    const lift = z + this.visualZ;
    this.x = x;
    this.y = y - lift;
    this.zIndex = y; // Y-sort — the GROUND coordinate, never the lifted one

    if (this.shadow) {
      // Displaced away from the key light in proportion to height: a body at head height
      // does not cast straight down. Without this, a hover only ever scaled the shadow,
      // which reads as the shadow breathing rather than the body rising.
      this.shadow.x = x + this.shadowOffsetX + lift * SHADOW_SLANT_X;
      this.shadow.y = y + this.shadowOffsetY + lift * SHADOW_SLANT_Y;
      const k = 1 / (1 + lift * SHADOW_LIFT_FALLOFF); // higher lift → smaller, fainter shadow
      this.shadow.scale.set(k);
      this.shadow.alpha = k;
    }
  }

  destroy(): void {
    this.shadow?.parent?.removeChild(this.shadow);
    this.shadow?.destroy();
    super.destroy({ children: true });
  }
}
