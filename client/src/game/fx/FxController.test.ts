import { describe, it, expect, vi } from 'vitest';
import { FxController, type CameraTarget } from './FxController';
import { Layers } from '../scene/layers';
import { makeLightBuffer } from './lighting';

// FxController's filters (fx/filters.ts) build a real WebGL GlProgram at construction
// time — unavailable under plain vitest (no `document`/canvas), and irrelevant to the
// camera-zoom math this file tests. Stubbed the same way RoomBuilder.test.ts stubs
// render/biomeTiles.ts: a controllable, network/GPU-independent replacement.
// `SceneLightFilter`'s stub RECORDS what it is handed, so the tests below can assert the
// region and light set the camera pass uploads without a GPU.
// `attach()` also builds Pixi's own BlurFilter for the fx layer, which compiles a real GL
// program at construction and therefore needs a canvas. Partial-mocked (everything else in
// pixi.js stays real — `Layers` needs the actual Container) so the attach path is testable.
vi.mock('pixi.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('pixi.js')>()),
  BlurFilter: class { strength = 0; quality = 0; },
}));

vi.mock('./filters', () => ({
  VignetteFilter: class { intensity = 0; radius = 0; },
  ChromaticAberrationFilter: class { amount: number; constructor(amount = 0) { this.amount = amount; } },
  MAX_SCENE_LIGHTS: 8,
  SceneLightFilter: class {
    region: number[] = [0, 0, 1, 1];
    lights: { x: number; y: number; radius: number; intensity: number; color: number }[] = [];
    setRegion(x: number, y: number, w: number, h: number) { this.region = [x, y, w, h]; }
    setLights(lights: { x: number; y: number; radius: number; intensity: number; color: number }[], count: number) {
      this.lights = lights.slice(0, count).map((l) => ({ ...l }));
    }
  },
}));

const MAX_SCENE_LIGHTS = 8;

/** The stub filter's recorded state, typed for the assertions below. */
function recorded(fx: FxController) {
  return fx.sceneLight as unknown as {
    region: number[];
    lights: { x: number; y: number; radius: number; intensity: number; color: number }[];
  };
}

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

/** The registry's live set, as `SceneLightFilter` would receive it. */
function activeLights(fx: FxController) {
  const buf = makeLightBuffer(MAX_SCENE_LIGHTS);
  return buf.slice(0, fx.lights.snapshot(buf));
}

describe('FxController.lights (design/01 fidelity roadmap milestone 2)', () => {
  it('registers a transient light from flash(), matching the burst position/colour', () => {
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.flash(100, 200, 0x66e0ff, 20);
    const lit = activeLights(fx);
    expect(lit).toHaveLength(1);
    expect(lit[0]!.color).toBe(0x66e0ff);
    expect([lit[0]!.x, lit[0]!.y]).toEqual([100, 200]);
  });

  it('decays flash()-registered lights via updateFx, same lifetime as the visual burst', () => {
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.flash(0, 0, 0xffffff, 20);
    const full = activeLights(fx)[0]!.intensity;
    fx.updateFx(85, 0, undefined); // half of FX_LIFE_MS (170ms)
    const half = activeLights(fx)[0]!.intensity;
    expect(half).toBeLessThan(full);
    fx.updateFx(86, 0, undefined); // past its lifetime
    expect(activeLights(fx)).toEqual([]);
  });

  it('resetForNewRun clears every light — a fresh run inherits none of the last one\'s glow', () => {
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.lights.addPersistent('local', { x: 0, y: 0, color: 0xffffff, radius: 100, intensity: 1 });
    fx.resetForNewRun();
    expect(activeLights(fx)).toEqual([]);
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

// 2026-08-24: lighting moved off the individual actors onto one screen-space pass over
// `Layers.lit`. The pass shades by WORLD position, so the camera rect it is handed has to be
// the inverse of the camera transform that same frame — get this wrong and every light sits
// somewhere other than where its source is, in a way no unit test of the shader could catch.
describe('FxController scene-light sync', () => {
  it('mounts the one lighting pass on the lit layer, with a filterArea (never bare bounds)', () => {
    // The filter opts out of Pixi's viewport clip, so with no filterArea its region would be
    // the whole dungeon floor's bounds — a texture allocation the size of the level.
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.attach();
    expect(layers.lit.filters).toEqual([fx.sceneLight]);
    expect(layers.lit.filterArea).not.toBeNull();
  });

  it('leaves fx and hud out of the pass — a muzzle flash is light, a health bar is a readout', () => {
    const layers = new Layers();
    new FxController(layers).attach();
    expect(layers.lit.children).toEqual([layers.ground, layers.shadow, layers.entities]);
    expect(layers.world.children).toEqual([layers.lit, layers.fx, layers.hud]);
  });

  it('hands the pass the world rect the camera is actually showing', () => {
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.attach();
    // World twice the viewport on each axis, player dead centre: zoom 1, world at (-400,-300)
    // with the 8%-of-vh body bias, so the visible world rect starts at (400, 348).
    fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 1600, h: 1200 }, fakePlayer(800, 600));
    const [x, y, w, h] = recorded(fx).region;
    expect(w).toBeCloseTo(800);
    expect(h).toBeCloseTo(600);
    expect(x).toBeCloseTo(-layers.world.x / layers.world.scale.x);
    expect(y).toBeCloseTo(-layers.world.y / layers.world.scale.x);
  });

  it('divides the viewport by the zoom — a zoomed-in camera shows LESS world, not more', () => {
    // The region is in world px, so it must shrink as the camera zooms in. Multiplying
    // instead of dividing would look identical at zoom 1 and be wrong at every other zoom,
    // which is exactly the class of bug the shipped camera (zoom 4 in a real room) hits.
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.attach();
    fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 2000, h: 2000 }, fakePlayer(1000, 1000), { x: 800, y: 800, w: 400, h: 400 });
    expect(fx.zoom).toBeCloseTo(2);
    const [, , w, h] = recorded(fx).region;
    expect(w).toBeCloseTo(400);
    expect(h).toBeCloseTo(300);
  });

  it('keeps the filterArea and the shader region describing the same rectangle', () => {
    // These two are set from one computation on purpose: Pixi sizes the render target from
    // `filterArea` while the shader maps texels through `uRegion`. Any drift between them
    // slides the whole lighting relative to the scene.
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.attach();
    fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 2000, h: 2000 }, fakePlayer(1000, 1000), { x: 800, y: 800, w: 400, h: 400 });
    const area = layers.lit.filterArea!;
    expect(recorded(fx).region).toEqual([area.x, area.y, area.width, area.height]);
  });

  it('re-syncs even with no player, so an expiring light still leaves the pass', () => {
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.attach();
    fx.flash(10, 20, 0xff0000, 5);
    fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 400, h: 400 }, null);
    expect(recorded(fx).lights).toHaveLength(1);
    fx.updateFx(1000, 0, undefined); // well past FX_LIFE_MS
    fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 400, h: 400 }, null);
    expect(recorded(fx).lights).toEqual([]);
  });

  it('uploads lights in world coordinates, untouched by the camera', () => {
    // The shader converts texel -> world, not light -> screen. A light pre-multiplied by the
    // camera here would be double-transformed.
    const layers = new Layers();
    const fx = new FxController(layers);
    fx.attach();
    fx.lights.addPersistent('local', { x: 1234, y: 567, color: 0xfff4d6, radius: 140, intensity: 0.35 });
    fx.updateCamera(1, { vw: 800, vh: 600 }, { w: 2000, h: 2000 }, fakePlayer(1000, 1000), { x: 800, y: 800, w: 400, h: 400 });
    expect(recorded(fx).lights[0]).toMatchObject({ x: 1234, y: 567, radius: 140, intensity: 0.35 });
  });
});
