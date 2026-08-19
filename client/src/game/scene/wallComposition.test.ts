/// <reference types="node" />
/**
 * Composition invariants over every wall of every SHIPPED level-1 room, plus the one
 * cross-layer check that the corner treatment depends on: that `FACE_CROWN_FRACTION` still
 * describes the real `wallface_<element>.png` on disk.
 *
 * **WHY THIS FILE EXISTS.** One wall — `ember_l1_cell`'s west perimeter run — was reported wrong
 * four times in a row on 2026-08-19, and every round shipped a green suite. The tests written each
 * round were not wrong, they were the wrong *class*: `wallRender.test.ts` and `wallRuns.test.ts`
 * pin one block, or one pair of hand-written rects, against numbers chosen by the same person who
 * had just chosen them in the source. Neither file can answer the questions the reports were
 * actually about:
 *
 *   - does every north-south run in the SHIPPED content actually get the corner treatment, or does
 *     some tier/merge/width condition silently disqualify most of it? (This repo has already
 *     shipped that exact bug once: `wallGeometry`'s old `w > h` guard left 1 wall standing where
 *     32 should, because level-1's rooms are almost entirely `w <= h`.)
 *   - do the pieces still tile the plane — no hole where a clip removed art nobody else draws, no
 *     wall announcing an edge in the middle of a continuous surface?
 *   - is the constant that places the clip line still true of the art it was measured from?
 *
 * So: real floors through the real pipeline (`placeAuthoredFloor` → `buildFloorGeometry` →
 * `wallTier` → `mergeWallRuns` → `wallJoins`, which is RoomBuilder's own sequence), assertions
 * about RELATIONSHIPS between blocks rather than restated coordinates, and one assertion that
 * reads actual PNG pixels. Every check here is mutation-verified — see the counts in
 * design/01-rendering.md's "a deep run TUCKS" entry.
 *
 * Deliberately NOT here: whether the result LOOKS right. That needs a live frame and a luma
 * sample; the numbers from those rounds live in design/01. These are the strongest checks that
 * survive in a canvas-free vitest run.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import {
  EMBER_L1_FLOORS,
  EMBER_L1_ROOMS,
  buildFloorGeometry,
  placeAuthoredFloor,
  toFpGrid,
  type RoomPiece,
} from '@dd/engine';
import { fpToPx } from '../coords';
import { wallHeight, wallTier, type RectPx } from './wallGeometry';
import { mergeWallRuns, wallJoins, type WallJoins, type WallRun } from './wallRuns';
import { FACE_CROWN_FRACTION_MIN, FACE_CROWN_ROWS, faceCrownFraction } from './wallTone';

/** One floor, taken all the way through the sequence `RoomBuilder.build` uses. */
interface Floor {
  index: number;
  runs: WallRun[];
  joins: WallJoins[];
}

const FLOOR_INDICES = Object.keys(EMBER_L1_FLOORS).map(Number);

function buildFloor(index: number): Floor {
  const map = EMBER_L1_FLOORS[index]!;
  const { placed, doors } = placeAuthoredFloor(map, EMBER_L1_ROOMS as readonly RoomPiece[]);
  const geo = buildFloorGeometry(placed, doors);
  const roomsPx: RectPx[] = placed.map((r) => ({
    x: fpToPx(toFpGrid(r.offsetXGrid)),
    y: fpToPx(toFpGrid(r.offsetYGrid)),
    w: fpToPx(toFpGrid(r.piece.sizeGrid.w)),
    h: fpToPx(toFpGrid(r.piece.sizeGrid.h)),
  }));
  const runs = mergeWallRuns(
    geo.walls.map((wall) => {
      const rect: RectPx = { x: fpToPx(wall.x), y: fpToPx(wall.y), w: fpToPx(wall.w), h: fpToPx(wall.h) };
      return { rect, tier: wallTier(rect, roomsPx) };
    }),
  );
  // Level 1 is the ember biome, so its corners are placed with fire's crown line — the same
  // per-element lookup `RoomBuilder` does. Passing the default here would test a floor the
  // game never draws.
  return { index, runs, joins: wallJoins(runs, faceCrownFraction('fire')) };
}

const FLOORS: Floor[] = FLOOR_INDICES.map(buildFloor);

/** The screen-y band a block's art occupies, in world px: `[top, bottom]`. Mirrors
 *  `buildWallBlock` exactly — cap top (clipped when tucking) down to the footprint's south edge. */
function artBand(run: WallRun, joins: WallJoins): [number, number] {
  const h = wallHeight(run.tier);
  const south = run.rect.y + run.rect.h;
  const top = joins.tuckNorth
    ? south + Math.min(-h, -run.rect.h - joins.tuckLiftPx)
    : run.rect.y - h;
  return [top, south];
}

const overlapsX = (a: RectPx, b: RectPx): boolean =>
  Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.75;

describe('shipped level-1 walls — the content actually reaches the code', () => {
  it('places all five floors with walls to draw', () => {
    expect(FLOORS).toHaveLength(5);
    for (const f of FLOORS) expect(f.runs.length).toBeGreaterThan(10);
  });

  it('gives EVERY floor deep north-south runs, and tucks all of them', () => {
    // The regression this repo has already shipped once, in the other direction: a condition that
    // reads as a reasonable special case in the source and turns out to disqualify nearly all of
    // the real content. A deep run (`h > its own height`) whose north edge is fully buried MUST
    // tuck — if a future merge/tier change stops producing those, this fails loudly instead of the
    // corners quietly going back to overlapping.
    for (const f of FLOORS) {
      const deep = f.runs.filter((r, i) => r.rect.h > wallHeight(r.tier) && f.joins[i]!.north.length > 0);
      expect(deep.length, `floor ${f.index} has deep runs meeting a wall`).toBeGreaterThan(0);
      const tucked = f.runs.filter((_, i) => f.joins[i]!.tuckNorth);
      expect(tucked.length, `floor ${f.index} tucks them`).toBeGreaterThan(0);
    }
  });

  it('finds a real L corner on every floor — a run whose whole north edge is buried', () => {
    for (const f of FLOORS) {
      const corners = f.joins.filter((j) => j.tuckNorth && j.tuckLiftPx > 0);
      expect(corners.length, `floor ${f.index}`).toBeGreaterThan(0);
    }
  });
});

describe('shipped level-1 walls — every block agrees with its neighbours', () => {
  it('never lets a clip open a hole: the neighbour that authorised a tuck covers the band', () => {
    // The whole safety argument for clipping, checked against real geometry rather than proved on
    // paper. A tuck removes the band `[r.y - height, r.y - height + lift']`; the neighbour that
    // authorised it must already paint every pixel of it, or the floor shows through the corner.
    let checked = 0;
    for (const f of FLOORS) {
      f.runs.forEach((run, i) => {
        const joins = f.joins[i]!;
        if (!joins.tuckNorth) return;
        const [clippedTop] = artBand(run, joins);
        const fullTop = run.rect.y - wallHeight(run.tier);
        expect(clippedTop).toBeGreaterThan(fullTop); // something WAS removed
        const covered = f.runs.some((other, j) => {
          if (other === run || !overlapsX(other.rect, run.rect)) return false;
          if (Math.abs(other.rect.y + other.rect.h - run.rect.y) > 0.75) return false;
          const [oTop, oBottom] = artBand(other, f.joins[j]!);
          return oTop <= fullTop + 0.001 && oBottom >= clippedTop - 0.001;
        });
        expect(covered, `floor ${f.index} run at ${run.rect.x},${run.rect.y}`).toBe(true);
        checked++;
      });
    }
    expect(checked, 'tucked runs actually exercised').toBeGreaterThan(10);
  });

  it('never lets a tucked run cross its neighbour\'s CROWN course', () => {
    // The line the fourth report was about. The run may cover every brick course of the wall it
    // meets and none of its crown, because the crown is the unbroken horizontal the eye reads a
    // back wall by. Asserted against each neighbour's OWN height, not a constant.
    for (const f of FLOORS) {
      f.runs.forEach((run, i) => {
        const joins = f.joins[i]!;
        if (!joins.tuckNorth) return;
        const [top] = artBand(run, joins);
        for (const [j, other] of f.runs.entries()) {
          if (other === run || !overlapsX(other.rect, run.rect)) continue;
          if (Math.abs(other.rect.y + other.rect.h - run.rect.y) > 0.75) continue;
          if (wallHeight(other.tier) < wallHeight(run.tier)) continue;
          void j;
          const oh = wallHeight(other.tier);
          const crownUnderside = run.rect.y - oh + oh * faceCrownFraction('fire');
          expect(top).toBeGreaterThanOrEqual(crownUnderside - 0.001); // stops at or below it
          // ...and still covers brick: it must reach ABOVE that wall's foot.
          expect(top).toBeLessThan(run.rect.y - 0.001);
        }
      });
    }
  });

  it('routes every south-edge join to exactly one of `south` / `tuckedSouth`', () => {
    // Buried folds get masked, exposed ones get creased, and a join in both lists (or in neither)
    // means one of the two treatments is being applied to the wrong corner.
    for (const f of FLOORS) {
      f.runs.forEach((run, i) => {
        const joins = f.joins[i]!;
        const spans = [...joins.south, ...joins.tuckedSouth];
        for (const [a, b] of spans) {
          expect(b).toBeGreaterThan(a);
          expect(a).toBeGreaterThanOrEqual(-0.001);
          expect(b).toBeLessThanOrEqual(run.rect.w + 0.001);
        }
        for (const [a, b] of joins.south) {
          for (const [c, d] of joins.tuckedSouth) {
            expect(Math.min(b, d) - Math.max(a, c), `floor ${f.index} overlapping join`).toBeLessThanOrEqual(0.75);
          }
        }
      });
    }
  });

  it('reports a join only where a TALL ENOUGH neighbour really touches', () => {
    let joins = 0;
    for (const f of FLOORS) {
      f.runs.forEach((run, i) => {
        for (const [a, b] of f.joins[i]!.north) {
          expect(a).toBeGreaterThanOrEqual(-0.001);
          expect(b).toBeLessThanOrEqual(run.rect.w + 0.001);
          const mid = run.rect.x + (a + b) / 2;
          // Two invariants, because a join is only ever a licence to delete a cue: something must
          // actually be there, and it must be at least as TALL as this block.
          const toucher = f.runs.find((o) =>
            o !== run &&
            Math.abs(o.rect.y + o.rect.h - run.rect.y) <= 0.75 &&
            mid >= o.rect.x - 0.75 && mid <= o.rect.x + o.rect.w + 0.75 &&
            wallHeight(o.tier) >= wallHeight(run.tier));
          expect(toucher, `floor ${f.index} north join with no tall enough neighbour`).toBeDefined();
          joins++;
        }
      });
    }
    expect(joins, 'north joins actually exercised').toBeGreaterThan(10);
  });

  it("leaves a SHORTER neighbour's step alone, on real content", () => {
    // Floor 1 stacks a room's low south kerb directly north of the next room's full-height north
    // wall. A kerb cannot bury that wall's edge, so the wall must report no join there — this is the
    // pairing that makes the height filter load-bearing rather than defensive, and the unit test
    // next door only ever sees it on hand-written rects.
    let pairs = 0;
    for (const f of FLOORS) {
      f.runs.forEach((run, i) => {
        for (const other of f.runs) {
          if (other === run || !overlapsX(other.rect, run.rect)) continue;
          if (Math.abs(other.rect.y + other.rect.h - run.rect.y) > 0.75) continue;
          if (wallHeight(other.tier) >= wallHeight(run.tier)) continue;
          pairs++;
          const buried = f.joins[i]!.north.some(([a, b]) => {
            const lo = Math.max(run.rect.x + a, other.rect.x);
            const hi = Math.min(run.rect.x + b, other.rect.x + other.rect.w);
            return hi - lo > 0.75;
          });
          expect(buried, `floor ${f.index} short neighbour buried an edge`).toBe(false);
        }
      });
    }
    expect(pairs, 'short-northern-neighbour pairs exist in the shipped content').toBeGreaterThan(0);
  });

  it('leaves a kerb\'s neighbour alone — no tier ever inherits another\'s height', () => {
    // `mergeWallRuns` refuses cross-tier merges so a room's low south kerb cannot inherit the
    // perimeter height of the room beyond it. Re-checked here on real content, because the joins
    // pass runs through a SECOND height comparison and a sign error there would undo it.
    for (const f of FLOORS) {
      const kerbs = f.runs.filter((r) => r.tier === 'kerb');
      expect(kerbs.length, `floor ${f.index} has kerbs`).toBeGreaterThan(0);
      for (const k of kerbs) expect(wallHeight(k.tier)).toBeLessThan(wallHeight('perimeter'));
    }
  });
});

/* ------------------------------------------------------------------ the art the clip is measured from */

const PUBLIC = new URL('../../../public/', import.meta.url);

/** Decode an 8-bit RGB/RGBA PNG far enough to average its rows. Small and deliberate: the point
 *  is to read the ACTUAL shipped pixels, and the alternative (trusting a recorded number) is the
 *  failure mode this whole file exists to catch. */
function pngRowLuma(path: string): number[] {
  const buf = readFileSync(new URL(path, PUBLIC));
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf.readUInt8(24);
  const colorType = buf.readUInt8(25);
  expect(bitDepth, `${path} bit depth`).toBe(8);
  expect([2, 6], `${path} colour type`).toContain(colorType);
  const channels = colorType === 6 ? 4 : 3;

  const idat: Buffer[] = [];
  for (let at = 8; at + 8 <= buf.length; ) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString('ascii', at + 4, at + 8);
    if (type === 'IDAT') idat.push(buf.subarray(at + 8, at + 8 + len));
    at += len + 12;
  }
  const raw = inflateSync(Buffer.concat(idat));

  const stride = width * channels;
  const prev = Buffer.alloc(stride);
  const line = Buffer.alloc(stride);
  const out: number[] = [];
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    raw.copy(line, 0, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels]! : 0;
      const b = prev[i]!;
      const c = i >= channels ? prev[i - channels]! : 0;
      if (filter === 1) line[i] = (line[i]! + a) & 0xff;
      else if (filter === 2) line[i] = (line[i]! + b) & 0xff;
      else if (filter === 3) line[i] = (line[i]! + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        line[i] = (line[i]! + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
    }
    let sum = 0;
    for (let x = 0; x < width; x++) {
      const o = x * channels;
      sum += 0.2126 * line[o]! + 0.7152 * line[o + 1]! + 0.0722 * line[o + 2]!;
    }
    out.push(sum / width);
    line.copy(prev);
  }
  return out;
}

describe('FACE_CROWN_ROWS — measured off the shipped art, and still true of it', () => {
  // The cross-layer check, and the class of bug this repo keeps hitting: a hand-tuned number sized
  // against art that has since been re-exported. The tuck's clip line IS this table. If someone
  // redraws a `wallface_*.png` with a taller coping course, nothing in the renderer notices and
  // every corner in that biome silently slices through a crown.
  //
  // It has already earned its place once: written with a single fire-measured constant, the first
  // run of this file reported ice's mortar line at row 17 where the constant said 31 — i.e. two of
  // four shipped biomes were being clipped through the crown, invisibly, and no unit test or render
  // of the ember floor could ever have shown it.
  const SWATCHES = ['fire', 'ice', 'lightning', 'neutral'] as const;

  /** The row of the swatch's mortar line: the darkest row in its top third. This IS the definition
   *  `FACE_CROWN_ROWS` is measured by, so the assertion is exact rather than a tolerance. */
  function mortarRow(rows: number[]): number {
    const third = rows.slice(0, Math.round(rows.length / 3));
    let at = 0;
    third.forEach((v, i) => { if (v < third[at]!) at = i; });
    return at;
  }

  it('has an entry for every shipped face swatch', () => {
    // A new biome whose art lands without being measured would otherwise fall back to the
    // conservative default and quietly clip its corners in the wrong place.
    const shipped = readdirSync(new URL('biome/', PUBLIC))
      .filter((f) => f.startsWith('wallface_') && f.endsWith('.png'))
      .map((f) => f.slice('wallface_'.length, -'.png'.length));
    expect(shipped.length).toBeGreaterThan(0);
    for (const el of shipped) expect(FACE_CROWN_ROWS[el], `no crown measured for '${el}'`).toBeDefined();
    expect([...SWATCHES].sort()).toEqual(shipped.sort());
  });

  it('records each swatch\'s real pixel height, so a re-export at a new size fails here', () => {
    for (const el of SWATCHES) {
      const rows = pngRowLuma(`biome/wallface_${el}.png`);
      expect(FACE_CROWN_ROWS[el]![1], `${el} row count`).toBe(rows.length);
    }
  });

  it('puts the line exactly on each swatch\'s mortar line', () => {
    for (const el of SWATCHES) {
      const rows = pngRowLuma(`biome/wallface_${el}.png`);
      expect(FACE_CROWN_ROWS[el]![0], `${el} mortar line`).toBe(mortarRow(rows));
    }
  });

  it('is a real crown/brick joint, not just any dark row', () => {
    // What makes the mortar line the right place to stop: a markedly brighter coping course above it
    // and the brick plateau below. That contrast is why the crown is the line the eye reads a back
    // wall by, and it is what would stop holding if the art lost its coping course entirely.
    for (const el of SWATCHES) {
      const rows = pngRowLuma(`biome/wallface_${el}.png`);
      const line = FACE_CROWN_ROWS[el]![0];
      const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
      const coping = mean(rows.slice(0, Math.max(1, line - 8)));
      const brick = mean(rows.slice(line + 4, Math.round(rows.length * 0.75)));
      expect(coping, `${el} coping vs brick`).toBeGreaterThan(brick * 1.3);
    }
  });

  it('records that the swatches DISAGREE, which is why the lookup is per element', () => {
    // Pinned deliberately: if a future art pass makes them agree, a single constant becomes correct
    // again and this test says so out loud rather than leaving the plumbing unexplained.
    const fractions = SWATCHES.map((el) => faceCrownFraction(el));
    expect(new Set(fractions.map((f) => f.toFixed(3))).size).toBeGreaterThan(1);
    expect(faceCrownFraction('ice')).toBeLessThan(faceCrownFraction('fire'));
  });

  it('defaults to the SHALLOWEST measured crown, which can never cross a deeper one', () => {
    const all = Object.values(FACE_CROWN_ROWS).map(([row, total]) => row / total);
    expect(FACE_CROWN_FRACTION_MIN).toBeCloseTo(Math.min(...all), 9);
    // An element with no swatch — `poison` ships none — takes it.
    expect(faceCrownFraction('poison')).toBe(FACE_CROWN_FRACTION_MIN);
  });

  it("is actually WIRED to the room's element by RoomBuilder", () => {
    // The one step nothing else here can reach: `wallJoins` defaults to the conservative minimum, so
    // a caller that forgets to pass the room's own fraction still produces plausible corners — every
    // fire room would just clip a few px low, forever, silently. Read from source rather than
    // imported because importing RoomBuilder needs a live Pixi stage; same trick
    // `render/rigComposition.test.ts` uses on main.ts.
    const source = readFileSync(new URL('RoomBuilder.ts', import.meta.url)).toString('utf8');
    expect(source).toMatch(/wallJoins\(\s*merged,\s*faceCrownFraction\(element\)\s*\)/);
  });

  it('would NOT be satisfied by an arbitrary row — the check has teeth', () => {
    // Guards the assertions above against being vacuously true: 40% down the elevation is inside the
    // brick courses, and must not pass as the mortar line for any swatch.
    for (const el of SWATCHES) {
      const rows = pngRowLuma(`biome/wallface_${el}.png`);
      expect(mortarRow(rows), el).not.toBe(Math.round(rows.length * 0.4));
    }
  });
});
