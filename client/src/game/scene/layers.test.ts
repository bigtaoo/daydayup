/**
 * Layers — the fixed render-layer wiring (design/01). Pins the exact child order
 * (paint order matters: backdrop behind world behind ui; ground/shadow/entities/fx
 * within world) and the one non-default flag (`entities.sortableChildren`, the
 * Y-sort for top-down depth occlusion).
 */
import { describe, it, expect } from 'vitest';
import { Layers } from './layers';

describe('Layers', () => {
  it('roots backdrop, world, ui in that paint order', () => {
    const layers = new Layers();
    expect(layers.root.children).toEqual([layers.backdrop, layers.world, layers.ui]);
  });

  it('world contains ground, shadow, entities, fx in that paint order', () => {
    const layers = new Layers();
    expect(layers.world.children).toEqual([layers.ground, layers.shadow, layers.entities, layers.fx]);
  });

  it('only entities is sortable (Y-sort by zIndex) — ground/shadow/fx/ui/backdrop stay insertion order', () => {
    const layers = new Layers();
    expect(layers.entities.sortableChildren).toBe(true);
    expect(layers.ground.sortableChildren).toBe(false);
    expect(layers.shadow.sortableChildren).toBe(false);
    expect(layers.fx.sortableChildren).toBe(false);
    expect(layers.ui.sortableChildren).toBe(false);
    expect(layers.backdrop.sortableChildren).toBe(false);
    expect(layers.world.sortableChildren).toBe(false);
  });

  it('backdrop and ui are siblings of world, not children of it (screen-space, never panned/zoomed)', () => {
    const layers = new Layers();
    expect(layers.world.children).not.toContain(layers.backdrop);
    expect(layers.world.children).not.toContain(layers.ui);
  });

  // Regression guard for the reverted `EntityLayerCompositor` (commit d5c06db, reverted
  // 2026-08-15). It replaced `entities` inside `world` with a Sprite fed by a per-frame
  // `RenderTexture` bake, to work around what was thought to be a Pixi filter bug under
  // non-integer camera zoom. The real cause was this repo's own shader UV maths (see
  // `FRAME_UV` in fx/filters.ts), and the bake cost real image quality:
  // `RenderTexture.create()` defaults to `resolution: 1` with no antialias while the
  // renderer runs at `min(devicePixelRatio, 2)`, so every actor/bullet/pillar/portal was
  // sampled at roughly `1/(2 x zoom)` of the rest of the frame and then upscaled — plus
  // additive children (status auras, bullets) lost their blend against the ground, and
  // each frame paid an extra full-room render pass. `entities` must render live.
  it('entities renders live inside world — no baked-texture stand-in (resolution + additive-blend regression)', () => {
    const layers = new Layers();
    expect(layers.entities.parent).toBe(layers.world);
    expect(layers.world.children).toContain(layers.entities);
    // Nothing else may sit in that slot pretending to be `entities`.
    expect(layers.world.children).toHaveLength(4);
  });
});
