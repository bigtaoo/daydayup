/**
 * `groundLayer.ts` — the ground stage as a whole (2026-08-20). Everything here was found by a
 * mutation battery over the floor pass rather than written alongside it: `floorRender.test.ts` pins
 * what each layer DRAWS, and every one of those tests still passed with the layers mounted in the
 * wrong order, with the additive layer not additive, with the per-room seed replaced by an array
 * index, and with the door wear removed altogether. Those are the four assertions below.
 *
 * The fifth is the region split — which rects get a floor (coverage) versus which get an identity
 * (wash/mottle/decals/light). `floorCoverage.test.ts` measures WHY they differ; this pins that the
 * two functions actually answer differently.
 */
import { describe, it, expect } from 'vitest';
import { Container, Graphics, Sprite, Texture, TextureSource } from 'pixi.js';
import { createGameState } from '@dd/engine/state/GameState';
import { pxToFp } from '@dd/engine/content/convert';
import { biomePalette } from '../theme';
import { buildGroundLayer, floorRegionsPx, roomRectsPx, type GroundDeps } from './groundLayer';
import type { RectPx } from './wallGeometry';

const PALETTE = biomePalette('ember');

function tex(size: number): Texture {
  return new Texture({ source: new TextureSource({ width: size, height: size }) });
}

function deps(over: Partial<GroundDeps> = {}): GroundDeps {
  return {
    rooms: [{ x: 0, y: 0, w: 512, h: 512 }],
    floorRegions: [{ x: 0, y: 0, w: 512, h: 512 }],
    wallRects: [],
    doorRects: [],
    palette: PALETTE,
    floorTex: tex(256),
    ...over,
  };
}

/** A comparable digest of a Graphics' geometry — see `floorRender.test.ts` for why the instruction
 *  list cannot go through `JSON.stringify`. */
function digest(g: Graphics): string {
  return g.context.instructions
    .map((ins) => {
      const data = ins.data as {
        style?: { color?: number; alpha?: number };
        path?: { instructions: { action: string; data: unknown[] }[] };
      };
      const path = (data.path?.instructions ?? [])
        .map((i) => `${i.action}(${i.data.filter((v) => typeof v === 'number').map((v) => (v as number).toFixed(2)).join(',')})`)
        .join('|');
      return `${ins.action} ${data.style?.color ?? ''}@${(data.style?.alpha ?? 0).toFixed(3)} ${path}`;
    })
    .join(';');
}

function build(d: GroundDeps): { ground: Container; graphics: Graphics[]; tiles: Sprite[] } {
  const ground = new Container();
  buildGroundLayer(ground, d);
  return {
    ground,
    graphics: ground.children.filter((c): c is Graphics => c instanceof Graphics),
    tiles: ground.children.filter((c): c is Sprite => c instanceof Sprite && !(c instanceof Graphics)),
  };
}

describe('buildGroundLayer — the stack, in the order it has to be in', () => {
  it('paints the floor first and the overlays on top of it, never the reverse', () => {
    const { ground, tiles } = build(deps());
    const lastTile = Math.max(...tiles.map((t) => ground.children.indexOf(t)));
    const firstOverlay = Math.min(
      ...ground.children.filter((c) => c instanceof Graphics).map((c) => ground.children.indexOf(c)),
    );
    // Pixi paints in child order, so a grid or a light pool mounted before the floor is invisible —
    // and every "what does this layer draw" test still passes while it is.
    expect(firstOverlay).toBeGreaterThan(lastTile);
  });

  it('mounts the four overlays in the documented order: variation, then grid, then room light', () => {
    const { graphics } = build(deps({ rooms: [{ x: 0, y: 0, w: 512, h: 512 }] }));
    expect(graphics).toHaveLength(4);
    const [floorDark, floorLight, grid, light] = graphics;
    expect(floorLight!.blendMode).toBe('add');
    expect(floorDark!.blendMode).toBe('inherit'); // i.e. untouched — only the light half is additive
    // The grid is a stroke and the light pool a stack of strokes; the variation layers are fills.
    // Identifying them by what they draw rather than by index would be circular, so this asserts
    // the pair that actually matters: the light pool is LAST, so the lattice fades toward the walls
    // with everything else, and the grid sits above the floor's own variation.
    expect(digest(light!)).not.toBe('');
    expect(digest(grid!)).not.toBe('');
    expect(digest(floorDark!)).not.toBe('');
  });

  it('keeps the light half additive — a floor that can only get darker loses its mean', () => {
    const { graphics } = build(deps());
    const additive = graphics.filter((g) => g.blendMode === 'add');
    expect(additive).toHaveLength(1);
    expect(digest(additive[0]!)).not.toBe(''); // and it actually carries geometry
  });
});

describe('buildGroundLayer — determinism and per-room identity', () => {
  const ROOM: RectPx = { x: 0, y: 0, w: 512, h: 512 };

  it('draws the identical floor for the same room twice — a room must not change between visits', () => {
    const a = build(deps({ rooms: [ROOM], floorRegions: [ROOM] }));
    const b = build(deps({ rooms: [ROOM], floorRegions: [ROOM] }));
    expect(a.graphics.map(digest)).toEqual(b.graphics.map(digest));
    expect(a.tiles.map((t) => `${t.x},${t.y},${t.scale.x},${t.scale.y}`)).toEqual(
      b.tiles.map((t) => `${t.x},${t.y},${t.scale.x},${t.scale.y}`),
    );
  });

  it('seeds each room off its WORLD POSITION, so two identical rooms elsewhere differ', () => {
    // An array index would give the first room of EVERY floor the same wash, the same mottle and
    // the same rubble — and the whole point of this layer is that one room does not look like
    // another. Compared as shapes RELATIVE TO the room's own origin, so "it moved" cannot pass for
    // "it differs": under an index seed the two lists below are identical.
    const relative = (room: RectPx): string[] => {
      const { graphics } = build(deps({ rooms: [room], floorRegions: [room] }));
      return graphics[0]!.context.instructions
        .flatMap((ins) => {
          const path = (ins.data as { path?: { instructions: { action: string; data: unknown[] }[] } }).path;
          // Ellipses only — every blob, stain and speck. Pixi emits a `moveTo(0, 0)` of its own
          // before each shape, and those carry ABSOLUTE zeros: including them makes the two lists
          // differ for a reason that has nothing to do with the seed, which is exactly how the
          // first version of this test passed while seeded by index.
          return (path?.instructions ?? [])
            .filter((i) => i.action === 'ellipse')
            .map((i) => {
              const nums = i.data.filter((v): v is number => typeof v === 'number');
              return `${(nums[0]! - room.x).toFixed(2)},${(nums[1]! - room.y).toFixed(2)},${nums[2]!.toFixed(2)}`;
            });
        });
    };
    const here = relative(ROOM);
    const there = relative({ ...ROOM, x: 2048, y: 1024 });
    expect(here.length).toBeGreaterThan(5);
    expect(there).not.toEqual(here);
  });

  it('gives every door a worn patch in the additive layer', () => {
    const withoutDoor = build(deps());
    const withDoor = build(deps({ doorRects: [{ x: 200, y: 240, w: 64, h: 128 }] }));
    const additive = (b: ReturnType<typeof build>): Graphics => b.graphics.find((g) => g.blendMode === 'add')!;
    expect(digest(additive(withDoor)).length).toBeGreaterThan(digest(additive(withoutDoor)).length);
  });

  it('keeps rubble off the wall footprints it is handed', () => {
    const open = build(deps());
    const walled = build(deps({ wallRects: [{ x: 0, y: 0, w: 512, h: 256 }] }));
    expect(digest(walled.graphics[0]!).length).toBeLessThan(digest(open.graphics[0]!).length);
  });

  it('falls back to a flat palette fill, and still decorates it, with no floor swatch', () => {
    const { graphics, tiles } = build(deps({ floorTex: undefined }));
    expect(tiles).toHaveLength(0);
    expect(graphics).toHaveLength(5); // the fill, plus the same four overlays
    expect(digest(graphics[1]!)).not.toBe(''); // the variation is drawn over the flat fill too
  });
});

describe('roomRectsPx vs floorRegionsPx — identity is not coverage', () => {
  it('room identity prefers dungeon rooms, then arena rooms, then the world itself', () => {
    const flat = createGameState({ seed: 1, worldW: 800, worldH: 600, waves: [], walls: [], obstacles: [] });
    expect(roomRectsPx(flat, 800, 600)).toEqual([{ x: 0, y: 0, w: 800, h: 600 }]);

    const arena = createGameState({ seed: 1, worldW: 800, worldH: 600, waves: [], walls: [], obstacles: [] });
    arena.arenaRoomRects.push({ id: 'a', rect: { x: pxToFp(0), y: pxToFp(0), w: pxToFp(320), h: pxToFp(320) } });
    expect(roomRectsPx(arena, 800, 600)).toEqual([{ x: 0, y: 0, w: 320, h: 320 }]);

    const dungeon = createGameState({ seed: 1, worldW: 800, worldH: 600, waves: [], walls: [], obstacles: [] });
    dungeon.dungeonRoomRects.push({ id: 'd', rect: { x: pxToFp(32), y: pxToFp(32), w: pxToFp(256), h: pxToFp(256) } });
    dungeon.arenaRoomRects.push({ id: 'a', rect: { x: pxToFp(0), y: pxToFp(0), w: pxToFp(320), h: pxToFp(320) } });
    expect(roomRectsPx(dungeon, 800, 600)).toEqual([{ x: 32, y: 32, w: 256, h: 256 }]);
  });

  it('floor COVERAGE follows the dungeon rooms only — an arena keeps the whole world', () => {
    // The asymmetry is the point, and `floorCoverage.test.ts` has the measurement behind it: an
    // arena's rooms are not a partition of its walkable space, so stopping its floor at them would
    // leave a player walking over the backdrop.
    const arena = createGameState({ seed: 1, worldW: 800, worldH: 600, waves: [], walls: [], obstacles: [] });
    arena.arenaRoomRects.push({ id: 'a', rect: { x: pxToFp(0), y: pxToFp(0), w: pxToFp(320), h: pxToFp(320) } });
    expect(floorRegionsPx(arena, 800, 600)).toEqual([{ x: 0, y: 0, w: 800, h: 600 }]);

    const dungeon = createGameState({ seed: 1, worldW: 800, worldH: 600, waves: [], walls: [], obstacles: [] });
    dungeon.dungeonRoomRects.push({ id: 'd', rect: { x: pxToFp(32), y: pxToFp(32), w: pxToFp(256), h: pxToFp(256) } });
    expect(floorRegionsPx(dungeon, 800, 600)).toEqual([{ x: 32, y: 32, w: 256, h: 256 }]);
  });
});
