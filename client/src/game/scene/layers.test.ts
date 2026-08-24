/**
 * Layers — the fixed render-layer wiring (design/01). Pins the exact child order
 * (paint order matters: backdrop behind world behind ui; ground/shadow/entities inside
 * `lit`, then fx, then hud) and the one non-default flag (`entities.sortableChildren`,
 * the Y-sort for top-down depth occlusion).
 */
import { describe, it, expect } from 'vitest';
import { Layers } from './layers';

describe('Layers', () => {
  it('roots backdrop, world, ui in that paint order', () => {
    const layers = new Layers();
    expect(layers.root.children).toEqual([layers.backdrop, layers.world, layers.ui]);
  });

  it('world contains lit, fx, hud in that paint order', () => {
    const layers = new Layers();
    expect(layers.world.children).toEqual([layers.lit, layers.fx, layers.hud]);
  });

  it('lit contains ground, shadow, entities in that paint order', () => {
    const layers = new Layers();
    expect(layers.lit.children).toEqual([layers.ground, layers.shadow, layers.entities]);
  });

  // The `lit` grouping (2026-08-24) exists to give the one scene-lighting pass something to
  // hang on. WHICH layers are inside it is the design decision, not an implementation
  // detail: fx is light (shading a muzzle flash would dim the thing casting the light) and
  // hud is a readout, not a surface. Both must stay outside, or the pass eats them.
  it('keeps fx and hud OUT of the lit group — a muzzle flash is light, a health bar is a readout', () => {
    const layers = new Layers();
    expect(layers.lit.children).not.toContain(layers.fx);
    expect(layers.lit.children).not.toContain(layers.hud);
    expect(layers.fx.parent).toBe(layers.world);
    expect(layers.hud.parent).toBe(layers.world);
  });

  it('puts the whole floor inside the lit group, so a light lands on the ground too', () => {
    // Lighting only `entities` would leave a muzzle flash illuminating the walls and the
    // characters while the floor under it stayed flat — the giveaway that it is not real
    // lighting. This is the one layer whose inclusion is a look decision rather than a
    // mechanical one.
    const layers = new Layers();
    expect(layers.ground.parent).toBe(layers.lit);
    expect(layers.shadow.parent).toBe(layers.lit);
  });

  it('only entities is sortable (Y-sort by zIndex) — every other layer stays insertion order', () => {
    const layers = new Layers();
    expect(layers.entities.sortableChildren).toBe(true);
    expect(layers.ground.sortableChildren).toBe(false);
    expect(layers.shadow.sortableChildren).toBe(false);
    expect(layers.lit.sortableChildren).toBe(false);
    expect(layers.fx.sortableChildren).toBe(false);
    expect(layers.hud.sortableChildren).toBe(false);
    expect(layers.ui.sortableChildren).toBe(false);
    expect(layers.backdrop.sortableChildren).toBe(false);
    expect(layers.world.sortableChildren).toBe(false);
  });

  // Render-group split, 2026-08-24 draw-call pass. Writing any descendant's `zIndex` marks the
  // whole enclosing render group's instruction set for a rebuild, and `entities` writes one per
  // actor per frame — so before this split the floor, the ground shadows, the health bars and the
  // UI were all re-collected 60 times a second (measured: 168 Graphics re-added per frame, 54 of
  // them on layers unchanged since the room loaded). This is also the precondition that makes
  // `staticGraphics()` a win rather than a loss on `ground`/`shadow`, so the two must not drift
  // apart: batching that geometry inside a per-frame-rebuilt group measured NET SLOWER.
  it('gives every structurally-static layer its own render group', () => {
    const layers = new Layers();
    for (const layer of [layers.ground, layers.shadow, layers.hud, layers.ui, layers.backdrop]) {
      expect(layer.isRenderGroup).toBe(true);
    }
  });

  it('leaves entities, fx and the wrappers OUT of their own render group', () => {
    // `entities` is invalidated every frame by design, so a group there buys nothing and costs a
    // batch boundary; `fx` churns children constantly and carries the bloom blur; `lit`/`world`
    // contain `entities` and would inherit its churn. Grouping any of them is the mistake this
    // pins — the win came from isolating the STATIC layers, not from grouping everything.
    const layers = new Layers();
    for (const layer of [layers.entities, layers.fx, layers.lit, layers.world, layers.root]) {
      expect(layer.isRenderGroup).toBe(false);
    }
  });

  it('hud is drawn AFTER fx — always on top of the bloom-blurred layer too', () => {
    const layers = new Layers();
    const idx = (c: unknown) => layers.world.children.indexOf(c as never);
    expect(idx(layers.hud)).toBeGreaterThan(idx(layers.fx));
  });

  it('walls and actors still share ONE sorted container — the depth model is unchanged', () => {
    // The lit grouping wraps `entities`; it must never split it. A standing wall block and
    // a character Y-sort against each other as one set (RoomBuilder mounts wall segments
    // into `entities` alongside every Actor), and separating them to give actors their own
    // filter target would break every occlusion cue in the frame.
    const layers = new Layers();
    expect(layers.entities.parent).toBe(layers.lit);
    expect(layers.entities.sortableChildren).toBe(true);
  });

  it('backdrop and ui are siblings of world, not children of it (screen-space, never panned/zoomed)', () => {
    const layers = new Layers();
    expect(layers.world.children).not.toContain(layers.backdrop);
    expect(layers.world.children).not.toContain(layers.ui);
  });

  // Regression guard for the reverted `EntityLayerCompositor` (commit d5c06db, reverted
  // 2026-08-15). It replaced `entities` with a Sprite fed by a per-frame `RenderTexture`
  // bake, to work around what was thought to be a Pixi filter bug under non-integer camera
  // zoom. The real cause was this repo's own shader UV maths (see `FRAME_UV` in
  // fx/filters.ts), and the bake cost real image quality: `RenderTexture.create()` defaults
  // to `resolution: 1` with no antialias while the renderer runs at
  // `min(devicePixelRatio, 2)`, so every actor/bullet/pillar/portal was sampled at roughly
  // `1/(2 x zoom)` of the rest of the frame and then upscaled — plus additive children
  // (status auras, bullets) lost their blend against the ground, and each frame paid an
  // extra full-room render pass. `entities` must render live.
  it('entities renders live — no baked-texture stand-in (resolution + additive-blend regression)', () => {
    const layers = new Layers();
    expect(layers.lit.children).toContain(layers.entities);
    // Nothing else may sit in that slot pretending to be `entities`.
    expect(layers.lit.children).toHaveLength(3);
    expect(layers.world.children).toHaveLength(3);
  });
});
