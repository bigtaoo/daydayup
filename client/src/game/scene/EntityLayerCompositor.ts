import { Container, RenderTexture, Sprite, type Renderer } from 'pixi.js';

/**
 * Renders `layers.entities` (every Y-sorted actor/bullet/pickup/pillar/portal) into an
 * offscreen texture at a fixed 1:1 (world-px) scale, then hands that texture to a plain
 * Sprite (`view`) that `Layers.mountEntitiesView` inserts inside the camera-scaled
 * `world` container in `entities`' place — instead of letting `entities` sit directly
 * inside `world` and get scaled live by the camera zoom.
 *
 * Why (found 2026-08-15, user report: shield glow renders as a partial/lopsided ring on
 * one specific floor, reproducible instantly and only on that floor, surviving a fresh
 * run — fixed only by a full page reload): `FxController.updateCamera`'s cover-fit zoom
 * is a non-integer factor any time a room's size doesn't divide the viewport evenly —
 * confirmed live (forced `layers.world.scale` to 1, 1.5, 2, 2.5, 1.32…) that Pixi's
 * Filter system visibly corrupts a per-actor custom Filter's render (EnergyShieldFilter,
 * NormalLitFilter — every actor always carries the latter) whenever the ancestor chain
 * the filtered node sits under carries a non-1 scale; an integer zoom (1, 2) rendered
 * correctly, non-integer (1.5, 1.32) did not, and neither a bigger `filterArea` margin
 * nor removing the OUTER `world`-level post-fx (vignette/chromatic) changed that — so
 * the bug is Pixi's own nested-filter-under-scaled-ancestor handling, not this game's
 * filter-centering math. Baking `entities` to a texture at scale=1 first means every
 * custom Filter inside it always renders under an UNSCALED ancestor; the resulting
 * texture is then just a normal Sprite, which (confirmed live) renders correctly at any
 * zoom, fractional or not — same as the ground/wall art already did.
 *
 * One texture, refreshed once per frame — NOT one texture per actor — so the added cost
 * is a single extra render pass sized to the current room, not O(actor count). Resized
 * only when the room's own px extent changes (a fresh `RoomBuilder.build()`), which is
 * the common case of a few times per run, not every frame.
 */
export class EntityLayerCompositor {
  readonly view = new Sprite();
  private texture: RenderTexture | null = null;
  private texW = 0;
  private texH = 0;

  constructor(private readonly entities: Container) {}

  /** Call once per frame (Game.update, right after GameLoop.update — every actor's
   *  position/filters for this frame are already settled by then), before Pixi's own
   *  auto-render fires for the same tick. `worldW`/`worldH` are the current room's full
   *  px extent — `RoomBuilder.build()`'s own `w`/`h` (`fpToPx(state.worldW/worldH)`),
   *  the exact size the ground fill already covers — so the texture always matches it
   *  1:1 and `view` needs no scale/position of its own beyond the implicit (0,0). */
  render(renderer: Renderer, worldW: number, worldH: number): void {
    const w = Math.max(1, Math.ceil(worldW));
    const h = Math.max(1, Math.ceil(worldH));
    if (!this.texture || this.texW !== w || this.texH !== h) {
      this.texture?.destroy(true);
      this.texture = RenderTexture.create({ width: w, height: h });
      this.texW = w;
      this.texH = h;
      this.view.texture = this.texture;
    }
    renderer.render({ container: this.entities, target: this.texture, clear: true });
  }

  /** Release the GPU-side render texture — call on final teardown only (there is no
   *  per-run reset: the same texture is reused/resized across rooms and runs alike). */
  destroy(): void {
    this.texture?.destroy(true);
    this.texture = null;
    this.view.destroy();
  }
}
