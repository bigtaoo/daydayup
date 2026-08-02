import { describe, it, expect, vi } from 'vitest';
import { FxController, type CameraTarget } from './FxController';
import { Layers } from './layers';

// FxController's filters (fx/filters.ts) build a real WebGL GlProgram at construction
// time — unavailable under plain vitest (no `document`/canvas), and irrelevant to the
// camera-zoom math this file tests. Stubbed the same way RoomBuilder.test.ts stubs
// render/biomeTiles.ts: a controllable, network/GPU-independent replacement.
vi.mock('./fx/filters', () => ({
  VignetteFilter: class { intensity = 0; radius = 0; },
  ChromaticAberrationFilter: class { amount: number; constructor(amount = 0) { this.amount = amount; } },
}));

// updateCamera's small-room zoom-to-fit (design/10 legibility fix, 2026-08-02): a room
// smaller than the viewport used to just sit centred in a sea of black — this zooms it
// up to fill the tighter axis (contain-fit), capped so a tiny/degenerate room doesn't
// blow sprites up into blocks, and leaves an already-big room (arenas, big dungeon
// rooms) untouched at 1x.
function fakePlayer(x: number, y: number): CameraTarget {
  return { interpGroundX: () => x, interpGroundY: () => y };
}

describe('FxController.updateCamera', () => {
  it('is a no-op (leaves layers.world untouched) with no player', () => {
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 400, h: 400 }, null);
    expect(layers.world.scale.x).toBe(1);
    expect(layers.world.x).toBe(0);
    expect(layers.world.y).toBe(0);
  });

  it('zooms a small room up to fill the tighter axis, capped at MAX_ZOOM', () => {
    const layers = new Layers();
    const fx = new FxController(layers);
    // zoomX = 800/200 = 4, zoomY = 600/200 = 3 — min is 3, past the cap.
    fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 200, h: 200 }, fakePlayer(100, 100));
    expect(layers.world.scale.x).toBeCloseTo(1.8);
    expect(layers.world.scale.y).toBeCloseTo(1.8);
    expect(fx.zoom).toBeCloseTo(1.8);
  });

  it('zooms by the uncapped contain-fit ratio when under MAX_ZOOM', () => {
    const layers = new Layers();
    const fx = new FxController(layers);
    // zoomX = 800/500 = 1.6, zoomY = 600/500 = 1.2 — min is 1.2, under the cap.
    fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 500, h: 500 }, fakePlayer(250, 250));
    expect(layers.world.scale.x).toBeCloseTo(1.2);
    expect(fx.zoom).toBeCloseTo(1.2);
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

  it('centres a room that fits entirely within the viewport at its computed zoom', () => {
    const layers = new Layers();
    const fx = new FxController(layers);
    // A square room in a wider-than-tall viewport: zoom picks the tighter (vertical)
    // axis, so the effective height exactly fills vh (no vertical bar) while the
    // effective width is centred with equal bars left/right.
    fx.updateCamera(1, { vw: 800, vh: 400 }, { w: 400, h: 400 }, fakePlayer(200, 200));
    const zoom = layers.world.scale.x;
    const effW = 400 * zoom;
    expect(layers.world.x).toBeCloseTo((800 - effW) / 2);
    expect(layers.world.y).toBeCloseTo(0); // effH === vh exactly at this zoom
  });
});
