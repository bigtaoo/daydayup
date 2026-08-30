/**
 * `geom.ts`'s point-vs-solid helpers — `circlesOverlap`/`circleOverlapsAabb` are simple enough
 * to be covered incidentally elsewhere, but `clampToWalkable` had NO direct coverage before this
 * file: every caller (`DeathDropsSystem`, `PickupSystem.applyWeapon`, `SpawnSystem`'s arena crate
 * placement) only ever exercised it as a side effect of a bigger system test. Split out on its
 * own (ENGINE_VERSION 48) once it turned out to have a real bug no caller-level test happened to
 * reach — see the free-standing-brim block below.
 */
import { describe, it, expect } from 'vitest';
import { createGameState } from '../state/GameState';
import type { GameState } from '../state/GameState';
import { pxToFp } from '../content/convert';
import { WALL_NORTH_BRIM } from '../config';
import { clampToWalkable } from './geom';
import type { AABB } from '../state/entities';

const CFG = { seed: 1, worldW: 1600, worldH: 1200, waves: [] as const };
const px = (n: number) => pxToFp(n);

function withWall(rect: AABB): GameState {
  const s = createGameState({ ...CFG });
  s.walls.push(rect);
  s.rebuildSpatialIndex();
  return s;
}

describe('clampToWalkable — plain walls (no freeStanding flag)', () => {
  it('leaves an already-clear point untouched', () => {
    const s = withWall({ x: px(700), y: px(600), w: px(200), h: px(64) });
    const pos = clampToWalkable(px(100), px(100), px(15), s);
    expect(pos).toEqual({ gx: px(100), gy: px(100) });
  });

  it('pushes a point overlapping the rect out to the nearest edge, tangent by `radius`', () => {
    const s = withWall({ x: px(700), y: px(600), w: px(200), h: px(64) });
    // North of the footprint, overlapping by more than `radius` — no brim on this rect, so the
    // push stops at the bare footprint, exactly like MovementSystem.resolveWalls on a plain wall.
    const pos = clampToWalkable(px(800), px(595), px(15), s);
    expect(pos.gy).toBe(px(600 - 15));
  });

  it('pushes a point INSIDE the rect out along the nearest edge', () => {
    const s = withWall({ x: px(700), y: px(600), w: px(200), h: px(64) });
    // 3px from the north edge, 61px from the south — nearest edge is north.
    const pos = clampToWalkable(px(800), px(603), px(15), s);
    expect(pos.gy).toBe(px(600 - 15));
  });
});

describe('clampToWalkable — a FREE-STANDING block\'s north brim (ENGINE_VERSION 48)', () => {
  // The bug this section exists for (live report: *"角色根本无法拾取掉落的物品"*): a free-standing
  // block's art rises `config.WALL_NORTH_BRIM` north of its own footprint, and no actor's
  // `solidRadius` circle is ever allowed to enter that band (`MovementSystem.resolveWalls`). A
  // point clamped only against the bare footprint could still settle inside it — on screen, but
  // past where any player or enemy could ever stand to collect it.
  const NORTH = 610; // footprint's own north edge, in px

  it('a point that only overlaps the BRIMMED band (not the bare footprint) still gets pushed out', () => {
    const s = withWall({ x: px(700), y: px(NORTH), w: px(200), h: px(64), freeStanding: true });
    // 5px north of the footprint: outside the bare rect entirely, but well inside the brim band
    // MovementSystem keeps every actor's solidRadius out of. A pre-fix clampToWalkable saw no
    // overlap here at all (the bare rect is 15px away, more than the 15px pickup radius) and left
    // the point untouched — this is the exact defect.
    const pos = clampToWalkable(px(800), px(NORTH - 5), px(15), s);
    expect(pos.gy).toBeLessThan(px(NORTH - 5)); // pushed further north, not left in place
    expect(pos.gy).toBe(px(NORTH) - WALL_NORTH_BRIM - px(15));
  });

  it('never lands closer to the north face than any actor could ever stand', () => {
    // The property that actually matters: after the clamp, the point's own `radius` clearance
    // plus its distance from the true footprint edge is never less than the brim — i.e. it never
    // sits in the dead band an actor's collision keeps them out of.
    const s = withWall({ x: px(700), y: px(NORTH), w: px(200), h: px(64), freeStanding: true });
    for (const startY of [NORTH - 1, NORTH - 10, NORTH - 20, NORTH - 40]) {
      const pos = clampToWalkable(px(800), px(startY), px(15), s);
      const distFromTrueEdge = (px(NORTH) as number) - (pos.gy as number);
      expect(distFromTrueEdge).toBeGreaterThanOrEqual((WALL_NORTH_BRIM as number) + (px(15) as number));
    }
  });

  it('a point already north of the brim band is left alone', () => {
    const s = withWall({ x: px(700), y: px(NORTH), w: px(200), h: px(64), freeStanding: true });
    const farNorth = px(NORTH) - WALL_NORTH_BRIM - px(15) - px(20);
    const pos = clampToWalkable(px(800), farNorth as ReturnType<typeof px>, px(15), s);
    expect(pos.gy).toBe(farNorth);
  });

  it('the other three faces stay tangent to the bare footprint — the brim is one-sided', () => {
    const s = withWall({ x: px(700), y: px(NORTH), w: px(200), h: px(64), freeStanding: true });
    // South face: 3px into the south edge from outside.
    const south = clampToWalkable(px(800), px(NORTH + 64 + 3), px(15), s);
    expect(south.gy).toBe(((px(NORTH + 64) as number) + (px(15) as number)) as ReturnType<typeof px>);
    // East face.
    const east = clampToWalkable(px(700 + 200 + 3), px(NORTH + 30), px(15), s);
    expect(east.gx).toBe(((px(700 + 200) as number) + (px(15) as number)) as ReturnType<typeof px>);
  });

  it('a PERIMETER wall (no freeStanding flag) gets no brim at all', () => {
    const s = withWall({ x: px(700), y: px(NORTH), w: px(200), h: px(64) }); // freeStanding omitted
    const pos = clampToWalkable(px(800), px(NORTH - 5), px(15), s);
    expect(pos.gy).toBe(px(NORTH - 15)); // tangent to the bare footprint, same as a plain wall
  });
});
