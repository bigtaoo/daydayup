// Split out of RoomBuilder 2026-08-20 (500-line convention, CLAUDE.md form ① — a set of
// independent functions over rects with no shared private state): everything painted on
// `layers.ground`, i.e. the floor itself and the four flat overlays on it. The walls, doors,
// pillars and the portal all stand on `layers.entities` and stay in RoomBuilder, which owns their
// lifetimes; nothing here needs to be remembered between builds, because `build()` destroys the
// whole ground layer and repaints it.
//
// The stack, bottom to top, and why it is in this order:
//
//   1. the floor — a stamped swatch, or a flat palette fill where no swatch exists (`floorRender`);
//   2. the floor's own variation — per-room wash, mottle, stains, rubble, door wear, half of it in
//      an additive Graphics because Pixi fills only multiply down and a floor that can only get
//      darker loses its mean (`floorRender`);
//   3. the 64 px grid — a readability aid, kept at `GRID_ALPHA` since 2026-08-18 because a
//      full-strength lattice is the loudest "this is a top-down blueprint" cue in the frame;
//   4. the per-room light pool (`roomLight`) — painted last of the four so the lattice fades toward
//      the walls with everything else.
import { Container, Graphics, type Texture } from 'pixi.js';
import type { AABB, GameState } from '@dd/engine';
import type { BiomePalette } from '../theme';
import { fpToPx } from '../coords';
import type { RectPx } from './wallGeometry';
import { drawDoorWear, drawFloorDecals, drawFloorMottle, drawRoomWash, hash2, stampFloor } from './floorRender';
import { drawRoomLight } from './roomLight';

/** Opacity of the 64 px floor grid. See the module header for why it is this low. */
const GRID_ALPHA = 0.12;
const GRID_STEP = 64;
/** Tile scale the mottle is sized against when no floor swatch is loaded at all. */
const FALLBACK_TILE = 256;

/** Everything the ground stage needs, all of it already computed by `RoomBuilder.build` for the
 *  wall pass — `rooms` for identity (wash/mottle/decals/light), `floorRegions` for coverage (see
 *  `floorRegionsPx`), `wallRects` to keep rubble off a wall's own footprint, `doorRects` for the
 *  worn patch across each doorway. */
export interface GroundDeps {
  rooms: readonly RectPx[];
  floorRegions: readonly RectPx[];
  wallRects: readonly RectPx[];
  doorRects: readonly RectPx[];
  palette: BiomePalette;
  floorTex: Texture | undefined;
}

/**
 * Paint the whole ground layer for the currently loaded floor. `ground` is expected to be empty
 * (RoomBuilder destroys its children first).
 *
 * Each room's variation is seeded off its own world POSITION rather than its index, so a room draws
 * the identical floor on every visit and on every client — design/06's determinism rule applied to
 * the render layer, the same way `Pickup`'s bob phase is a golden angle times its entity id.
 */
export function buildGroundLayer(ground: Container, deps: GroundDeps): void {
  const { rooms, floorRegions, wallRects, doorRects, palette, floorTex } = deps;

  if (floorTex) {
    for (const region of floorRegions) {
      for (const tile of stampFloor(floorTex, region)) ground.addChild(tile);
    }
  } else {
    const fill = new Graphics();
    for (const r of floorRegions) fill.rect(r.x, r.y, r.w, r.h).fill({ color: palette.ground });
    ground.addChild(fill);
  }

  const floorDark = new Graphics();
  const floorLight = new Graphics();
  floorLight.blendMode = 'add';
  const tileSize = floorTex?.width ?? FALLBACK_TILE;
  for (const room of rooms) {
    const seed = hash2(Math.round(room.x), Math.round(room.y)) >>> 8;
    drawRoomWash(floorDark, room, seed);
    drawFloorMottle(floorDark, floorLight, room, seed, tileSize);
    drawFloorDecals(floorDark, floorLight, room, seed, wallRects);
  }
  for (const door of doorRects) drawDoorWear(floorLight, door);
  ground.addChild(floorDark, floorLight);

  const grid = new Graphics();
  for (const r of floorRegions) {
    const x1 = r.x + r.w;
    const y1 = r.y + r.h;
    for (let x = Math.ceil(r.x / GRID_STEP) * GRID_STEP; x <= x1; x += GRID_STEP) grid.moveTo(x, r.y).lineTo(x, y1);
    for (let y = Math.ceil(r.y / GRID_STEP) * GRID_STEP; y <= y1; y += GRID_STEP) grid.moveTo(r.x, y).lineTo(x1, y);
  }
  grid.stroke({ color: palette.gridLine, width: 1, alpha: GRID_ALPHA });
  ground.addChild(grid);

  const light = new Graphics();
  for (const room of rooms) drawRoomLight(light, room);
  ground.addChild(light);
}

/** The floor's room footprints in world px — room IDENTITY (which rooms get their own wash, mottle,
 *  decals and light pool) and the input to `wallGeometry.wallTier`. Dungeon floors and the PvP arena
 *  each keep their own list; a flat `EngineConfig.floors` run populates neither, so the world itself
 *  stands in as the single room (identical answer for a one-room world). */
export function roomRectsPx(s: GameState, w: number, h: number): RectPx[] {
  const src = s.dungeonRoomRects.length > 0 ? s.dungeonRoomRects : s.arenaRoomRects;
  if (src.length === 0) return [{ x: 0, y: 0, w, h }];
  return src.map(({ rect }) => toPx(rect));
}

/**
 * Where the FLOOR is actually painted (the stamp and the grid) — a different question from
 * `roomRectsPx`, and the difference is measured (`floorCoverage.test.ts`):
 *
 * - A PvE dungeon floor's rooms ARE its walkable space. `buildFloorGeometry` walls every room edge
 *   and a door passage always straddles two adjacent room rects, so the floor can stop at the rooms
 *   — and it should, since the world's BOUNDING BOX is 1.41-2.26x their own area on the five shipped
 *   floors (29-56% of the old floor was painted where no room exists at all).
 * - A PvP ARENA's rooms are NOT a partition of its walkable space. Swept over the shipped
 *   `arena_prototype_60`: 5240 of its 11,524 non-wall grid cells (45%) are reachable and fall
 *   outside every room rect AND every door passage, with nothing walling them off — so a per-room
 *   floor there would leave a player walking over the backdrop. The arena keeps the whole-world
 *   floor it always had, and its 60 rooms still get their own wash/mottle/light on top of it.
 */
export function floorRegionsPx(s: GameState, w: number, h: number): RectPx[] {
  if (s.dungeonRoomRects.length === 0) return [{ x: 0, y: 0, w, h }];
  return s.dungeonRoomRects.map(({ rect }) => toPx(rect));
}

function toPx(rect: AABB): RectPx {
  return { x: fpToPx(rect.x), y: fpToPx(rect.y), w: fpToPx(rect.w), h: fpToPx(rect.h) };
}
