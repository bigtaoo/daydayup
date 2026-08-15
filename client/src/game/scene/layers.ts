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
  // Y-sort — every actor/bullet/pickup/pillar/portal is added here (Scene/RoomBuilder),
  // same as always. Deliberately NOT added to `world` directly (see `mountEntitiesView`
  // below) — its content is rendered into `world` via a proxy view instead.
  readonly entities = new Container();
  readonly fx = new Container();
  readonly ui = new Container();

  constructor() {
    // entities are sorted by zIndex (= gy) for top-down depth occlusion
    this.entities.sortableChildren = true;

    // `entities` itself is deliberately absent here — `mountEntitiesView` inserts its
    // stand-in once Game wires up the compositor. ground/shadow/fx paint order is
    // otherwise unchanged; `fx` still ends up last (topmost within `world`).
    this.world.addChild(this.ground, this.shadow, this.fx);
    this.root.addChild(this.backdrop, this.world, this.ui);
  }

  /** Insert `entities`' stand-in view (`EntityLayerCompositor.view`, scene/
   *  EntityLayerCompositor.ts) at exactly the paint-order slot `entities` itself used to
   *  occupy — between `shadow` and `fx`. `entities` (the real Y-sorted container every
   *  actor/bullet/pickup/pillar/portal still lives in) is rendered into that view's
   *  texture separately, once per frame, at a fixed 1:1 scale — see EntityLayerCompositor's
   *  own doc comment for why (Pixi's Filter system corrupts a per-actor custom Filter,
   *  e.g. the shield glow, whenever the live camera zoom is a non-integer factor; baking
   *  `entities` to a texture at scale=1 first means every such Filter always renders
   *  under an unscaled ancestor, found 2026-08-15). Idempotent-ish in practice — Game
   *  calls this exactly once, right after constructing both `Layers` and the compositor. */
  mountEntitiesView(view: Container): void {
    this.world.addChildAt(view, this.world.getChildIndex(this.fx));
  }
}
