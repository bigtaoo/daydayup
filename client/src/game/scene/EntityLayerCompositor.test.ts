/**
 * EntityLayerCompositor — bakes `layers.entities` to a texture at a fixed 1:1 scale
 * every frame (see its own doc comment for why: Pixi's Filter system, e.g. the shield
 * glow, corrupts under a non-integer camera zoom when the filtered node sits directly
 * inside the live-zoomed `layers.world`). No real WebGL renderer is available under
 * plain vitest (no `document`/canvas) — `render()`'s `Renderer` param is duck-typed to
 * just the one method this class calls, faked here (same host-callback-style stubbing
 * as FxController.test.ts's `./filters` mock).
 */
import { Container } from 'pixi.js';
import { describe, it, expect, vi } from 'vitest';
import { EntityLayerCompositor } from './EntityLayerCompositor';

function fakeRenderer() {
  return { render: vi.fn() };
}

describe('EntityLayerCompositor', () => {
  it('renders `entities` into `view`s texture, sized to the given world px extent', () => {
    const entities = new Container();
    const compositor = new EntityLayerCompositor(entities);
    const renderer = fakeRenderer();

    compositor.render(renderer as never, 100, 50);

    expect(renderer.render).toHaveBeenCalledTimes(1);
    const call = renderer.render.mock.calls[0]![0] as { container: unknown; target: unknown; clear: boolean };
    expect(call.container).toBe(entities);
    expect(call.target).toBe(compositor.view.texture);
    expect(call.clear).toBe(true);
    expect(compositor.view.texture.width).toBe(100);
    expect(compositor.view.texture.height).toBe(50);
  });

  it('rounds a fractional world extent UP to whole px (never crops the last partial pixel)', () => {
    const compositor = new EntityLayerCompositor(new Container());
    compositor.render(fakeRenderer() as never, 100.2, 50.9);
    expect(compositor.view.texture.width).toBe(101);
    expect(compositor.view.texture.height).toBe(51);
  });

  it('reuses the same texture across frames when the world extent is unchanged', () => {
    const compositor = new EntityLayerCompositor(new Container());
    const renderer = fakeRenderer();
    compositor.render(renderer as never, 200, 200);
    const first = compositor.view.texture;
    compositor.render(renderer as never, 200, 200);
    expect(compositor.view.texture).toBe(first);
  });

  it('reallocates the texture when the world extent changes (a fresh RoomBuilder.build)', () => {
    const compositor = new EntityLayerCompositor(new Container());
    const renderer = fakeRenderer();
    compositor.render(renderer as never, 200, 200);
    const first = compositor.view.texture;
    compositor.render(renderer as never, 300, 200);
    expect(compositor.view.texture).not.toBe(first);
    expect(compositor.view.texture.width).toBe(300);
  });

  it('clamps a degenerate (zero/negative) extent to a harmless 1x1 texture', () => {
    const compositor = new EntityLayerCompositor(new Container());
    compositor.render(fakeRenderer() as never, 0, -5);
    expect(compositor.view.texture.width).toBe(1);
    expect(compositor.view.texture.height).toBe(1);
  });
});
