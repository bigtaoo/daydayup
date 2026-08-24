/**
 * `drawAttribution` — the two probes that turn `glProbe`'s frame totals into "what for".
 *
 * `attributeDraws` is tested against a fake `FrameProbe` whose cost is a function of what is
 * visible, which is the only way to check the hide-and-restore protocol exactly: that each group is
 * measured against the SAME baseline rather than cumulatively, that the scene comes back as it was,
 * and that an already-hidden node is not "restored" into visibility.
 *
 * `graphicsCensus` gets a fake inspector, deliberately one whose verdict CONTRADICTS its own vertex
 * count: the census must report what the renderer says rather than re-deriving Pixi's 400-float rule,
 * or it would contradict the renderer for any forced batch mode and go stale on a Pixi upgrade. The
 * rule itself is pinned against real Pixi in `render/staticGraphics.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { Graphics, Container } from 'pixi.js';
import {
  AUTO_BATCH_VERTEX_LIMIT,
  attributeDraws,
  formatAttribution,
  formatCensus,
  graphicsCensus,
  type DrawCost,
  type GraphicsInspector,
  type ToggleableNode,
} from './drawAttribution';

/** A probe whose cost is `base + per-visible-node`, so a hidden group's saving is predictable. */
function fakeProbe(nodes: Record<string, ToggleableNode[]>, perNode: Record<string, number>) {
  let calls = 0;
  const probe = (): DrawCost => {
    calls++;
    let draws = 10;
    for (const [name, group] of Object.entries(nodes)) {
      for (const n of group) if (n.visible !== false) draws += perNode[name] ?? 0;
    }
    return { draws, programs: draws * 2, textures: draws, framebuffers: 0 };
  };
  return { probe, calls: () => calls };
}

describe('attributeDraws', () => {
  it('attributes each group its own saving, against one shared baseline', () => {
    const walls = [{ visible: true }, { visible: true }, { visible: true }];
    const floor = [{ visible: true }];
    const { probe } = fakeProbe({ walls, floor }, { walls: 3, floor: 5 });
    const a = attributeDraws(probe, { walls, floor });
    expect(a.total.draws).toBe(10 + 9 + 5);
    expect(a.rows.find((r) => r.name === 'walls')!.cost.draws).toBe(9);
    expect(a.rows.find((r) => r.name === 'floor')!.cost.draws).toBe(5);
    // Cumulative measurement would have made the second group look free (or double-counted the
    // first); this is the bug the shared baseline exists to prevent.
    expect(a.rows.find((r) => r.name === 'floor')!.cost.draws).not.toBe(0);
  });

  it('is order-independent', () => {
    const a = [{ visible: true }, { visible: true }];
    const b = [{ visible: true }];
    const one = attributeDraws(fakeProbe({ a, b }, { a: 2, b: 7 }).probe, { a, b });
    const two = attributeDraws(fakeProbe({ a, b }, { a: 2, b: 7 }).probe, { b, a });
    const costs = (x: typeof one) => Object.fromEntries(x.rows.map((r) => [r.name, r.cost.draws]));
    expect(costs(one)).toEqual(costs(two));
  });

  it('restores visibility exactly, including nodes that were already hidden', () => {
    // Restoring by setting `visible = true` would silently turn on a corpse's view or an off-screen
    // door and change the frame the caller goes on to measure by hand afterwards.
    const nodes = [{ visible: true }, { visible: false }, {} as ToggleableNode];
    const { probe } = fakeProbe({ nodes }, { nodes: 1 });
    attributeDraws(probe, { nodes });
    expect(nodes.map((n) => n.visible)).toEqual([true, false, undefined]);
  });

  it('spends one render per group plus one baseline', () => {
    const a = [{ visible: true }];
    const b = [{ visible: true }];
    const f = fakeProbe({ a, b }, { a: 1, b: 1 });
    attributeDraws(f.probe, { a, b });
    expect(f.calls()).toBe(3);
  });

  it('ranks the biggest draw-call cost first, so the finding is the top line', () => {
    const small = [{ visible: true }];
    const big = [{ visible: true }];
    const a = attributeDraws(fakeProbe({ small, big }, { small: 1, big: 40 }).probe, { small, big });
    expect(a.rows.map((r) => r.name)).toEqual(['big', 'small']);
    expect(formatAttribution(a).split('\n')[1]).toContain('big');
  });

  it('reports every counter, not just draws — a group can own a filter pass too', () => {
    const g = [{ visible: true }];
    const probe = (): DrawCost =>
      g[0]!.visible === false
        ? { draws: 1, programs: 1, textures: 1, framebuffers: 1 }
        : { draws: 4, programs: 3, textures: 9, framebuffers: 5 };
    const row = attributeDraws(probe, { g }).rows[0]!;
    expect(row.cost).toEqual({ draws: 3, programs: 2, textures: 8, framebuffers: 4 });
  });
});

describe('graphicsCensus', () => {
  const inspector = (verdicts: Map<unknown, { verts: number; batchable: boolean }>): GraphicsInspector => ({
    updateGpuContext: (context) => {
      const v = verdicts.get(context)!;
      return {
        isBatchable: v.batchable,
        batches: new Array(3),
        geometryData: { vertices: new Array(v.verts) },
      };
    },
  });

  it('finds Graphics at any depth, skips everything else, and sorts by geometry size', () => {
    const small = new Graphics();
    const large = new Graphics();
    small.label = 'small';
    large.label = 'large';
    const root = new Container();
    const mid = new Container();
    root.addChild(mid, small);
    mid.addChild(large);
    const verdicts = new Map<unknown, { verts: number; batchable: boolean }>([
      [small.context, { verts: 40, batchable: true }],
      [large.context, { verts: 900, batchable: false }],
    ]);
    const rows = graphicsCensus(root, inspector(verdicts));
    expect(rows.map((r) => r.name)).toEqual(['large', 'small']);
    expect(rows[0]).toMatchObject({ vertices: 900, fills: 3, batched: false, mode: 'auto' });
    expect(rows[1]!.batched).toBe(true);
  });

  it('falls back to the constructor name when a Graphics has no label', () => {
    const g = new Graphics();
    const rows = graphicsCensus(g, inspector(new Map([[g.context, { verts: 8, batchable: true }]])));
    expect(rows[0]!.name).toBe(g.constructor.name);
    expect(rows[0]!.name).not.toBe('');
  });

  it('reports the real batchMode, so `staticGraphics()` is visible in a census', () => {
    const g = new Graphics();
    g.context.batchMode = 'batch';
    const rows = graphicsCensus(g, inspector(new Map([[g.context, { verts: 9000, batchable: true }]])));
    expect(rows[0]!.mode).toBe('batch');
    expect(rows[0]!.batched).toBe(true); // huge, and batched anyway — the whole point of the mode
  });

  it('takes Pixi at its word rather than re-deriving the threshold', () => {
    // A census that recomputed `vertices < AUTO_BATCH_VERTEX_LIMIT` itself would contradict the
    // renderer for any forced mode, and go stale on a Pixi upgrade. Here the verdict disagrees with
    // the vertex count on purpose, and the row must follow the renderer.
    const g = new Graphics();
    const rows = graphicsCensus(g, inspector(new Map([[g.context, { verts: 1, batchable: false }]])));
    expect(rows[0]!.batched).toBe(false);
  });
});

describe('AUTO_BATCH_VERTEX_LIMIT', () => {
  it('is the number the census quotes, and only ever explanatory', () => {
    // The constant is pinned against Pixi's real behaviour in `render/staticGraphics.test.ts`, which
    // is where the rule belongs. What matters HERE is that the census never uses it to decide
    // anything — `graphicsCensus` reads `isBatchable` off the renderer — so this file only checks it
    // is exported for the report text to quote. The "takes Pixi at its word" case above is the one
    // that proves the decision is not made from this number.
    expect(AUTO_BATCH_VERTEX_LIMIT).toBe(400);
    expect(formatCensus([]).toString()).toContain('400');
  });
});

describe('formatCensus', () => {
  it('marks the unbatched rows and counts them in the header', () => {
    const rows = [
      { name: 'wall-shading', vertices: 800, fills: 90, batched: false, mode: 'auto' },
      { name: 'wall-edge', vertices: 40, fills: 4, batched: true, mode: 'auto' },
    ];
    const text = formatCensus(rows);
    expect(text.split('\n')[0]).toContain('1 NOT batched');
    expect(text.split('\n')[1]!.trimStart().startsWith('!')).toBe(true);
    expect(text.split('\n')[2]!.trimStart().startsWith('!')).toBe(false);
    expect(text).toContain('wall-shading');
  });

  it('caps the body but still counts everything in the header', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      name: `g${i}`, vertices: 30 - i, fills: 1, batched: false, mode: 'auto',
    }));
    const text = formatCensus(rows, 5);
    expect(text.split('\n')).toHaveLength(6); // header + 5
    expect(text.split('\n')[0]).toContain('30 Graphics, 30 NOT batched');
  });
});
