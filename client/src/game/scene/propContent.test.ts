/**
 * The authored prop PLACEMENTS in `world/dungeons/ember/pieces/*.json`, swept against the
 * real render metrics (2026-08-24). The subjects are enumerated from the shipped library
 * itself rather than from a fixture list, so a piece authored tomorrow is covered the day it
 * lands instead of the day someone remembers to add it here.
 *
 * This lives client-side, not next to `emberLevel1.test.ts`, because every question below is
 * answered by numbers that live in `propRender.ts` — a prop's footprint, its drawn height,
 * the kind vocabulary. Restating those in the engine package to keep the test next to the
 * content is how the two drift apart.
 *
 * Level 1 went from 15 placements across 8 of 14 pieces to 54 across all 14 in the same pass
 * that shipped the art (before it, six pieces had none at all and the decorated eight used a
 * (3,3)-plus-far-corner formula). That is the scale at which "I checked them by eye" stops
 * being true, which is what these assertions replace.
 */
import { describe, it, expect } from 'vitest';
import { EMBER_L1_ROOMS } from '@dd/engine';
import type { RoomPiece } from '@dd/engine';
import { propBodyHeight, propFootprintWidth, resolvePropKind, type PropKind } from './propRender';

/** 1 grid = 32 px exactly (`coords.ts`), the same conversion `RoomBuilder.buildProps` does. */
const PX_PER_GRID = 32;
const KINDS: readonly PropKind[] = ['crate', 'barrel', 'rubble'];

interface Placed {
  piece: string;
  id: string;
  kind: PropKind;
  x: number;
  y: number;
  /** The prop's drawn box in room-local px — origin at its ground point, drawn upward. */
  box: { l: number; r: number; t: number; b: number };
}

function placements(piece: RoomPiece): Placed[] {
  return (piece.props ?? []).map((p) => {
    const kind = resolvePropKind(p.id);
    const halfW = propFootprintWidth(kind) / 2;
    return {
      piece: piece.id,
      id: p.id,
      kind,
      x: p.x,
      y: p.y,
      box: {
        l: p.x * PX_PER_GRID - halfW,
        r: p.x * PX_PER_GRID + halfW,
        t: p.y * PX_PER_GRID - propBodyHeight(kind),
        b: p.y * PX_PER_GRID,
      },
    };
  });
}

const ALL: Placed[] = EMBER_L1_ROOMS.flatMap(placements);
const byPiece = new Map(EMBER_L1_ROOMS.map((p) => [p.id, p]));

describe('every level-1 room is dressed', () => {
  it('leaves no piece bare', () => {
    // Six of the fourteen had zero props until the art landed. A bare room next to a dressed
    // one is the specific thing that made level 1 read as unfinished.
    const bare = EMBER_L1_ROOMS.filter((p) => (p.props ?? []).length === 0).map((p) => p.id);
    expect(bare).toEqual([]);
  });

  it('gives each piece three or four, so no room is either bare or cluttered', () => {
    const counts = EMBER_L1_ROOMS.map((p) => ({ id: p.id, n: (p.props ?? []).length }));
    expect(counts.filter((c) => c.n < 3 || c.n > 4)).toEqual([]);
  });

  it('uses all three kinds across the level rather than one kind everywhere', () => {
    const used = new Set(ALL.map((p) => p.kind));
    expect([...used].sort()).toEqual([...KINDS].sort());
  });
});

describe('every placement names a kind that actually exists', () => {
  it('never leans on resolvePropKind\'s unknown-id fallback', () => {
    // The fallback is deliberate forward-compat (an unrecognized id draws a crate rather than
    // nothing), which means a TYPO in shipped content is invisible: `barrle` would quietly
    // draw a crate forever. Shipped data has to name a real kind.
    for (const p of ALL) {
      expect({ piece: p.piece, id: p.id }).toEqual({ piece: p.piece, id: p.kind });
    }
  });
});

describe('no placement draws somewhere it should not', () => {
  it('keeps every prop inside its own room, clear of the perimeter wall', () => {
    for (const p of ALL) {
      const piece = byPiece.get(p.piece)!;
      const { w, h } = piece.sizeGrid;
      expect({ at: `${p.piece} ${p.id}`, inside: p.box.l >= PX_PER_GRID }).toEqual({ at: `${p.piece} ${p.id}`, inside: true });
      expect(p.box.r).toBeLessThanOrEqual((w - 1) * PX_PER_GRID);
      expect(p.box.t).toBeGreaterThanOrEqual(PX_PER_GRID);
      expect(p.box.b).toBeLessThanOrEqual((h - 1) * PX_PER_GRID);
    }
  });

  it('never overlaps an interior solid — a prop half-sunk into a block reads as a bug', () => {
    for (const p of ALL) {
      for (const s of byPiece.get(p.piece)!.solids) {
        const sr = {
          l: s.x * PX_PER_GRID,
          r: (s.x + s.w) * PX_PER_GRID,
          t: s.y * PX_PER_GRID,
          b: (s.y + s.h) * PX_PER_GRID,
        };
        const hit = p.box.l < sr.r && p.box.r > sr.l && p.box.t < sr.b && p.box.b > sr.t;
        expect({ at: `${p.piece} ${p.id}@${p.x},${p.y}`, hit }).toEqual({ at: `${p.piece} ${p.id}@${p.x},${p.y}`, hit: false });
      }
    }
  });

  it('stays clear of every player spawn, so nobody materialises inside a barrel', () => {
    for (const p of ALL) {
      for (const s of byPiece.get(p.piece)!.spawns.player) {
        expect(Math.hypot(s.x - p.x, s.y - p.y)).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('stays clear of every enemy spawn, which a room re-uses on every activation', () => {
    for (const p of ALL) {
      for (const s of byPiece.get(p.piece)!.spawns.enemy) {
        expect(Math.hypot(s.x - p.x, s.y - p.y)).toBeGreaterThanOrEqual(1.2);
      }
    }
  });

  it('keeps the middle band of every wall clear, where a door passage lands', () => {
    // `DOOR_EDGE_MARGIN_GRID` is 1.5 and the anchor step is `span / 4`, so a passage always
    // resolves somewhere in the middle of an edge. A prop tucked against that stretch of wall
    // would sit in the doorway — and props have no collision, so the player would walk
    // straight through it rather than anything visibly failing.
    for (const p of ALL) {
      const { w, h } = byPiece.get(p.piece)!.sizeGrid;
      const nearVerticalWall = p.x < 3 || p.x > w - 4;
      const nearHorizontalWall = p.y < 3 || p.y > h - 4;
      const at = `${p.piece} ${p.id}@${p.x},${p.y}`;
      if (nearVerticalWall) {
        expect({ at, inBand: p.y > h * 0.3 && p.y < h * 0.7 }).toEqual({ at, inBand: false });
      }
      if (nearHorizontalWall) {
        expect({ at, inBand: p.x > w * 0.3 && p.x < w * 0.7 }).toEqual({ at, inBand: false });
      }
    }
  });

  it('never stacks two props on the same spot', () => {
    for (const piece of EMBER_L1_ROOMS) {
      const here = placements(piece);
      for (let i = 0; i < here.length; i++) {
        for (let j = i + 1; j < here.length; j++) {
          const a = here[i]!;
          const b = here[j]!;
          const overlap = a.box.l < b.box.r && a.box.r > b.box.l && a.box.t < b.box.b && a.box.b > b.box.t;
          expect({ at: `${piece.id} ${a.id}/${b.id}`, overlap }).toEqual({ at: `${piece.id} ${a.id}/${b.id}`, overlap: false });
        }
      }
    }
  });
});
