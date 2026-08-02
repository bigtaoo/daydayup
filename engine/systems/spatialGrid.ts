/**
 * Uniform spatial grid broadphase over state.walls/state.obstacles (ROADMAP 4.2b).
 * A room today has 0-2 solids, so the linear scans in MovementSystem/
 * ProjectileStepSystem cost nothing; a co-resident PvP arena (design/15, ~60 rooms
 * stitched into one continuous world) is a different regime — this bounds the
 * per-actor/per-projectile collision cost to "solids near this point" instead of
 * "every solid in the world." Applies equally to PvE once floors are stitched into
 * one world too (design/05; `roomGeometry`'s offset args already anticipate this).
 *
 * Built ONCE whenever state.walls/state.obstacles are (re)populated — GameState's
 * constructor and SpawnSystem.loadRoom are the only two call sites today, both
 * infrequent (room load, not per-tick). Purely a derived cache: it carries no
 * gameplay state and needn't be part of any hash/replay snapshot — only what it's
 * built FROM (state.walls/obstacles) is authoritative.
 *
 * Candidates come back sorted ascending by original array index, never bucket-
 * traversal order, so MovementSystem's "iterated in fixed array order —
 * deterministic when solids overlap" contract (resolveWalls) holds for the filtered
 * subset exactly as it did for the full scan. A query pads its radius by
 * QUERY_PADDING_FP so a solid that only becomes reachable after an earlier
 * push-out this same tick (resolveObstacles running before resolveWalls, both
 * cumulative) is still caught — the padding only needs to cover one tick's worth of
 * penetration-depth correction, far less than a full cell.
 */
import type { Fp } from '../math/fixed';
import { toFpGrid } from '../content/convert';
import type { AABB, Obstacle } from '../state/entities';

/** Grid units per cell (tuned for today's room sizes: 8-24 grid units across, 0-2
 * solids per room) — keeps per-cell candidate counts low without exploding cell
 * count for a big co-resident arena. Revisit once real ArenaMap wall density
 * (design/15's map editor output) is known. */
export const CELL_SIZE_GRID = 4;
export const CELL_SIZE_FP = toFpGrid(CELL_SIZE_GRID);

/** Query-side safety margin (grid units) — covers one tick's cumulative push-out
 * displacement so a same-tick push into a neighboring cell can't skip a candidate. */
export const QUERY_PADDING_GRID = 1;
export const QUERY_PADDING_FP = toFpGrid(QUERY_PADDING_GRID);

function cellOf(v: Fp): number {
  return Math.floor((v as number) / (CELL_SIZE_FP as number));
}

function cellKey(cx: number, cy: number): string {
  return cx + ',' + cy;
}

function insert(buckets: Map<string, number[]>, idx: number, minX: Fp, minY: Fp, maxX: Fp, maxY: Fp): void {
  const cx0 = cellOf(minX);
  const cx1 = cellOf(maxX);
  const cy0 = cellOf(minY);
  const cy1 = cellOf(maxY);
  for (let cx = cx0; cx <= cx1; cx++) {
    for (let cy = cy0; cy <= cy1; cy++) {
      const key = cellKey(cx, cy);
      let bucket = buckets.get(key);
      if (!bucket) buckets.set(key, (bucket = []));
      bucket.push(idx);
    }
  }
}

function query(buckets: Map<string, number[]>, gx: Fp, gy: Fp, radius: Fp): number[] {
  const r = (radius as number) + (QUERY_PADDING_FP as number);
  const cx0 = cellOf(((gx as number) - r) as Fp);
  const cx1 = cellOf(((gx as number) + r) as Fp);
  const cy0 = cellOf(((gy as number) - r) as Fp);
  const cy1 = cellOf(((gy as number) + r) as Fp);
  const seen = new Set<number>();
  for (let cx = cx0; cx <= cx1; cx++) {
    for (let cy = cy0; cy <= cy1; cy++) {
      const bucket = buckets.get(cellKey(cx, cy));
      if (!bucket) continue;
      for (const idx of bucket) seen.add(idx);
    }
  }
  return Array.from(seen).sort((a, b) => a - b);
}

/** Broadphase index over one room/arena's static solids. Rebuild whenever
 * state.walls/state.obstacles are repopulated (GameState construction,
 * SpawnSystem.loadRoom) — see GameState.rebuildSpatialIndex. */
export class UniformGrid {
  private readonly wallBuckets = new Map<string, number[]>();
  private readonly obstacleBuckets = new Map<string, number[]>();

  constructor(walls: readonly AABB[], obstacles: readonly Obstacle[]) {
    walls.forEach((w, i) => insert(this.wallBuckets, i, w.x, w.y, (w.x + w.w) as Fp, (w.y + w.h) as Fp));
    obstacles.forEach((o, i) =>
      insert(
        this.obstacleBuckets,
        i,
        (o.gx - o.radius) as Fp,
        (o.gy - o.radius) as Fp,
        (o.gx + o.radius) as Fp,
        (o.gy + o.radius) as Fp,
      ),
    );
  }

  /** Wall indices (into state.walls) whose cell overlaps a query circle, ascending
   * by original index. */
  queryWalls(gx: Fp, gy: Fp, radius: Fp): number[] {
    return query(this.wallBuckets, gx, gy, radius);
  }

  /** Obstacle indices (into state.obstacles), same contract as queryWalls. */
  queryObstacles(gx: Fp, gy: Fp, radius: Fp): number[] {
    return query(this.obstacleBuckets, gx, gy, radius);
  }
}
