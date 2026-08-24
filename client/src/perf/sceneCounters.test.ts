import { describe, it, expect } from 'vitest';
import { countScene, gpuTextureCount, heapMB, NODE_WALK_CAP, type WalkableNode } from './sceneCounters';

/** Build a chain `depth` nodes deep — the shape that would blow a recursive walker's stack. */
function chain(depth: number): WalkableNode {
  let node: WalkableNode = {};
  for (let i = 0; i < depth - 1; i++) node = { children: [node] };
  return node;
}

describe('countScene', () => {
  it('counts the root itself', () => {
    expect(countScene({}).nodes).toBe(1);
  });

  it('returns a zeroed result rather than throwing for a missing root', () => {
    expect(countScene(null)).toEqual({ nodes: 0, visible: 0, filtered: 0, capped: false });
    expect(countScene(undefined).nodes).toBe(0);
  });

  it('walks the whole tree, not just the first branch', () => {
    const tree: WalkableNode = { children: [{ children: [{}, {}] }, { children: [{}] }] };
    expect(countScene(tree).nodes).toBe(6);
  });

  it('treats a node with no explicit `visible` as visible', () => {
    // Pixi's Container defaults `visible` to true; a plain literal in a test (or a
    // renderer version that stops emitting the field) must not read as hidden.
    expect(countScene({ children: [{}, {}] }).visible).toBe(3);
  });

  it('excludes explicitly hidden nodes from the visible count but not the total', () => {
    const tree: WalkableNode = { children: [{ visible: false }, { visible: true }] };
    const c = countScene(tree);
    expect(c.nodes).toBe(3);
    expect(c.visible).toBe(2);
  });

  it('counts a node carrying filters, whatever shape the filter field takes', () => {
    // Pixi accepts both a single filter and an array; the count is "will this node cost a
    // render-target pass", which is true either way.
    const tree: WalkableNode = {
      children: [{ filters: [{}] }, { filters: {} }, { filters: [] }, { filters: null }, {}],
    };
    expect(countScene(tree).filtered).toBe(2);
  });

  it('stops at the walk cap and says so, instead of hanging on a runaway graph', () => {
    // Ported straight from funny: once something has already gone wrong, the counting must
    // not be what makes the stutter worse.
    const wide: WalkableNode = { children: Array.from({ length: NODE_WALK_CAP + 10 }, () => ({})) };
    const c = countScene(wide);
    expect(c.capped).toBe(true);
    expect(c.nodes).toBe(NODE_WALK_CAP);
  });

  it('does not flag a normal-sized scene as capped', () => {
    expect(countScene({ children: [{}, {}] }).capped).toBe(false);
  });

  it('survives a scene deep enough to overflow a recursive walker', () => {
    expect(countScene(chain(20_000)).nodes).toBe(20_000);
  });
});

describe('gpuTextureCount', () => {
  it('reads an array length', () => {
    expect(gpuTextureCount({ texture: { _managedTextures: [1, 2, 3] } })).toBe(3);
  });

  it('reads a Set/Map size', () => {
    expect(gpuTextureCount({ texture: { _managedTextures: new Set([1, 2]) } })).toBe(2);
  });

  it("reads Pixi 8.6's uid-keyed GCManagedHash", () => {
    // The live shape as of pixi 8.6: `{ items: { '0': tex, '12': tex } }`. Sniffed rather
    // than read directly because it is a private field that has already changed once.
    expect(gpuTextureCount({ texture: { _managedTextures: { items: { 0: {}, 12: {}, 30: {} } } } })).toBe(3);
  });

  it('returns -1, never 0, for a renderer that does not expose the field', () => {
    // 0 would read as "no textures loaded", which is a very different diagnosis from
    // "this renderer cannot tell us".
    expect(gpuTextureCount({})).toBe(-1);
    expect(gpuTextureCount({ texture: {} })).toBe(-1);
    expect(gpuTextureCount(null)).toBe(-1);
    expect(gpuTextureCount({ texture: { _managedTextures: 'nope' as unknown } })).toBe(-1);
  });
});

describe('heapMB', () => {
  it('returns a number or null, and never throws where performance.memory is absent', () => {
    // Chromium-only API. The overlay must degrade to hiding the line, not to a boot error.
    const v = heapMB();
    expect(v === null || typeof v === 'number').toBe(true);
  });
});
