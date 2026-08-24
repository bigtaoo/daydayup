// Scene-graph / GPU / heap counters — the diagnostic half of `funny`'s MemoryMonitor,
// re-aimed at this renderer.
//
// funny's version exists to catch *leaks* (its historical bug was a scene left
// un-destroyed, pinning the whole graph through Ticker.shared closures), so it samples
// slowly and only dumps when a threshold trips. The same three numbers answer a different
// question here — "why is this frame expensive" — so they are cheap enough to read once
// per sampling window and are surfaced live rather than only on breach.
//
// Two deviations from funny worth naming:
//   * Pixi v8 has no `PIXI.utils.BaseTextureCache` / `DisplayObject`. The texture count
//     comes from the renderer's own managed-texture list, and the walk is over `Container`.
//   * `filtered` is new. It is the count of nodes carrying a filter array, i.e. the number
//     of extra render-target passes this frame is going to pay for — the counter that
//     turned out to explain this client's frame cost (see perf/README.md).

/** The shape this module walks. Structural, not `Container`, so a test can hand it a
 *  plain nested object literal without standing up Pixi. */
export interface WalkableNode {
  children?: readonly WalkableNode[];
  filters?: unknown;
  visible?: boolean;
}

/** Cap on the traversal, ported from funny: once a leak has already happened, the counting
 *  itself must not be what makes the stutter worse. */
export const NODE_WALK_CAP = 100_000;

export interface SceneCounts {
  /** Total nodes reachable from the root, capped at NODE_WALK_CAP. */
  nodes: number;
  /** Nodes that are `visible` — the ones the renderer will actually traverse. */
  visible: number;
  /** Nodes carrying at least one filter: each is its own render-target pass. */
  filtered: number;
  /** True if the walk hit the cap and stopped early (so `nodes` is a floor, not a total). */
  capped: boolean;
}

/** One iterative (never recursive — a deep scene must not blow the JS stack while we are
 *  trying to diagnose it) walk collecting all three counts at once. */
export function countScene(root: WalkableNode | null | undefined): SceneCounts {
  const out: SceneCounts = { nodes: 0, visible: 0, filtered: 0, capped: false };
  if (!root) return out;
  const stack: WalkableNode[] = [root];
  while (stack.length > 0) {
    if (out.nodes >= NODE_WALK_CAP) {
      out.capped = true;
      break;
    }
    const node = stack.pop()!;
    out.nodes += 1;
    if (node.visible !== false) out.visible += 1;
    const f = node.filters;
    if (f != null && (!Array.isArray(f) || f.length > 0)) out.filtered += 1;
    const kids = node.children;
    if (kids) for (let i = 0; i < kids.length; i++) stack.push(kids[i]!);
  }
  return out;
}

/** JS heap reading in MB, or null where `performance.memory` is unavailable (everything
 *  that is not Chromium). Same caveat funny records: this is the JS heap only — a texture
 *  is mostly GPU memory and barely shows up here. */
export function heapMB(): number | null {
  const m = (globalThis.performance as unknown as { memory?: { usedJSHeapSize?: number } } | undefined)?.memory;
  const used = m?.usedJSHeapSize;
  return typeof used === 'number' ? Math.round(used / (1024 * 1024)) : null;
}

/** Minimal view of the bits of a Pixi renderer these counters read. Structural for the
 *  same reason `WalkableNode` is: none of this needs a real GPU to test. */
export interface CountableRenderer {
  texture?: { _managedTextures?: unknown };
}

/** Size of whatever container Pixi is using this version — an array, a Set/Map, or a
 *  plain uid-keyed hash. Pixi 8.6 uses the last of those (`GCManagedHash.items`), which is
 *  exactly the kind of private detail that gets renamed, hence the shape sniffing and the
 *  -1 fallback below rather than a hard read. */
function sizeOf(container: unknown): number {
  if (container == null || typeof container !== 'object') return -1;
  const c = container as { length?: unknown; size?: unknown; items?: unknown };
  if (typeof c.length === 'number') return c.length;
  if (typeof c.size === 'number') return c.size;
  if (c.items != null) {
    const inner = sizeOf(c.items);
    if (inner >= 0) return inner;
    if (typeof c.items === 'object') return Object.keys(c.items as object).length;
  }
  return -1;
}

/** Number of textures the renderer currently holds on the GPU. -1 when the renderer does
 *  not expose it (a non-WebGL renderer, or a Pixi version that renamed the field —
 *  deliberately a soft miss, since a perf overlay must never be what breaks a boot). */
export function gpuTextureCount(renderer: CountableRenderer | null | undefined): number {
  return sizeOf(renderer?.texture?._managedTextures);
}
