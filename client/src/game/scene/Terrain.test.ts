/**
 * Terrain — the void's far side (2026-08-28). The plane itself and the per-frame fit.
 *
 * Constructed headlessly like every other scene module here: `Layers` + real Pixi display objects,
 * no renderer, no canvas. `fitTerrain` is a free function over the container (matching
 * `groundCulling.cullGroundLayer`), so it is tested directly rather than through `FxController` —
 * the wiring, and specifically that it runs ABOVE the quality-tier guard, is pinned in
 * `fx/FxController.test.ts` instead.
 */
import { describe, it, expect } from 'vitest';
import { Sprite, TilingSprite } from 'pixi.js';
import { Layers } from './layers';
import { Terrain, TERRAIN_FOG_ALPHA, fitTerrain } from './Terrain';
import { TERRAIN_TILE_PX, terrainSwatch } from './terrainSwatch';
import { biomePalette } from '../theme';

function parts(layers: Layers): { plane: TilingSprite; fog: Sprite } {
  return {
    plane: layers.terrain.children[0] as TilingSprite,
    fog: layers.terrain.children[1] as Sprite,
  };
}

describe('Terrain — construction and placement in the layer tree', () => {
  it('mounts exactly two display objects: the plane and the fog', () => {
    const layers = new Layers();
    new Terrain(layers);
    expect(layers.terrain.children.length).toBe(2);
    expect(parts(layers).plane).toBeInstanceOf(TilingSprite);
    expect(parts(layers).fog).toBeInstanceOf(Sprite);
  });

  it('is a child of WORLD, so it pans and zooms with the scene', () => {
    const layers = new Layers();
    expect(layers.world.children).toContain(layers.terrain);
  });

  it('is NOT inside `lit`, which is the whole reason it stays visible', () => {
    // The defect: put this plane under `SceneLightFilter` and the pass that was already darkening
    // everything beyond the player's room darkens the far side too — i.e. the void goes back to
    // being a black rectangle, which is the bug this feature exists to close. `lit`'s membership
    // is the load-bearing fact, so assert it rather than the comment.
    const layers = new Layers();
    expect(layers.lit.children).not.toContain(layers.terrain);
  });

  it('paints BEFORE `lit`, so floor and stone cover it and only the void shows through', () => {
    const layers = new Layers();
    const kids = layers.world.children;
    expect(kids.indexOf(layers.terrain)).toBeLessThan(kids.indexOf(layers.lit));
  });

  it('paints the FOG OVER the plane, which is the only order that does anything', () => {
    // Reversed, the haze sits behind an opaque swatch and contributes exactly nothing — and every
    // other assertion in this file still passes, because both objects are still present, still
    // sized, still tinted. Order is the whole mechanism here, so it is asserted by TYPE rather
    // than by trusting the index the `parts` helper already assumes.
    const layers = new Layers();
    new Terrain(layers);
    const kids = layers.terrain.children;
    const planeIdx = kids.findIndex((c) => c instanceof TilingSprite);
    const fogIdx = kids.findIndex((c) => !(c instanceof TilingSprite));
    expect(planeIdx).toBeGreaterThanOrEqual(0);
    expect(fogIdx).toBeGreaterThanOrEqual(0);
    expect(fogIdx).toBeGreaterThan(planeIdx);
  });

  it('keeps the fog inside a range where it hazes without erasing the grain', () => {
    // Absolute bounds, not `toBe(TERRAIN_FOG_ALPHA)`. That assertion restated the constant and so
    // held at any value at all — a battery walked it and nothing moved. Below ~0.2 the haze stops
    // lifting the blacks it exists to lift; above ~0.5 it eats the swatch's grain, which is the
    // one thing separating this surface from the flat backdrop it replaced.
    expect(TERRAIN_FOG_ALPHA).toBeGreaterThanOrEqual(0.2);
    expect(TERRAIN_FOG_ALPHA).toBeLessThanOrEqual(0.5);
  });

  it('leaves the COMPOSITE between backdrop and floor, and still grainy', () => {
    // What the viewer actually sees is the swatch under the fog, and nothing else in this suite
    // looks at that product — the palette test checks `palette.terrain` before the haze is
    // applied. Computed from the shipped swatch's real bytes rather than from the palette entry.
    const p = biomePalette('ember');
    const buf = terrainSwatch(p.terrain).source.resource as Uint8Array;
    const lu = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;
    const voidL = lu((p.void >> 16) & 0xff, (p.void >> 8) & 0xff, p.void & 0xff);
    const groundL = lu((p.ground >> 16) & 0xff, (p.ground >> 8) & 0xff, p.ground & 0xff);
    let lo = Infinity;
    let hi = -Infinity;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < buf.length; i += 4) {
      const c = lu(buf[i], buf[i + 1], buf[i + 2]) * (1 - TERRAIN_FOG_ALPHA) + voidL * TERRAIN_FOG_ALPHA;
      lo = Math.min(lo, c);
      hi = Math.max(hi, c);
      sum += c;
      n++;
    }
    const mean = sum / n;
    expect(mean).toBeGreaterThan(voidL);
    expect(mean).toBeLessThan(groundL);
    // The grain has to SURVIVE the haze. Before this feature the void's own standard deviation in
    // a live frame was exactly 0 (min = max = 27.70) — a spread of at least a couple of luma
    // steps is the difference between a surface and that flat rectangle.
    expect(hi - lo).toBeGreaterThan(2);
  });
});

describe('Terrain.setPalette', () => {
  it('tiles the plane from the biome terrain colour and tints the fog with its VOID', () => {
    const layers = new Layers();
    const terrain = new Terrain(layers);
    const p = biomePalette('ember');
    terrain.setPalette(p);
    const { plane, fog } = parts(layers);
    expect(plane.texture.source.width).toBe(TERRAIN_TILE_PX);
    expect(fog.tint).toBe(p.void);
  });

  it('re-tiles on a biome change rather than keeping the first room’s swatch', () => {
    const layers = new Layers();
    const terrain = new Terrain(layers);
    terrain.setPalette(biomePalette(undefined));
    const first = parts(layers).plane.texture;
    terrain.setPalette(biomePalette('ember'));
    expect(parts(layers).plane.texture).not.toBe(first);
  });
});

describe('fitTerrain', () => {
  const view = { x: 320, y: -48, w: 800, h: 600 };

  it('covers the view rect exactly, on BOTH children', () => {
    const layers = new Layers();
    new Terrain(layers);
    fitTerrain(layers.terrain, view);
    for (const child of [parts(layers).plane, parts(layers).fog]) {
      expect(child.x).toBe(view.x);
      expect(child.y).toBe(view.y);
      expect(child.width).toBeCloseTo(view.w, 6);
      expect(child.height).toBeCloseTo(view.h, 6);
    }
  });

  it('anchors the swatch to WORLD space, so it does not swim under a panning camera', () => {
    // The defect: leave `tilePosition` at 0 and the texture is pinned to the sprite, which is
    // pinned to the camera — so the ground slides with the player instead of staying put, which
    // reads as the whole world being on a conveyor belt. The invariant is that a fixed WORLD point
    // lands on the same texel whatever the view is.
    const layers = new Layers();
    new Terrain(layers);
    const worldPoint = 1000;

    fitTerrain(layers.terrain, view);
    const plane = parts(layers).plane;
    const texelA = (worldPoint - plane.x - plane.tilePosition.x) % TERRAIN_TILE_PX;

    fitTerrain(layers.terrain, { ...view, x: view.x + 137, y: view.y - 91 });
    const texelB = (worldPoint - plane.x - plane.tilePosition.x) % TERRAIN_TILE_PX;

    expect(texelB).toBeCloseTo(texelA, 6);
  });

  it('control: the pan really did move the sprite', () => {
    // Without this, the assertion above passes on a `fitTerrain` that ignores its argument.
    const layers = new Layers();
    new Terrain(layers);
    fitTerrain(layers.terrain, view);
    const before = parts(layers).plane.x;
    fitTerrain(layers.terrain, { ...view, x: view.x + 137 });
    expect(parts(layers).plane.x).toBe(before + 137);
  });

  it('is idempotent — fitting the same view twice changes nothing', () => {
    const layers = new Layers();
    new Terrain(layers);
    fitTerrain(layers.terrain, view);
    const { plane } = parts(layers);
    const snap = [plane.x, plane.y, plane.width, plane.height, plane.tilePosition.x, plane.tilePosition.y];
    fitTerrain(layers.terrain, view);
    expect([plane.x, plane.y, plane.width, plane.height, plane.tilePosition.x, plane.tilePosition.y]).toEqual(snap);
  });

  it('survives an empty container, which is the state before the first room builds', () => {
    const layers = new Layers();
    expect(() => fitTerrain(layers.terrain, view)).not.toThrow();
  });
});

describe('Terrain — the draw-call budget it promises', () => {
  it('stays at two display objects however many rooms are built', () => {
    // The shape this guards against is the obvious wrong implementation: one plane per void
    // region, or per empty grid cell, rebuilt per room. `arena_launch` has 83 free wall sides and
    // twelve empty cells; a per-region plane would put dozens of blended full-size quads on
    // screen, which is exactly the per-primitive fragment cost the 2026-08-27 floor pass spent
    // three measurements removing.
    const layers = new Layers();
    const terrain = new Terrain(layers);
    for (let i = 0; i < 5; i++) terrain.setPalette(biomePalette(i % 2 ? 'ember' : undefined));
    expect(layers.terrain.children.length).toBe(2);
  });
});
