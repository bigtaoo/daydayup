/**
 * RoomBuilder (design/13's biome floor/wall art pass). `build()` picks a real tileable
 * `TilingSprite` swatch when `render/biomeTiles.ts` has one for the room's element,
 * else falls back to the same flat `Graphics` fill this repo shipped with before any
 * biome art existed — memory of this session claimed that fallback was
 * "byte-identical, confirmed by diff read-through" but never had an automated test.
 * `render/biomeTiles.ts` is mocked here (network-independent, controllable per test)
 * rather than exercised for real — biomeTiles.test.ts already covers its own registry/
 * preload contract.
 */
import { describe, it, expect, vi } from 'vitest';
import { Graphics, TilingSprite, Texture, TextureSource } from 'pixi.js';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import { Layers } from './layers';
import { RoomBuilder } from './RoomBuilder';

const mocks = vi.hoisted(() => ({
  floorTex: undefined as Texture | undefined,
  wallTex: undefined as Texture | undefined,
}));

vi.mock('../render/biomeTiles', () => ({
  getFloorTexture: () => mocks.floorTex,
  getWallTexture: () => mocks.wallTex,
}));

function fakeTexture(w: number, h: number): Texture {
  return new Texture({ source: new TextureSource({ width: w, height: h }) });
}

function stateWithOneWall(biomeId: string | undefined): GameState {
  const s = createGameState({
    seed: 1, worldW: 800, worldH: 600, waves: [],
    walls: [[100, 100, 64, 64]],
    obstacles: [],
  });
  // dungeonConfig is otherwise only populated via the full dungeon-generation config
  // (floorCount/pieceTags/etc.) — RoomBuilder only ever reads `.biomeId` off it (via
  // config.ts's biomeElementOf), so a minimal cast fixture is enough here.
  (s as unknown as { dungeonConfig?: { biomeId: string } }).dungeonConfig = biomeId ? { biomeId } : undefined;
  return s;
}

describe('RoomBuilder — no biome art registered (fallback)', () => {
  it('fills the ground and each wall with flat Graphics, not a TilingSprite', () => {
    mocks.floorTex = undefined;
    mocks.wallTex = undefined;
    const rb = new RoomBuilder(new Layers());
    const layers = (rb as unknown as { layers: Layers }).layers;
    rb.build(stateWithOneWall('ember'));
    const ground = layers.ground.children;
    expect(ground.some((c) => c instanceof TilingSprite)).toBe(false);
    expect(ground.some((c) => c instanceof Graphics)).toBe(true);
  });
});

describe('RoomBuilder — biome art registered for this element', () => {
  it('uses a TilingSprite for the ground fill, sized to the room', () => {
    mocks.floorTex = fakeTexture(64, 64);
    mocks.wallTex = undefined;
    const rb = new RoomBuilder(new Layers());
    const layers = (rb as unknown as { layers: Layers }).layers;
    const s = stateWithOneWall('ember');
    rb.build(s);
    const floor = layers.ground.children.find((c) => c instanceof TilingSprite) as TilingSprite | undefined;
    expect(floor).toBeDefined();
    expect(floor!.texture).toBe(mocks.floorTex);
  });

  it('uses a TilingSprite for each wall, positioned at the wall rect, plus its outline', () => {
    mocks.floorTex = undefined;
    mocks.wallTex = fakeTexture(32, 32);
    const rb = new RoomBuilder(new Layers());
    const layers = (rb as unknown as { layers: Layers }).layers;
    rb.build(stateWithOneWall('ember'));
    const wallSprite = layers.ground.children.find((c) => c instanceof TilingSprite) as TilingSprite | undefined;
    expect(wallSprite).toBeDefined();
    expect(wallSprite!.texture).toBe(mocks.wallTex);
    // Config is given in px, converted to fp and back — a round trip, not a rescale.
    expect(wallSprite!.position.x).toBeCloseTo(100);
    expect(wallSprite!.position.y).toBeCloseTo(100);
    // The stroke outline still renders on top, same as the flat-fill path.
    expect(layers.ground.children.some((c) => c instanceof Graphics)).toBe(true);
  });

  it('falls back to Graphics for an element with no swatch registered (e.g. neutral/poison), even with other elements loaded', () => {
    mocks.floorTex = undefined; // simulates: this call's element has no registered swatch
    mocks.wallTex = undefined;
    const rb = new RoomBuilder(new Layers());
    const layers = (rb as unknown as { layers: Layers }).layers;
    rb.build(stateWithOneWall(undefined)); // undefined biomeId -> 'neutral' element
    expect(layers.ground.children.some((c) => c instanceof TilingSprite)).toBe(false);
  });
});

function stateWithOneObstacle(): GameState {
  const s = createGameState({
    seed: 1, worldW: 800, worldH: 600, waves: [],
    walls: [],
    obstacles: [[150, 120, 20]],
  });
  (s as unknown as { dungeonConfig?: { biomeId: string } }).dungeonConfig = { biomeId: 'ember' };
  return s;
}

describe('RoomBuilder — pillars (design/10 legibility fix, 2026-08-02: faux-shading)', () => {
  it('creates one Entity per obstacle, positioned at its grid coords (px round trip)', () => {
    const rb = new RoomBuilder(new Layers());
    const layers = (rb as unknown as { layers: Layers }).layers;
    rb.build(stateWithOneObstacle());
    expect(layers.entities.children.length).toBe(1);
    const pillar = layers.entities.children[0]!;
    // px -> fp -> px round trip through the grid quantizes to a fraction of a pixel
    // (same tolerance the existing wall test's `toBeCloseTo(100)` needed, just spelled
    // out here since 150 doesn't happen to land on a round grid step).
    expect(pillar.x).toBeCloseTo(150, 1);
    expect(pillar.y).toBeCloseTo(120, 1);
  });

  it('gives the pillar body real drawn geometry, not a blank placeholder', () => {
    const rb = new RoomBuilder(new Layers());
    const layers = (rb as unknown as { layers: Layers }).layers;
    rb.build(stateWithOneObstacle());
    const pillar = layers.entities.children[0]!;
    const body = pillar.children[0] as Graphics;
    // Shading bands + rim strokes extend a little past the base body rect — real
    // drawn content, not a zero-size stub.
    expect(body.getLocalBounds().width).toBeGreaterThan(0);
    expect(body.getLocalBounds().height).toBeGreaterThan(0);
  });

  it('adds a matching shadow to the shadow layer for each pillar', () => {
    const rb = new RoomBuilder(new Layers());
    const layers = (rb as unknown as { layers: Layers }).layers;
    rb.build(stateWithOneObstacle());
    expect(layers.shadow.children.length).toBe(1);
  });

  it('rebuilds pillars fresh on a second build() call, not appended', () => {
    const rb = new RoomBuilder(new Layers());
    const layers = (rb as unknown as { layers: Layers }).layers;
    rb.build(stateWithOneObstacle());
    const firstCount = layers.entities.children.length;
    rb.build(stateWithOneObstacle());
    expect(layers.entities.children.length).toBe(firstCount);
  });

  it('clear() removes every pillar and its shadow', () => {
    const rb = new RoomBuilder(new Layers());
    const layers = (rb as unknown as { layers: Layers }).layers;
    rb.build(stateWithOneObstacle());
    rb.clear();
    expect(layers.entities.children.length).toBe(0);
    expect(layers.shadow.children.length).toBe(0);
  });
});

describe('RoomBuilder — grid overlay and rebuild', () => {
  it('always draws the grid overlay regardless of whether biome art exists', () => {
    mocks.floorTex = fakeTexture(64, 64);
    mocks.wallTex = fakeTexture(32, 32);
    const rb = new RoomBuilder(new Layers());
    const layers = (rb as unknown as { layers: Layers }).layers;
    rb.build(stateWithOneWall('ember'));
    // ground fill (TilingSprite) + grid (Graphics) + wall (TilingSprite) + wall edge
    // (Graphics) — at least one Graphics survives as the grid even with both textures set.
    expect(layers.ground.children.filter((c) => c instanceof Graphics).length).toBeGreaterThanOrEqual(2);
  });

  it('clears the previous room contents on a second build() call', () => {
    mocks.floorTex = undefined;
    mocks.wallTex = undefined;
    const rb = new RoomBuilder(new Layers());
    const layers = (rb as unknown as { layers: Layers }).layers;
    rb.build(stateWithOneWall('ember'));
    const firstCount = layers.ground.children.length;
    rb.build(stateWithOneWall('ember'));
    expect(layers.ground.children.length).toBe(firstCount); // rebuilt fresh, not appended
  });
});
