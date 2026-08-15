import { describe, it, expect, vi } from 'vitest';
import { FxController, type CameraTarget } from './FxController';
import { Layers } from '../scene/layers';

// FxController's filters (fx/filters.ts) build a real WebGL GlProgram at construction
// time — unavailable under plain vitest (no `document`/canvas), and irrelevant to the
// camera-zoom math this file tests. Stubbed the same way RoomBuilder.test.ts stubs
// render/biomeTiles.ts: a controllable, network/GPU-independent replacement.
vi.mock('./filters', () => ({
  VignetteFilter: class { intensity = 0; radius = 0; },
  ChromaticAberrationFilter: class { amount: number; constructor(amount = 0) { this.amount = amount; } },
}));

// Same reason as the `./filters` mock above, for pixi.js's OWN built-in `BlurFilter`
// (the fx layer's bloom-lite, `attach()`) — it also eagerly builds a real GlProgram at
// construction. `attach()` was never exercised by any test in this file before the
// EntityLayerCompositor wiring below needed it (nothing here reads the blur filter
// itself), so everything else from `pixi.js` (Container, Graphics, …) stays the real
// thing via `importActual` — only this one GL-needing class is swapped out.
vi.mock('pixi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('pixi.js')>();
  return { ...actual, BlurFilter: class {} };
});

// updateCamera's zoom-to-fill (design/10 legibility fix, 2026-08-02; cover-fit follow-up
// 2026-08-12): a room smaller than the viewport is zoomed up so BOTH axes cover it
// (cover-fit — zoom by whichever axis needs the most zoom), capped so a tiny/degenerate
// room doesn't blow sprites up into blocks, and leaves an already-big room (arenas, big
// dungeon rooms) untouched at 1x. No letterbox void on either axis; the axis that didn't
// need the zoom instead overflows the viewport and pans with the player (the existing
// clamp-to-room-bounds branch).
function fakePlayer(x: number, y: number): CameraTarget {
  return { interpGroundX: () => x, interpGroundY: () => y };
}

describe('FxController.lights (design/01 fidelity roadmap milestone 2)', () => {
  it('registers a transient light from flash(), matching the burst position/colour', () => {
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.flash(100, 200, 0x66e0ff, 20);
    const hit = fx.lights.strongestAt(100, 200);
    expect(hit).not.toBeNull();
    expect(hit!.color).toBe(0x66e0ff);
  });

  it('decays flash()-registered lights via updateFx, same lifetime as the visual burst', () => {
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.flash(0, 0, 0xffffff, 20);
    const full = fx.lights.strongestAt(0, 0)!.intensity;
    fx.updateFx(85, 0, undefined); // half of FX_LIFE_MS (170ms)
    const half = fx.lights.strongestAt(0, 0)!.intensity;
    expect(half).toBeLessThan(full);
    fx.updateFx(86, 0, undefined); // past its lifetime
    expect(fx.lights.strongestAt(0, 0)).toBeNull();
  });

  it('resetForNewRun clears every light — a fresh run inherits none of the last one\'s glow', () => {
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.lights.addPersistent('local', { x: 0, y: 0, color: 0xffffff, radius: 100, intensity: 1 });
    fx.resetForNewRun();
    expect(fx.lights.strongestAt(0, 0)).toBeNull();
  });
});

describe('FxController.updateCamera', () => {
  it('is a no-op (leaves layers.world untouched) with no player', () => {
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 400, h: 400 }, null);
    expect(layers.world.scale.x).toBe(1);
    expect(layers.world.x).toBe(0);
    expect(layers.world.y).toBe(0);
  });

  it('zooms a small room up to cover both axes, capped at MAX_ZOOM', () => {
    const layers = new Layers();
    const fx = new FxController(layers);
    // zoomX = 800/200 = 4, zoomY = 600/200 = 3 — cover-fit picks the max (4), past the cap (2.5).
    fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 200, h: 200 }, fakePlayer(100, 100));
    expect(layers.world.scale.x).toBeCloseTo(2.5);
    expect(layers.world.scale.y).toBeCloseTo(2.5);
    expect(fx.zoom).toBeCloseTo(2.5);
  });

  it('zooms by the uncapped cover-fit ratio when under MAX_ZOOM', () => {
    const layers = new Layers();
    const fx = new FxController(layers);
    // zoomX = 800/500 = 1.6, zoomY = 600/500 = 1.2 — cover-fit picks the max (1.6), under the cap.
    fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 500, h: 500 }, fakePlayer(250, 250));
    expect(layers.world.scale.x).toBeCloseTo(1.6);
    expect(fx.zoom).toBeCloseTo(1.6);
  });

  it('never shrinks a room that already covers the viewport (zoom floors at 1)', () => {
    const layers = new Layers();
    const fx = new FxController(layers);
    // zoomX = 800/2000 = 0.4, zoomY = 600/2000 = 0.3 — both under 1, floored to 1.
    fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 2000, h: 2000 }, fakePlayer(1000, 1000));
    expect(layers.world.scale.x).toBe(1);
    expect(fx.zoom).toBe(1);
  });

  it('exposes the same zoom on `fx.zoom` that it applies to layers.world.scale', () => {
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 500, h: 500 }, fakePlayer(250, 250));
    expect(fx.zoom).toBe(layers.world.scale.x);
  });

  it('fills the axis that needs more zoom exactly, panning the other axis with the player (cover-fit, no void)', () => {
    const layers = new Layers();
    const fx = new FxController(layers);
    // A square room in a wider-than-tall viewport: cover-fit picks the axis that needs
    // MORE zoom (horizontal, 800/400=2 vs vertical 400/400=1), so the effective width
    // exactly fills vw (no horizontal void) while the effective height now overflows
    // vh and the clamp-to-room-bounds branch pans it toward the player instead.
    fx.updateCamera(1, { vw: 800, vh: 400 }, { w: 400, h: 400 }, fakePlayer(200, 200));
    expect(layers.world.scale.x).toBeCloseTo(2);
    expect(layers.world.x).toBeCloseTo(0); // effW === vw exactly at this zoom — no horizontal void
    expect(layers.world.y).toBeCloseTo(-200); // effH (800) > vh (400) — panned toward the player, clamped to [-400, 0]
  });

  it('never calls into a renderer before attach() — updateCamera is safe pre-attach (every test above relies on this)', () => {
    const layers = new Layers();
    const fx = new FxController(layers);
    expect(() => fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 500, h: 500 }, fakePlayer(250, 250))).not.toThrow();
  });
});

// The 2026-08-15 non-integer-camera-zoom Filter fix (see EntityLayerCompositor's own
// doc comment + [[daydayup-engine-conventions]]): `entities` is baked to a texture at a
// fixed 1:1 scale — driven from `updateCamera`, right where `worldSize` is already
// computed — instead of sitting directly inside the live-zoomed `layers.world`. Reaches
// into FxController's own private `entityCompositor` field via bracket access (TS
// `private` is erased at runtime) since it's an implementation detail, not part of
// FxController's public surface — these tests exist to pin the WIRING (attach mounts
// the view, updateCamera drives the bake with the right size/container), not to
// re-verify EntityLayerCompositor's own behaviour (EntityLayerCompositor.test.ts covers
// that in isolation).
describe('FxController + EntityLayerCompositor wiring', () => {
  function fakeRenderer() {
    return { render: vi.fn() };
  }

  it('attach() mounts the compositor\'s view into layers.world, in entities\' old paint-order slot', () => {
    const layers = new Layers();
    const fx = new FxController(layers);
    const view = (fx as unknown as { entityCompositor: { view: unknown } }).entityCompositor.view;
    expect(layers.world.children).not.toContain(view); // not yet, pre-attach
    fx.attach(fakeRenderer() as never);
    expect(layers.world.children).toEqual([layers.ground, layers.shadow, view, layers.fx]);
  });

  it('updateCamera re-bakes entities into the compositor once attached, sized to worldSize', () => {
    const layers = new Layers();
    const fx = new FxController(layers);
    const renderer = fakeRenderer();
    fx.attach(renderer as never);

    fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 500, h: 500 }, fakePlayer(250, 250));

    expect(renderer.render).toHaveBeenCalledTimes(1);
    const call = renderer.render.mock.calls[0]![0] as { container: unknown; target: unknown };
    expect(call.container).toBe(layers.entities);
    const view = (fx as unknown as { entityCompositor: { view: { texture: { width: number; height: number } } } })
      .entityCompositor.view;
    expect(view.texture.width).toBe(500);
    expect(view.texture.height).toBe(500);
  });

  it('updateCamera does NOT bake entities when there is no player (the existing no-op early-return)', () => {
    const layers = new Layers();
    const fx = new FxController(layers);
    const renderer = fakeRenderer();
    fx.attach(renderer as never);

    fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 500, h: 500 }, null);

    expect(renderer.render).not.toHaveBeenCalled();
  });
});
