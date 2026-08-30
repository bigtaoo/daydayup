/// <reference types="node" />
/**
 * Does the 2026-08-30 open-door lighting actually fire on the SHIPPED content — and does every
 * branch of it occur there?
 *
 * `doorRender.test.ts` pins the state machine on two hand-built openings (a 64x104 perimeter and a
 * 128x22 kerb). Those are the right shapes, but they are shapes *this session chose*, and this repo
 * has shipped the resulting failure twice: `wallGeometry`'s old `w > h` guard left 1 wall standing
 * where 32 should because level-1's rooms are almost all `w <= h`, and `doorSpillCoverage.test.ts`
 * found a shallow-run case firing 12 times across the shipped floors that had been written off as
 * hypothetical. `doorStandCoverage.test.ts` exists for exactly this reason and this file is its
 * sibling: same pipeline (`placeAuthoredFloor` → `buildFloorGeometry` → `wallTier` → `mergeWallRuns`
 * → `doorFlankTier`), same five floors, but asking about the lights rather than the height.
 *
 * The specific way this pass could be vacuous: the light is sized off `doorLeafFrame`'s `drawH`,
 * not off the passage. If the shipped art and the shipped opening heights combined to make that a
 * few pixels on most doors, the fix would measure fine on the one door someone looked at and do
 * nothing on the rest — and no unit test built from a chosen rect could tell.
 *
 * `NO_JOINS` throughout, deliberately: joins only reach `blockCapTop`/`addCapLayers`/`addBlockEdge`,
 * i.e. the cap and the silhouette. None of the three light layers reads them, so threading the real
 * join set through would add a moving part that cannot change any assertion here.
 */
import { describe, it, expect } from 'vitest';
import { Graphics, Texture, TextureSource } from 'pixi.js';
import {
  buildFloorGeometry,
  EMBER_L1_FLOORS,
  EMBER_L1_ROOMS,
  placeAuthoredFloor,
  toFpAabbGrid,
  toFpGrid,
  type RoomPiece,
} from '@dd/engine';
import { fpToPx } from '../coords';
import { biomePalette } from '../theme';
import { buildDoorBlock, doorLeafFrame, drawSpill, drawThroughLight, type DoorSkin } from './doorRender';
import { wallHeight, wallTier, WALL_H_KERB, type RectPx, type WallTier } from './wallGeometry';
import { doorFlankTier, mergeWallRuns, type WallRun } from './wallRuns';

const FLOOR_INDICES = Object.keys(EMBER_L1_FLOORS).map(Number);

/** The shipped open-arch elevation's real size after the alpha trim (design/01: 215x320 → 156x224).
 *  The leaf art is what sets every light's height, so a fiction here would defeat the file. */
const OPEN_ART_W = 156;
const OPEN_ART_H = 224;

function tex(w: number, h: number): Texture {
  return new Texture({ source: new TextureSource({ width: w, height: h }) });
}

const skin = (): DoorSkin => ({
  palette: biomePalette('ember'),
  cap: tex(256, 256),
  face: tex(256, 128),
  leaf: tex(OPEN_ART_W, OPEN_ART_H),
});

interface FloorGeo {
  runs: WallRun[];
  doorRects: RectPx[];
}

/** One shipped floor converted exactly the way `RoomBuilder.build` converts it at runtime — lifted
 *  from `doorStandCoverage.test.ts`, which is the file that established this conversion is the real
 *  one rather than a plausible-looking approximation of it. */
function floorGeo(index: number): FloorGeo {
  const map = EMBER_L1_FLOORS[index]!;
  const { placed, doors } = placeAuthoredFloor(map, EMBER_L1_ROOMS as readonly RoomPiece[]);
  const geo = buildFloorGeometry(placed, doors);
  const roomsPx: RectPx[] = placed.map((r) => ({
    x: fpToPx(toFpGrid(r.offsetXGrid)),
    y: fpToPx(toFpGrid(r.offsetYGrid)),
    w: fpToPx(toFpGrid(r.piece.sizeGrid.w)),
    h: fpToPx(toFpGrid(r.piece.sizeGrid.h)),
  }));
  const doorRects: RectPx[] = doors.map((d) => {
    const aabb = toFpAabbGrid(d.passageGrid);
    return { x: fpToPx(aabb.x), y: fpToPx(aabb.y), w: fpToPx(aabb.w), h: fpToPx(aabb.h) };
  });
  const runs = mergeWallRuns(
    geo.walls.map((wall) => {
      const rect: RectPx = { x: fpToPx(wall.x), y: fpToPx(wall.y), w: fpToPx(wall.w), h: fpToPx(wall.h) };
      return { rect, tier: wallTier(rect, roomsPx) };
    }),
  );
  return { runs, doorRects };
}

/** Every shipped door as `(rect, height)` — the two arguments `buildDoorBlock` is called with. */
function shippedDoors(): { rect: RectPx; height: number; tier: WallTier }[] {
  const out: { rect: RectPx; height: number; tier: WallTier }[] = [];
  for (const index of FLOOR_INDICES) {
    const { runs, doorRects } = floorGeo(index);
    for (const rect of doorRects) {
      const tier = doorFlankTier(rect, runs) ?? wallTier(rect, []);
      out.push({ rect, height: wallHeight(tier), tier });
    }
  }
  return out;
}

const graphicsOf = (f: ReturnType<typeof buildDoorBlock>): Graphics[] =>
  f.view.children.filter((c): c is Graphics => c instanceof Graphics);

/** How much of a Graphics' drawn geometry there is, as a shape count — enough to tell "this layer
 *  ran" from "this layer produced nothing", which is the only distinction this file needs. */
function shapeCount(g: Graphics): number {
  return g.context.instructions.reduce((n, ins) => {
    const path = (ins.data as { path?: { instructions: unknown[] } }).path;
    return n + (path?.instructions.length ?? 0);
  }, 0);
}

/** The fixture's copy of one `draw*` layer, matched by redrawing it — see `doorRender.test.ts`,
 *  which documents why picking the first additive child silently tests the wrong one. */
function layerOf(
  fixture: ReturnType<typeof buildDoorBlock>,
  draw: (g: Graphics, w: number, h: number) => void,
  rect: RectPx,
  height: number,
): Graphics | undefined {
  const expected = new Graphics();
  draw(expected, rect.w, doorLeafFrame(rect.w, height, OPEN_ART_W, OPEN_ART_H).drawH);
  const want = styleDigest(expected);
  return graphicsOf(fixture).find((g) => styleDigest(g) === want);
}

/** Every fill's colour and alpha in draw order — enough to tell the fixture's three additive
 *  children apart without depending on which one happens to come first in the child list. */
function styleDigest(g: Graphics): string {
  return g.context.instructions
    .map((ins) => {
      const d = ins.data as { style?: { color?: number; alpha?: number } };
      return `${d.style?.color ?? ''}@${(d.style?.alpha ?? 0).toFixed(4)}`;
    })
    .join(';');
}

describe('the open-door lights on the real shipped floors', () => {
  it('sweeps every shipped door and finds all three layers alive on each', () => {
    const doors = shippedDoors();
    // The sweep means nothing if the pipeline handed back nothing to sweep.
    expect(doors.length).toBeGreaterThan(0);

    const tiers = new Map<WallTier, number>();
    for (const { rect, height, tier } of doors) {
      tiers.set(tier, (tiers.get(tier) ?? 0) + 1);
      const fixture = buildDoorBlock(rect, height, skin(), false);
      const through = layerOf(fixture, drawThroughLight, rect, height);
      const spill = layerOf(fixture, drawSpill, rect, height);
      expect(through, `through on ${rect.w}x${rect.h} @${height}`).toBeDefined();
      expect(spill, `spill on ${rect.w}x${rect.h} @${height}`).toBeDefined();
      expect(through!.visible).toBe(true);
      expect(spill!.visible).toBe(true);
      // Not just present — actually carrying geometry. A ramp that collapsed to zero bands on a
      // real opening would still be a child, still be visible, and still draw nothing.
      expect(shapeCount(through!)).toBeGreaterThan(4);
      expect(shapeCount(spill!)).toBeGreaterThan(4);
    }
    // Both branches occur, so neither is asserted vacuously. A kerb door is the case where the
    // through-light has almost no height to work with and the pool carries the whole cue; if the
    // shipped content had only perimeter doors, every kerb claim in this pass would be untested
    // here however many doors the loop walked.
    expect(tiers.get('perimeter') ?? 0).toBeGreaterThan(0);
    expect(tiers.get('kerb') ?? 0).toBeGreaterThan(0);
  });

  it('gives every shipped door a lit band tall enough to see, kerb doors included', () => {
    // The way this pass could have been vacuous: the light is sized off `doorLeafFrame`'s `drawH`,
    // not off the passage, so a shipped opening that cropped the art to a sliver would get a
    // sub-pixel ramp. Measured when written, over all 24 shipped doors: exactly two values, 13.2 px
    // on each of the 11 kerb doors and 55.1 px on each of the 13 perimeter ones.
    const seen: number[] = [];
    for (const { rect, height } of shippedDoors()) {
      const g = new Graphics();
      const drawH = doorLeafFrame(rect.w, height, OPEN_ART_W, OPEN_ART_H).drawH;
      drawThroughLight(g, rect.w, drawH);
      const tops = g.context.instructions.flatMap((ins) => {
        const path = (ins.data as { path?: { instructions: { action: string; data: unknown[] }[] } }).path;
        return (path?.instructions ?? [])
          .filter((i) => i.action === 'rect')
          .map((i) => (i.data as number[])[1]!);
      });
      const reach = -Math.min(...tops);
      expect(reach).toBeGreaterThanOrEqual(10); // never a hairline, on any shipped opening
      expect(reach).toBeLessThan(drawH); // ...and never a wash over the whole thing
      seen.push(reach);
    }
    // A kerb opening really is the small end of that range, i.e. the bound above is not slack.
    expect(Math.min(...seen)).toBeLessThan(WALL_H_KERB);
  });

  it('keeps exactly one state lit on every shipped door, in both states', () => {
    for (const { rect, height } of shippedDoors()) {
      for (const locked of [true, false]) {
        const fixture = buildDoorBlock(rect, height, skin(), locked);
        const live = graphicsOf(fixture).filter((g) => g.blendMode === 'add' && g.visible);
        expect(live).toHaveLength(locked ? 1 : 2);
      }
    }
  });
});
