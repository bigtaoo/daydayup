// Which objects the frame's draw calls belong to — the tool that turns `glProbe`'s totals into an
// answer.
//
// `glProbe` says a frame cost 165 draw calls and 102 program switches. It cannot say what for, and
// the difference matters: a draw call spent on the floor is one thing, 79 spent on 27 wall runs is
// another. Two probes here, and between them they are what found the 2026-08-24 bottleneck (see
// perf/README.md for the numbers they produced and design/01 for what was done about them):
//
//   * `attributeDraws` — hide a group of nodes, render again, and the drop IS that group's cost.
//     Measuring by hiding rather than by rendering the group alone is deliberate: a draw call is a
//     property of a BOUNDARY between neighbours, not of an object. An additive sprite between two
//     ordinary ones costs three draw calls (itself plus the two halves of the batch it split), and
//     rendering it in isolation would report one. Group deltas therefore do not sum to the total,
//     and that is information — a group whose delta exceeds its own object count is cutting the
//     batcher, which is the expensive kind of cost and the kind worth fixing.
//   * `graphicsCensus` — every Graphics with its geometry size and whether Pixi will batch it.
//     Pixi v8 auto-batches a Graphics only under `AUTO_BATCH_VERTEX_LIMIT` floats of geometry
//     (`GraphicsContextSystem.updateGpuContext`); above it the object gets `batch.break()`, its own
//     draw call, and a program switch each way. Nothing in the renderer surfaces that threshold, so
//     a hand-banded gradient silently crossing it looks exactly like a Graphics that batches fine.
//
// Both are console tools for a `?perf=1` session, not part of the per-frame monitor: each one
// renders the scene several extra times.

import type { GlCounts } from './glProbe';

/** The subset of `Container` these probes touch. Structural like `sceneCounters.WalkableNode`, so a
 *  test can pass plain objects instead of standing up Pixi and a GL context. */
export interface ToggleableNode {
  visible?: boolean;
  children?: readonly ToggleableNode[];
}

/** What one render cost. Exactly `glProbe`'s counters — including `framebuffers`, so a group can be
 *  attributed a FILTER pass as well as its draw calls. */
export type DrawCost = GlCounts;

/**
 * Render one frame and report what it cost. Supplied by the caller so this module needs neither a
 * renderer nor a live GL context — `installPerf` wires the real one onto `window.__perf`.
 */
export type FrameProbe = () => DrawCost;

export interface AttributionRow {
  name: string;
  /** Nodes hidden to produce this row. */
  nodes: number;
  /** Baseline cost minus the cost with this group hidden, i.e. what the group is responsible for. */
  cost: DrawCost;
}

export interface Attribution {
  total: DrawCost;
  rows: AttributionRow[];
}

/**
 * Per-group draw-call attribution by hide-and-remeasure.
 *
 * Groups are measured one at a time against the same baseline and restored afterwards, so the order
 * they are listed in does not change the result and the scene is left exactly as it was found —
 * including nodes that were already invisible, which stay that way.
 *
 * Costs one render per group plus one baseline render, all of them synchronous.
 */
export function attributeDraws(
  probe: FrameProbe,
  groups: Readonly<Record<string, readonly ToggleableNode[]>>,
): Attribution {
  const total = probe();
  const rows: AttributionRow[] = [];
  for (const [name, nodes] of Object.entries(groups)) {
    const was = nodes.map((n) => n.visible);
    for (const n of nodes) n.visible = false;
    const withoutIt = probe();
    nodes.forEach((n, i) => {
      n.visible = was[i];
    });
    rows.push({ name, nodes: nodes.length, cost: subtract(total, withoutIt) });
  }
  rows.sort((a, b) => b.cost.draws - a.cost.draws);
  return { total, rows };
}

function subtract(a: DrawCost, b: DrawCost): DrawCost {
  return {
    draws: a.draws - b.draws,
    programs: a.programs - b.programs,
    textures: a.textures - b.textures,
    framebuffers: a.framebuffers - b.framebuffers,
  };
}

/**
 * Pixi v8's own auto-batch cutoff, in FLOATS of vertex data (so half this many 2D vertices).
 * Mirrored from `GraphicsContextSystem.updateGpuContext`; if a Pixi upgrade moves it the census
 * itself stays correct — it reads the verdict from the renderer — but this number in a report
 * stops explaining it, which is what `drawAttribution.test.ts` pins.
 */
export const AUTO_BATCH_VERTEX_LIMIT = 400;

export interface GraphicsRow {
  /** `label` where the object has one, else the constructor name — enough to find it again. */
  name: string;
  /** Floats of vertex data Pixi built for this context. */
  vertices: number;
  /** Separate fills/strokes inside the context; each is one element the batcher has to pack. */
  fills: number;
  /** True if this Graphics joins the sprite batch. False means one draw call plus two program
   *  switches, every frame it is on screen. */
  batched: boolean;
  /** `context.batchMode` — 'auto' is Pixi's default, 'batch' is this repo's `staticGraphics()`. */
  mode: string;
}

/** The renderer surface the census reads: `renderer.graphicsContext`. Structural so a test can
 *  fake it without a GL context. */
export interface GraphicsInspector {
  updateGpuContext(context: unknown): {
    isBatchable?: boolean;
    batches?: readonly unknown[];
    geometryData?: { vertices?: readonly unknown[] };
  };
}

interface GraphicsLike extends ToggleableNode {
  context?: { batchMode?: string };
  label?: string | null;
  constructor: { name: string };
}

/**
 * Every Graphics under `root`, largest geometry first, with Pixi's own batching verdict for each.
 *
 * Reads the verdict out of the renderer rather than recomputing the threshold, so it stays true if
 * Pixi's rule changes. Identifies a Graphics by the presence of `context.batchMode` rather than by
 * `instanceof`, both to keep this module Pixi-free and because the client's Graphics arrive as
 * several distinct minified subclasses.
 */
export function graphicsCensus(root: ToggleableNode, inspector: GraphicsInspector): GraphicsRow[] {
  const rows: GraphicsRow[] = [];
  const stack: ToggleableNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as GraphicsLike;
    const context = node.context;
    if (context && typeof context.batchMode === 'string') {
      const gpu = inspector.updateGpuContext(context);
      rows.push({
        name: node.label || node.constructor.name,
        vertices: gpu.geometryData?.vertices?.length ?? 0,
        fills: gpu.batches?.length ?? 0,
        batched: gpu.isBatchable === true,
        mode: context.batchMode,
      });
    }
    for (const child of node.children ?? []) stack.push(child);
  }
  rows.sort((a, b) => b.vertices - a.vertices);
  return rows;
}

/** One line per group, for reading in a devtools console. */
export function formatAttribution(a: Attribution): string {
  const head = `total  draws ${a.total.draws}  prog ${a.total.programs}  tex ${a.total.textures}`;
  const body = a.rows.map(
    (r) =>
      `  ${r.name.padEnd(18)} ${String(r.cost.draws).padStart(4)} draws  ${String(r.cost.programs).padStart(4)} prog  (${r.nodes} nodes)`,
  );
  return [head, ...body].join('\n');
}

/** As `formatAttribution`, for the Graphics census. A leading `!` marks an unbatched row — those
 *  are the findings; everything else is already free. */
export function formatCensus(rows: readonly GraphicsRow[], limit = 20): string {
  const unbatched = rows.filter((r) => !r.batched).length;
  const head = `${rows.length} Graphics, ${unbatched} NOT batched (over ${AUTO_BATCH_VERTEX_LIMIT} floats on 'auto')`;
  const body = rows
    .slice(0, limit)
    .map(
      (r) =>
        `  ${r.batched ? ' ' : '!'} ${r.name.padEnd(18)} ${String(r.vertices).padStart(6)} floats  ${String(r.fills).padStart(4)} fills  ${r.mode}`,
    );
  return [head, ...body].join('\n');
}
