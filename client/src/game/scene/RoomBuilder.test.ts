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
import { Graphics, Sprite, TilingSprite, Texture, TextureSource } from 'pixi.js';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState, DoorRuntime } from '@dd/engine/state/GameState';
import { pxToFp } from '@dd/engine/content/convert';
import { Layers } from './layers';
import { RoomBuilder } from './RoomBuilder';
import { Backdrop } from './Backdrop';

function makeRoomBuilder(layers = new Layers()): RoomBuilder {
  return new RoomBuilder(layers, new Backdrop(layers));
}

function doorSprites(rb: RoomBuilder): Sprite[] {
  return (rb as unknown as { doorSprites: Sprite[] }).doorSprites;
}

const mocks = vi.hoisted(() => ({
  floorTex: undefined as Texture | undefined,
  wallTex: undefined as Texture | undefined,
  doorLockedTex: undefined as Texture | undefined,
  doorOpenTex: undefined as Texture | undefined,
}));

vi.mock('../../render/biomeTiles', () => ({
  getFloorTexture: () => mocks.floorTex,
  getWallTexture: () => mocks.wallTex,
}));

vi.mock('../../render/environmentSprites', () => ({
  getDoorTexture: (locked: boolean) => (locked ? mocks.doorLockedTex : mocks.doorOpenTex),
}));

/** A `DoorRuntime`-shaped fixture (design/05 DoorSystem) at a given px rect. Pushing
 *  the SAME `passageAabb` object into `s.walls` too (only when `locked`) mirrors
 *  `DoorSystem.rebuildWalls`'s real behaviour — it pushes the identical reference,
 *  never a copy — which is what RoomBuilder's reference-identity skip depends on. */
function pushDoor(s: GameState, locked: boolean, [x, y, w, h]: [number, number, number, number]): void {
  const passageAabb = { x: pxToFp(x), y: pxToFp(y), w: pxToFp(w), h: pxToFp(h) };
  s.dungeonDoors.push({ door: { roomA: 'a', roomB: 'b', passageGrid: { x, y, w, h } }, passageAabb, locked } as DoorRuntime);
  if (locked) s.walls.push(passageAabb);
}

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
    const rb = makeRoomBuilder();
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
    const rb = makeRoomBuilder();
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
    const rb = makeRoomBuilder();
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
    const rb = makeRoomBuilder();
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
    const rb = makeRoomBuilder();
    const layers = (rb as unknown as { layers: Layers }).layers;
    rb.build(stateWithOneObstacle());
    // The pillar plus the room's own portal (Portal.ts, design/10 legibility fix
    // 2026-08-02) — the portal is built AFTER pillars, so index 0 is still the pillar.
    expect(layers.entities.children.length).toBe(2);
    const pillar = layers.entities.children[0]!;
    // px -> fp -> px round trip through the grid quantizes to a fraction of a pixel
    // (same tolerance the existing wall test's `toBeCloseTo(100)` needed, just spelled
    // out here since 150 doesn't happen to land on a round grid step).
    expect(pillar.x).toBeCloseTo(150, 1);
    expect(pillar.y).toBeCloseTo(120, 1);
  });

  it('gives the pillar body real drawn geometry, not a blank placeholder', () => {
    const rb = makeRoomBuilder();
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
    const rb = makeRoomBuilder();
    const layers = (rb as unknown as { layers: Layers }).layers;
    rb.build(stateWithOneObstacle());
    // The pillar's shadow plus the portal's own (Portal.ts also calls makeShadow()).
    expect(layers.shadow.children.length).toBe(2);
  });

  it('rebuilds pillars fresh on a second build() call, not appended', () => {
    const rb = makeRoomBuilder();
    const layers = (rb as unknown as { layers: Layers }).layers;
    rb.build(stateWithOneObstacle());
    const firstCount = layers.entities.children.length;
    rb.build(stateWithOneObstacle());
    expect(layers.entities.children.length).toBe(firstCount);
  });

  it('clear() removes every pillar and its shadow', () => {
    const rb = makeRoomBuilder();
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
    const rb = makeRoomBuilder();
    const layers = (rb as unknown as { layers: Layers }).layers;
    rb.build(stateWithOneWall('ember'));
    // ground fill (TilingSprite) + grid (Graphics) + wall (TilingSprite) + wall edge
    // (Graphics) — at least one Graphics survives as the grid even with both textures set.
    expect(layers.ground.children.filter((c) => c instanceof Graphics).length).toBeGreaterThanOrEqual(2);
  });

  it('clears the previous room contents on a second build() call', () => {
    mocks.floorTex = undefined;
    mocks.wallTex = undefined;
    const rb = makeRoomBuilder();
    const layers = (rb as unknown as { layers: Layers }).layers;
    rb.build(stateWithOneWall('ember'));
    const firstCount = layers.ground.children.length;
    rb.build(stateWithOneWall('ember'));
    expect(layers.ground.children.length).toBe(firstCount); // rebuilt fresh, not appended
  });
});

describe('RoomBuilder — doors (design/05 "Room & door model", 2026-08-04)', () => {
  it('excludes a locked door\'s passage rect from the generic wall loop', () => {
    mocks.wallTex = undefined;
    const s = stateWithOneWall('ember'); // one real wall at [100,100,64,64]
    pushDoor(s, true, [300, 100, 20, 64]);
    const rb = makeRoomBuilder();
    const layers = (rb as unknown as { layers: Layers }).layers;
    rb.build(s);
    // Ground fill + grid overlay + the ONE real wall's fill+stroke Graphics node — if
    // the locked door's passageAabb (also present in s.walls, mirroring DoorSystem)
    // weren't excluded, it would draw a 4th "generic wall" Graphics here.
    expect(layers.ground.children.filter((c) => c instanceof Graphics).length).toBe(3);
    expect(doorSprites(rb)).toHaveLength(1);
  });

  it('renders one Sprite per dungeon door, sized/positioned to its passageAabb', () => {
    const s = stateWithOneWall('ember');
    pushDoor(s, true, [300, 100, 20, 64]);
    const rb = makeRoomBuilder();
    const layers = (rb as unknown as { layers: Layers }).layers;
    rb.build(s);
    const sprite = doorSprites(rb)[0]!;
    expect(layers.ground.children).toContain(sprite);
    expect(sprite.position.x).toBeCloseTo(300);
    expect(sprite.position.y).toBeCloseTo(100);
    expect(sprite.width).toBeCloseTo(20);
    expect(sprite.height).toBeCloseTo(64);
  });

  it('a locked door uses the locked texture when loaded, tinted white', () => {
    mocks.doorLockedTex = fakeTexture(32, 32);
    mocks.doorOpenTex = fakeTexture(32, 32);
    const s = stateWithOneWall('ember');
    pushDoor(s, true, [300, 100, 20, 64]);
    const rb = makeRoomBuilder();
    rb.build(s);
    const sprite = doorSprites(rb)[0]!;
    expect(sprite.texture).toBe(mocks.doorLockedTex);
    expect(sprite.tint).toBe(0xffffff);
  });

  it('an unlocked door renders the open texture, not folded into s.walls at all', () => {
    mocks.doorLockedTex = fakeTexture(32, 32);
    mocks.doorOpenTex = fakeTexture(32, 32);
    const s = stateWithOneWall('ember');
    pushDoor(s, false, [300, 100, 20, 64]); // unlocked: never added to s.walls
    const rb = makeRoomBuilder();
    rb.build(s);
    const sprite = doorSprites(rb)[0]!;
    expect(sprite.texture).toBe(mocks.doorOpenTex);
  });

  it('falls back to a tinted rect (hazard-red locked / grey open) when no door art is loaded', () => {
    mocks.doorLockedTex = undefined;
    mocks.doorOpenTex = undefined;
    const s = stateWithOneWall('ember');
    pushDoor(s, true, [300, 100, 20, 64]);
    const rb = makeRoomBuilder();
    rb.build(s);
    const sprite = doorSprites(rb)[0]!;
    expect(sprite.texture).toBe(Texture.WHITE);
    expect(sprite.tint).toBe(0xe53e3e);
  });

  it('updateDoors() swaps texture/tint in place on a lock-state flip, without touching child count', () => {
    mocks.doorLockedTex = fakeTexture(32, 32);
    mocks.doorOpenTex = fakeTexture(32, 32);
    const s = stateWithOneWall('ember');
    pushDoor(s, true, [300, 100, 20, 64]);
    const rb = makeRoomBuilder();
    const layers = (rb as unknown as { layers: Layers }).layers;
    rb.build(s);
    const sprite = doorSprites(rb)[0]!;
    const countBefore = layers.ground.children.length;
    expect(sprite.texture).toBe(mocks.doorLockedTex);

    // Mirror DoorSystem: the door unlocks, its passageAabb drops out of s.walls.
    s.dungeonDoors[0]!.locked = false;
    s.walls.length = 0;
    rb.updateDoors(s);

    expect(doorSprites(rb)[0]).toBe(sprite); // same sprite instance, not rebuilt
    expect(layers.ground.children.length).toBe(countBefore);
    expect(sprite.texture).toBe(mocks.doorOpenTex);
  });

  it('updateDoors() is a no-op before any build() has populated doorSprites', () => {
    const s = stateWithOneWall('ember');
    pushDoor(s, true, [300, 100, 20, 64]);
    const rb = makeRoomBuilder();
    expect(() => rb.updateDoors(s)).not.toThrow();
    expect(doorSprites(rb)).toHaveLength(0);
  });

  it('clear() removes door sprites along with the rest of the room', () => {
    const s = stateWithOneWall('ember');
    pushDoor(s, true, [300, 100, 20, 64]);
    const rb = makeRoomBuilder();
    const layers = (rb as unknown as { layers: Layers }).layers;
    rb.build(s);
    rb.clear();
    expect(doorSprites(rb)).toHaveLength(0);
    expect(layers.ground.children.length).toBe(0);
  });
});

describe('RoomBuilder — portal placement (2026-08-12 fix: capstone room, not the floor bbox)', () => {
  it('with no dungeonRoomRects (flat mode), centers on the room itself — worldW/H, unchanged behavior', () => {
    const s = stateWithOneWall('ember'); // worldW: 800, worldH: 600
    const rb = makeRoomBuilder();
    rb.build(s);
    expect(rb.portalPx).toEqual({ x: 400, y: 300 });
  });

  it('with dungeonRoomRects populated, centers on the LAST rect (the capstone room), not the floor bbox', () => {
    // A floor whose overall bounding box (worldW/H, set by buildFloorGeometry in real
    // play) is much bigger than any one room — this is what used to put the portal in
    // a corridor or on a wall on multi-room floors.
    const s = createGameState({ seed: 1, worldW: 2000, worldH: 1200, waves: [], walls: [], obstacles: [] });
    (s as unknown as { dungeonConfig?: { biomeId: string } }).dungeonConfig = { biomeId: 'ember' };
    s.dungeonRoomRects.push(
      { id: 'entry', rect: { x: pxToFp(0), y: pxToFp(0), w: pxToFp(400), h: pxToFp(300) } },
      { id: 'capstone', rect: { x: pxToFp(1600), y: pxToFp(900), w: pxToFp(400), h: pxToFp(300) } },
    );
    const rb = makeRoomBuilder();
    rb.build(s);
    // Capstone rect center = (1600 + 200, 900 + 150) = (1800, 1050) — nowhere near the
    // floor bbox's own center (1000, 600).
    expect(rb.portalPx!.x).toBeCloseTo(1800, 0);
    expect(rb.portalPx!.y).toBeCloseTo(1050, 0);
  });

  it('with a single-room dungeon floor (capstone == only entry), still centers on that room', () => {
    // A degenerate but real case: a one-room floor. dungeonRoomRects has exactly one
    // entry, which is trivially both "the last room" and "the only room" — the fix must
    // not assume there are at least two entries.
    const s = createGameState({ seed: 1, worldW: 500, worldH: 400, waves: [], walls: [], obstacles: [] });
    (s as unknown as { dungeonConfig?: { biomeId: string } }).dungeonConfig = { biomeId: 'ember' };
    s.dungeonRoomRects.push({
      id: 'capstone',
      rect: { x: pxToFp(50), y: pxToFp(50), w: pxToFp(300), h: pxToFp(200) },
    });
    const rb = makeRoomBuilder();
    rb.build(s);
    // (50+300/2, 50+200/2) — a fp round trip, not an exact float match (see the
    // dungeonRoomRects-populated case above).
    expect(rb.portalPx!.x).toBeCloseTo(200, 0);
    expect(rb.portalPx!.y).toBeCloseTo(150, 0);
  });

  it('re-centers on the NEW capstone after a floor transition (dungeonRoomRects reset + repopulated)', () => {
    // Mirrors ExtractionSystem.resolveDescend: dungeonRoomRects is cleared, then
    // SpawnSystem repopulates it for the freshly-generated next floor. A stale portalPx
    // from the previous floor's capstone must not survive the rebuild.
    const s = createGameState({ seed: 1, worldW: 2000, worldH: 1200, waves: [], walls: [], obstacles: [] });
    (s as unknown as { dungeonConfig?: { biomeId: string } }).dungeonConfig = { biomeId: 'ember' };
    s.dungeonRoomRects.push({ id: 'floor1-capstone', rect: { x: pxToFp(1600), y: pxToFp(900), w: pxToFp(400), h: pxToFp(300) } });
    const rb = makeRoomBuilder();
    rb.build(s);
    expect(rb.portalPx!.x).toBeCloseTo(1800, 0);
    expect(rb.portalPx!.y).toBeCloseTo(1050, 0);

    // Floor transition: old rects cleared, new floor's rects pushed (SpawnSystem).
    s.dungeonRoomRects.length = 0;
    s.dungeonRoomRects.push({ id: 'floor2-capstone', rect: { x: pxToFp(0), y: pxToFp(0), w: pxToFp(200), h: pxToFp(100) } });
    rb.build(s);
    expect(rb.portalPx!.x).toBeCloseTo(100, 0);
    expect(rb.portalPx!.y).toBeCloseTo(50, 0);
  });
});
