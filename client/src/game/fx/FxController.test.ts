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

// updateCamera's small-room zoom-to-fit (design/10 legibility fix, 2026-08-02): a room
// smaller than the viewport used to just sit centred in a sea of black — this zooms it
// up to fill the tighter axis (contain-fit), capped so a tiny/degenerate room doesn't
// blow sprites up into blocks, and leaves an already-big room (arenas, big dungeon
// rooms) untouched at 1x.
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

  it('zooms a small room up to fill the tighter axis, capped at MAX_ZOOM', () => {
    const layers = new Layers();
    const fx = new FxController(layers);
    // zoomX = 800/200 = 4, zoomY = 600/200 = 3 — min is 3, past the cap (2.5).
    fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 200, h: 200 }, fakePlayer(100, 100));
    expect(layers.world.scale.x).toBeCloseTo(2.5);
    expect(layers.world.scale.y).toBeCloseTo(2.5);
    expect(fx.zoom).toBeCloseTo(2.5);
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
