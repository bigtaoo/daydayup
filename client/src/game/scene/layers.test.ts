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
});
