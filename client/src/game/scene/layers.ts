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
  }
}
