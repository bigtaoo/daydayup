/**
 * `groundCulling.ts` — the rect test itself, in isolation (2026-08-26).
 *
 * `groundGeometryBudget.test.ts` covers this through the real `RoomBuilder` + `FxController` and is
 * where the numbers live. This file covers the four edges that a sweep over real content cannot
 * reach on purpose, because no shipped map happens to contain them: a piece exactly touching the
 * viewport edge, an untagged piece, a piece switched back ON after being culled, and a view that has
 * moved away from everything.
 */
import { describe, it, expect } from 'vitest';
import { Container } from 'pixi.js';
import { cullGroundLayer, groundPieceBounds, tagGroundPiece } from './groundCulling';
import type { RectPx } from './wallGeometry';

function piece(bounds: RectPx | null): Container {
  const c = new Container();
  if (bounds) tagGroundPiece(c, bounds);
  return c;
}

function ground(...pieces: Container[]): Container {
  const g = new Container();
  for (const p of pieces) g.addChild(p);
  return g;
}

const VIEW: RectPx = { x: 100, y: 100, w: 200, h: 200 };

describe('cullGroundLayer', () => {
  it('keeps what the view touches and drops what it does not', () => {
    const inside = piece({ x: 150, y: 150, w: 10, h: 10 });
    const overlapping = piece({ x: 50, y: 50, w: 100, h: 100 });
    const away = piece({ x: 400, y: 400, w: 10, h: 10 });
    const g = ground(inside, overlapping, away);
    expect(cullGroundLayer(g, VIEW)).toBe(2);
    expect([inside.culled, overlapping.culled, away.culled]).toEqual([false, false, true]);
  });

  it('touching the edge counts as visible — a piece turns on before any of it can be seen', () => {
    // Half-open on purpose in BOTH directions: a piece whose right edge is exactly the view's left
    // edge contributes no pixels, and one that overlaps by a hair contributes one. The test is `<`
    // and `>`, so the first is culled and the second is not, and a `<=` would keep a whole column of
    // rooms resident down every wall of a gridded map.
    const flush = piece({ x: 0, y: 100, w: 100, h: 200 }); // right edge == view.x
    const hair = piece({ x: 0.5, y: 100, w: 100, h: 200 }); // overlaps by 0.5 px
    const g = ground(flush, hair);
    expect(cullGroundLayer(g, VIEW)).toBe(1);
    expect(flush.culled).toBe(true);
    expect(hair.culled).toBe(false);
  });

  it('switches a piece back ON when the camera comes back — the cull is not one-way', () => {
    // The failure this catches is a cull that only ever sets the bit: every assertion about "the
    // camera submits little" still passes, and the floor drains away as the player walks the map.
    const p = piece({ x: 400, y: 400, w: 10, h: 10 });
    const g = ground(p);
    cullGroundLayer(g, VIEW);
    expect(p.culled).toBe(true);
    expect(cullGroundLayer(g, { x: 395, y: 395, w: 50, h: 50 })).toBe(1);
    expect(p.culled).toBe(false);
  });

  it('never culls an UNTAGGED piece — the fail-safe direction', () => {
    // Something mounted on the ground layer that nobody described stays on screen. The alternative
    // (cull what you cannot place) turns a missed `tagGroundPiece` into an invisible floor rather
    // than into a slow one, and only one of those is noticed.
    const unknown = piece(null);
    const known = piece({ x: 400, y: 400, w: 10, h: 10 });
    const g = ground(unknown, known);
    expect(groundPieceBounds(unknown)).toBeUndefined();
    expect(cullGroundLayer(g, VIEW)).toBe(1);
    expect(unknown.culled).toBe(false);
    expect(known.culled).toBe(true);
  });

  it('reports zero when the view has left the map entirely', () => {
    const g = ground(piece({ x: 0, y: 0, w: 10, h: 10 }), piece({ x: 20, y: 20, w: 10, h: 10 }));
    expect(cullGroundLayer(g, { x: 10_000, y: 10_000, w: 100, h: 100 })).toBe(0);
    expect(g.children.every((c) => c.culled)).toBe(true);
  });

  it('does not dirty the render group when nothing changed', () => {
    // Not a nicety: this runs every frame, and every write that actually flips the bit marks the
    // parent render group's structure dirty, which rebuilds its instruction set and repacks the
    // batched geometry that survives. Pixi's own `culled` setter is what guards the no-op case; this
    // is the test that says so, and the second half is its control — a view that DID move must dirty
    // the group, or the assertion above is about a cull that never does anything.
    const g = new Container();
    g.enableRenderGroup();
    const p = piece({ x: 150, y: 150, w: 10, h: 10 });
    g.addChild(p);
    cullGroundLayer(g, VIEW);
    g.renderGroup!.structureDidChange = false;
    cullGroundLayer(g, VIEW);
    cullGroundLayer(g, VIEW);
    expect(p.culled).toBe(false);
    expect(g.renderGroup!.structureDidChange).toBe(false);

    cullGroundLayer(g, { x: 10_000, y: 10_000, w: 10, h: 10 });
    expect(p.culled).toBe(true);
    expect(g.renderGroup!.structureDidChange).toBe(true);
  });
});
