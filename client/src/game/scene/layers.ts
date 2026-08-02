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

  readonly ground = new Container();
  readonly shadow = new Container();
  readonly entities = new Container(); // Y-sort
  readonly fx = new Container();
  readonly ui = new Container();

  constructor() {
    // entities are sorted by zIndex (= gy) for top-down depth occlusion
    this.entities.sortableChildren = true;

    this.world.addChild(this.ground, this.shadow, this.entities, this.fx);
    this.root.addChild(this.backdrop, this.world, this.ui);
  }
}
