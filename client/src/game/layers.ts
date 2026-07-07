import { Container } from 'pixi.js';

// Render layers (see design/01-rendering.md).
// The world layer pans with the camera; the ui layer is fixed.
export class Layers {
  readonly root = new Container();
  readonly world = new Container();

  readonly ground = new Container();
  readonly shadow = new Container();
  readonly entities = new Container(); // Y-sort
  readonly fx = new Container();
  readonly ui = new Container();

  constructor() {
    // entities are sorted by zIndex (= gy) for top-down depth occlusion
    this.entities.sortableChildren = true;

    this.world.addChild(this.ground, this.shadow, this.entities, this.fx);
    this.root.addChild(this.world, this.ui);
  }
}
