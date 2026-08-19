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
    // zoomX = 800/100 = 8, zoomY = 600/100 = 6 — cover-fit picks the max (8), past the cap (4.5).
    fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 100, h: 100 }, fakePlayer(50, 50));
    expect(layers.world.scale.x).toBeCloseTo(4.5);
    expect(layers.world.scale.y).toBeCloseTo(4.5);
    expect(fx.zoom).toBeCloseTo(4.5);
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
    // effH (800) > vh (400) — panned toward the player, clamped to [-400, 0]. The look-at
    // point is CAMERA_BODY_BIAS_R (8% of vh = 32 screen px, 16 world px at this zoom)
    // above the player's ground point, so the world sits 32px lower than a feet-centred
    // camera's -200 would put it.
    expect(layers.world.y).toBeCloseTo(-168);
  });

  it('centres the character rather than its feet — the look-at point is biased above the ground position', () => {
    const layers = new Layers();
    const fx = new FxController(layers);
    // Same setup on both axes so the vertical bias is the ONLY asymmetry: a world twice
    // the viewport on each axis, player dead centre, so neither clamp bound is hit.
    fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 1600, h: 1200 }, fakePlayer(800, 600));
    expect(fx.zoom).toBe(1);
    expect(layers.world.x).toBeCloseTo(-400); // 800/2 - 800 — exactly centred horizontally
    // 600/2 - (600 - 600*0.08) = 300 - 552. The +48 vs a feet-centred -300 is the bias:
    // the rendered world moves DOWN the screen, which lifts the character off the
    // bottom-heavy framing a feet-centred camera gives it.
    expect(layers.world.y).toBeCloseTo(-252);
  });

  it('fits the FRAME rect (the current room) when given one, not the whole floor', () => {
    const layers = new Layers();
    const fx = new FxController(layers);
    // The floor is 4000x3000 — far bigger than the viewport, so fitting IT floors the
    // zoom at 1 and the player sees several rooms at once. The room they're standing in
    // is 400x400: cover-fit on that picks 800/400 = 2.
    const world = { w: 4000, h: 3000 };
    const player = fakePlayer(2000, 1500);
    fx.updateCamera(1, { vw: 800, vh: 600 }, world, player);
    expect(fx.zoom).toBe(1); // no frame: the old whole-floor behaviour, unchanged

    fx.updateCamera(1, { vw: 800, vh: 600 }, world, player, { x: 1800, y: 1300, w: 400, h: 400 });
    expect(fx.zoom).toBeCloseTo(2);
  });

  it("lets the frame pull the camera ABOVE world y=0, so a north wall's top stays on screen", () => {
    // 2026-08-19. `GameLoop.cameraFrame` extends its rect upward by MAX_WALL_HEIGHT because a
    // standing wall draws its cap and the top of its face at NEGATIVE world y — but `cy`'s upper
    // clamp bound was a flat 0, the world's own top edge, which pinned exactly that band off the
    // top of the screen and silently cancelled the whole extension. Confirmed live before the
    // fix: `layers.world.y === 0` with the room's north wall showing face only, no cap.
    const layers = new Layers();
    const fx = new FxController(layers);
    // A player standing at the north edge of a north-boundary room: without the overscan the
    // clamp pins y at 0.
    fx.updateCamera(
      1,
      { vw: 800, vh: 600 },
      { w: 2000, h: 2000 },
      fakePlayer(1000, 20),
      { x: 800, y: -104, w: 400, h: 504 },
    );
    expect(layers.world.y).toBeGreaterThan(0);
    expect(layers.world.y).toBeCloseTo(104 * fx.zoom); // exactly the overscan the frame asked for
  });

  it('grants no overscan at all when the frame asks for none, or when there is no frame', () => {
    // The floor's own interior rooms have frame.y >= 0, and a mode with no room model passes
    // null — neither may start revealing the void above the world.
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 2000, h: 2000 }, fakePlayer(1000, 20), { x: 800, y: 400, w: 400, h: 400 });
    expect(layers.world.y).toBe(0);
    fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 2000, h: 2000 }, fakePlayer(1000, 20));
    expect(layers.world.y).toBe(0);
  });

  it('still clamps panning to the WORLD, not to the frame — a doorway must not hard-stop the camera', () => {
    const layers = new Layers();
    const fx = new FxController(layers);
    // Player at the far-east edge of a small room at the far-east edge of the floor. The
    // clamp bound has to come from the floor's own width (2000*2 = 4000 effective, so
    // x floors at 800-4000 = -3200), not from the room's.
    fx.updateCamera(
      1,
      { vw: 800, vh: 600 },
      { w: 2000, h: 2000 },
      fakePlayer(1990, 1000),
      { x: 1600, y: 800, w: 400, h: 400 },
    );
    expect(fx.zoom).toBeCloseTo(2);
    expect(layers.world.x).toBeCloseTo(-3200); // hit the WORLD's east bound, not the room's
  });
});
