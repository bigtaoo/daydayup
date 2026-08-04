import { Container, Graphics } from 'pixi.js';
import { THEME } from '../theme';

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

  // Create an elliptical soft shadow, added to the shadow layer by the caller.
  makeShadow(radius: number): Graphics {
    const s = new Graphics();
    s.ellipse(0, 0, radius, radius * 0.5).fill({ color: THEME.colors.shadow, alpha: 0.35 });
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
  protected applyTransform(x: number, y: number, z: number): void {
    this.x = x;
    this.y = y - z;
    this.zIndex = y; // Y-sort

    if (this.shadow) {
      this.shadow.x = x;
      this.shadow.y = y;
      const k = 1 / (1 + z * 0.012); // higher lift → smaller, fainter shadow
      this.shadow.scale.set(k);
      this.shadow.alpha = 0.35 * k;
    }
  }

  destroy(): void {
    this.shadow?.parent?.removeChild(this.shadow);
    this.shadow?.destroy();
    super.destroy({ children: true });
  }
}
