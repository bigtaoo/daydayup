/**
 * Layers — the fixed render-layer wiring (design/01). Pins the exact child order
 * (paint order matters: backdrop behind world behind ui; ground/shadow/[entities'
 * stand-in]/fx within world) and the one non-default flag (`entities.sortableChildren`,
 * the Y-sort for top-down depth occlusion). `entities` itself is deliberately NOT a
 * child of `world` (see `mountEntitiesView` / EntityLayerCompositor.ts) — it's rendered
 * to a texture at a fixed 1:1 scale instead, so a proxy view stands in its paint-order
 * slot.
 */
import { Container } from 'pixi.js';
import { describe, it, expect } from 'vitest';
import { Layers } from './layers';

describe('Layers', () => {
  it('roots backdrop, world, ui in that paint order', () => {
    const layers = new Layers();
    expect(layers.root.children).toEqual([layers.backdrop, layers.world, layers.ui]);
  });

  it('world contains ground, shadow, fx in that paint order — entities absent until mounted', () => {
    const layers = new Layers();
    expect(layers.world.children).toEqual([layers.ground, layers.shadow, layers.fx]);
    expect(layers.world.children).not.toContain(layers.entities);
  });

  it('mountEntitiesView inserts the given view between shadow and fx', () => {
    const layers = new Layers();
    const view = new Container();
    layers.mountEntitiesView(view);
    expect(layers.world.children).toEqual([layers.ground, layers.shadow, view, layers.fx]);
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
});
