import { Container } from 'pixi.js';

// Render layers (see design/01-rendering.md).
// The world layer pans with the camera; the ui layer is fixed.
export class Layers {
  readonly root = new Container();
  readonly world = new Container();

  // Full-viewport backdrop (Backdrop.ts, design/10 legibility fix 2026-08-02) — screen
  // space like `ui`, NOT a child of `world`, so it never scales/pans with the camera and
  // always covers whatever black void a small zoomed-to-fit room would otherwise leave.
  // Added to `root` before `world` so it always paints behind everything else.
  readonly backdrop = new Container();

  // Everything the one scene-lighting pass shades (`SceneLightFilter`, attached by
  // `FxController.attach`): the floor, the ground shadows, and the Y-sorted entity set.
  // Deliberately NOT `fx` (muzzle flashes and particles ARE light — shading them would dim
  // the very thing casting the light, and that layer carries its own bloom-lite blur) and
  // NOT `hud` (a floating health bar is a readout riding in world space, not a surface).
  // Introduced 2026-08-24 when lighting moved off the individual actors — see litFx.ts.
  readonly lit = new Container();

  readonly ground = new Container();
  readonly shadow = new Container();
  readonly entities = new Container(); // Y-sort
  readonly fx = new Container();
  // World-space, always-on-top, never blurred (unlike `fx`, which carries a permanent
  // bloom-lite BlurFilter for muzzle flashes/trails — see FxController.attach). The one thing
  // that needs both properties at once is a floating health bar: it has to pan/zoom with the
  // camera like everything else in `world`, but must never be visually buried behind a standing
  // wall the occlusion x-ray only PARTIALLY fades (design/01 "Limits of fake 3D" — a health bar
  // is a HUD readout riding in world space, not a body part; it should never share the body's
  // "reads through translucent stone" treatment, which stays legible for a near-white body but
  // washes out the bar's own dark contour/track, live report *"血条被墙挡住了"*). Drawn last
  // among `world`'s children, so it is unconditionally in front of every wall/pillar/door/actor.
  readonly hud = new Container();
  readonly ui = new Container();

  constructor() {
    // entities are sorted by zIndex (= gy) for top-down depth occlusion
    this.entities.sortableChildren = true;

    this.lit.addChild(this.ground, this.shadow, this.entities);
    this.world.addChild(this.lit, this.fx, this.hud);
    this.root.addChild(this.backdrop, this.world, this.ui);

    // Own render group per structurally-STATIC layer (2026-08-24 draw-call pass).
    //
    // A Pixi v8 render group caches its instruction set — the flattened list of "add this
    // renderable to the batch, break here, draw this on its own" — and rebuilds it only when its
    // own contents change. Writing any descendant's `zIndex` invalidates it
    // (`sortMixin.depthOfChildModified` -> `structureDidChange`), and `entities` is a layer whose
    // whole purpose is that every actor writes a `zIndex` every frame. Before this split there was
    // ONE group for all of `root`, so those per-actor writes threw away the cached instructions for
    // the floor, the ground shadows, the health bars and the whole UI as well, and all of it was
    // re-collected 60 times a second: 168 Graphics re-added per frame, of which 54 belonged to
    // layers that had not changed since the room loaded.
    //
    // The layers below either never change during a room (`ground`) or change only when an entity
    // spawns/dies (`shadow`, `hud`) or on a phase/resize (`ui`, `backdrop`) — all of which still
    // invalidate their own group correctly, just not once per frame. Measured on the level-1 start
    // room, 8 live enemies: 168 -> 114 re-adds, render collection 0.60 -> 0.52 ms, and it is what
    // makes `staticGraphics()` affordable on `ground`/`shadow` (see that module).
    //
    // NOT `entities` (rebuilt every frame by design — a group there would buy nothing and add a
    // batch boundary), NOT `fx` (particles are added and removed constantly, plus it carries a
    // blur filter), and NOT `lit`/`world` (they hold `entities`, so they inherit its churn).
    for (const layer of [this.ground, this.shadow, this.hud, this.ui, this.backdrop]) {
      layer.enableRenderGroup();
    }
  }
}
