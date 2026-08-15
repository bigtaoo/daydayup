import { describe, it, expect, vi } from 'vitest';
import { Texture, TextureSource, type Graphics, type Sprite } from 'pixi.js';
import { Pickup, type PickupKind } from './Pickup';

// `render/weaponSkins.ts` is mocked here so the "texture exists" branch (the real
// weapon icon) is actually reachable under vitest — without it every Pickup test below
// would only ever exercise the chevron fallback (no art preloaded in a plain-node
// vitest run), same convention as Forge.npc.test.ts's `uiSkins` mock.
const mocks = vi.hoisted(() => ({ blasterTexture: undefined as Texture | undefined }));

vi.mock('../../render/weaponSkins', () => ({
  getWeaponTexture: (name: string | undefined) => (name === 'blaster' ? mocks.blasterTexture : undefined),
}));

// Every kind a Pickup can render (@dd/engine's PickupKind) — 'bandage' has no dedicated
// glow colour/shape yet and deliberately falls into the same crystal fallback as
// 'material' (see Pickup.ts's own comment), but it must still not crash and still get
// a glow.
const ALL_KINDS: PickupKind[] = ['heal', 'material', 'weapon', 'buff', 'crate', 'bandage'];

// Children are appended in this fixed order in the constructor — glow first (so the
// crisp shape draws on top of it), then the shape itself. No public API for either
// (same index-by-construction-order convention as TouchControlsView.test.ts).
const enum Child { Glow, Shape }

function glowOf(p: Pickup): Graphics {
  return p.children[Child.Glow] as Graphics;
}
function shapeOf(p: Pickup): Graphics {
  return p.children[Child.Shape] as Graphics;
}

const FRAME_MS = 1000 / 60;

/** The render-only hover height. `Entity.applyTransform` writes `y = groundY - z`, and a
 *  pickup's ground y never moves, so this recovers z without exposing a field for it. */
function zOf(p: Pickup): number {
  return p.curY - p.y;
}

/** Hover heights sampled once per frame over `ms` of wall time, at `dt` per frame. */
function sweep(p: Pickup, ms: number, dt = FRAME_MS): number[] {
  const out: number[] = [];
  for (let t = 0; t < ms; t += dt) {
    p.interpolate(1, dt);
    out.push(zOf(p));
  }
  return out;
}

describe('Pickup — glow ring (design/10 legibility fix, 2026-08-02)', () => {
  it.each(ALL_KINDS)('gives a %s pickup exactly a glow + a crisp shape (2 children)', (kind) => {
    const p = new Pickup(kind);
    expect(p.children.length).toBe(2);
    expect(p.kind).toBe(kind);
  });

  it.each(ALL_KINDS)('blends the %s glow additively, so it never washes out the shape', (kind) => {
    const p = new Pickup(kind);
    expect(glowOf(p).blendMode).toBe('add');
    // The crisp shape must stay a non-additive fill — 'add' on this one would wash it out.
    expect(shapeOf(p).blendMode).not.toBe('add');
  });

  it.each(ALL_KINDS)('draws a %s glow as a ~26px-wide soft circle behind the shape', (kind) => {
    const p = new Pickup(kind);
    const bounds = glowOf(p).getLocalBounds();
    expect(bounds.width).toBeCloseTo(26, 0);
    expect(bounds.height).toBeCloseTo(26, 0);
  });

  it('still gets a soft shadow (Entity.makeShadow), unrelated to the new glow', () => {
    const p = new Pickup('material');
    expect(p.shadow).not.toBeNull();
  });
});

describe('Pickup — ambient hover (strobe fix, 2026-08-15)', () => {
  // The old rate (0.12 rad/ms ≈ 19 Hz) advanced ~2 rad of phase per 60fps frame, right
  // up against the Nyquist limit — it aliased into a refresh-rate-dependent flicker
  // instead of a float. These bounds pin the hover into the same band as the scene's
  // other ambient loops (Portal 0.48 Hz, status aura 1.27 Hz).

  it('advances only a sliver of the arc per 60fps frame (no aliasing)', () => {
    const p = new Pickup('material');
    p.interpolate(1, 0); // settle onto the hover curve first — the very first call also applies the resting height
    const before = zOf(p);
    p.interpolate(1, FRAME_MS);
    // The step is small enough that one frame barely moves the sprite. The previous
    // 2.0 rad/frame swung it across the full amplitude and back every other frame.
    expect(Math.abs(zOf(p) - before)).toBeLessThan(0.5);
  });

  it('completes exactly one hover cycle every 2 seconds', () => {
    const p = new Pickup('material');
    p.interpolate(1, 500); // quarter cycle in → top of the arc (id 0 starts at the midpoint)
    const top = zOf(p);
    p.interpolate(1, 1000); // half a cycle on → bottom of the arc
    expect(top - zOf(p)).toBeGreaterThan(6); // actually travelled, not stalled at rest height
    p.interpolate(1, 1000); // one full period after `top` → same height again
    expect(zOf(p)).toBeCloseTo(top, 5);
  });

  it('gives each drop id a different start phase, so a floor of loot never pulses in unison', () => {
    const a = new Pickup('material', undefined, 1);
    const b = new Pickup('material', undefined, 2);
    a.interpolate(1, FRAME_MS);
    b.interpolate(1, FRAME_MS);
    expect(zOf(a)).not.toBeCloseTo(zOf(b), 1);
  });

  it('is a pure function of the id and the accumulated clock (no Math.random)', () => {
    const a = new Pickup('material', undefined, 7);
    const b = new Pickup('material', undefined, 7);
    a.interpolate(1, 123);
    b.interpolate(1, 60);
    b.interpolate(1, 63); // same total clock, split differently
    expect(zOf(a)).toBeCloseTo(zOf(b), 10);
  });

  it('breathes the glow in phase with the hover, brightest at the top of the arc', () => {
    const p = new Pickup('material');
    p.interpolate(1, 500); // quarter cycle → peak of the sine
    const top = { z: zOf(p), glow: glowOf(p).alpha };
    p.interpolate(1, 1000); // half a cycle later → trough
    expect(top.z).toBeGreaterThan(zOf(p));
    expect(top.glow).toBeGreaterThan(glowOf(p).alpha);
    // Stays a modulation of the existing soft glow, never a hard blink to black.
    expect(glowOf(p).alpha).toBeGreaterThan(0.5);
    // Peaks at exactly 1 — Pixi clamps alpha there, so anything above it would flatten
    // the bright half of the cycle into a plateau instead of a smooth breathe.
    expect(top.glow).toBeCloseTo(1, 5);
  });

  it('never lets the glow clip against Pixi\'s alpha clamp over a full cycle', () => {
    const p = new Pickup('material', undefined, 3);
    let clampedFrames = 0;
    for (let t = 0; t < 2400; t += FRAME_MS) {
      p.interpolate(1, FRAME_MS);
      const a = glowOf(p).alpha;
      expect(a).toBeLessThanOrEqual(1);
      expect(a).toBeGreaterThan(0.5);
      if (a > 0.9999) clampedFrames++;
    }
    // Only the instantaneous peak may touch 1. A whole plateau of clamped frames would
    // mean the breathe is being cut off flat at the top instead of curving through it.
    expect(clampedFrames).toBeLessThan(5);
  });

  it('stays inside a fixed height band and never sinks into the floor', () => {
    const zs = sweep(new Pickup('material', undefined, 5), 4000);
    const lo = Math.min(...zs);
    const hi = Math.max(...zs);
    expect(lo).toBeGreaterThan(0); // still reads as an object hovering above its shadow
    expect(hi - lo).toBeCloseTo(8, 1); // ±4px around rest, the full designed travel
    expect(hi).toBeLessThan(20); // not floating off into the air
  });

  it('leaves the Y-sort key alone, so hovering can never flicker a drop in front of/behind an actor', () => {
    const p = new Pickup('material', undefined, 2);
    p.pushState(100, 250, 0, 0);
    p.snap();
    const seen = new Set<number>();
    for (let t = 0; t < 2400; t += FRAME_MS) {
      p.interpolate(1, FRAME_MS);
      seen.add(p.zIndex);
    }
    // zIndex is the GROUND y (Entity.applyTransform), never the hovering screen y.
    expect([...seen]).toEqual([250]);
  });

  it('runs off wall-clock time, not frame count — 30fps and 144fps agree after the same second', () => {
    const slow = new Pickup('material', undefined, 4);
    const fast = new Pickup('material', undefined, 4);
    sweep(slow, 1000, 1000 / 30);
    sweep(fast, 1000, 1000 / 144);
    expect(zOf(slow)).toBeCloseTo(zOf(fast), 6);
  });

  it('still reads as a smooth arc at 30fps — the worst frame budget is nowhere near aliasing', () => {
    const zs = sweep(new Pickup('material', undefined, 6), 2000, 1000 / 30);
    const biggestStep = zs.slice(1).reduce((m, z, i) => Math.max(m, Math.abs(z - zs[i]!)), 0);
    // A quarter of the 8px travel in one frame would already read as a jump rather than
    // a drift; the old rate moved the full amplitude and back between adjacent frames.
    expect(biggestStep).toBeLessThan(2);
  });

  it.each(ALL_KINDS)('hovers a %s pickup too — no kind is left sitting flat on the floor', (kind) => {
    const zs = sweep(new Pickup(kind, undefined, 1), 2000);
    expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(6);
  });

  it('only bobs the height — the ground position keeps lerping between sim ticks as before', () => {
    const p = new Pickup('material');
    p.pushState(100, 200, 0, 0);
    p.snap();
    p.pushState(300, 400, 0, 0); // one sim tick of travel (a vacuumed drop being pulled in)
    p.interpolate(0.5, FRAME_MS);
    expect(p.x).toBeCloseTo(200, 5); // halfway, untouched by the hover
    expect(p.zIndex).toBeCloseTo(300, 5); // Y-sort follows the interpolated ground y
    const groundY = 300;
    expect(groundY - p.y).toBeGreaterThan(0); // ...while the height does its own thing on top
  });

  it('drifts the shadow with the hover instead of strobing it', () => {
    const p = new Pickup('material');
    p.interpolate(1, 500); // top of the arc
    const top = { scale: p.shadow!.scale.x, alpha: p.shadow!.alpha };
    p.interpolate(1, 1000); // bottom of the arc
    // Higher lift → smaller, fainter shadow (Entity.applyTransform), so the shadow is the
    // second surface the bob shows up on — it strobed right along with the sprite before.
    expect(top.scale).toBeLessThan(p.shadow!.scale.x);
    expect(top.alpha).toBeLessThan(p.shadow!.alpha);
    // ...but gently: a whole half-cycle only moves it a few percent of its size.
    expect(Math.abs(top.scale - p.shadow!.scale.x)).toBeLessThan(0.1);
  });
});

describe('Pickup — the breathing glow is the halo, not the item art', () => {
  it('modulates only the additive glow, leaving the weapon icon at full opacity', () => {
    mocks.blasterTexture = new Texture({ source: new TextureSource({ width: 8, height: 8 }) });
    try {
      const p = new Pickup('weapon', 'blaster', 1);
      const icon = p.children[1] as Sprite;
      p.interpolate(1, 1500); // trough of the breathe — the glow is at its dimmest here
      expect(glowOf(p).alpha).toBeLessThan(1);
      // A dimming pass that caught the icon (or the crisp shape) would read as the whole
      // item fading in and out, which is the flicker this change set out to remove.
      expect(icon.alpha).toBe(1);
      expect((p.children[2] as Graphics).alpha).toBe(1);
    } finally {
      mocks.blasterTexture = undefined;
    }
  });

  it.each(ALL_KINDS)('leaves a %s pickup\'s crisp shape at full opacity while the glow breathes', (kind) => {
    const p = new Pickup(kind, undefined, 2);
    p.interpolate(1, 1500);
    expect(shapeOf(p).alpha).toBe(1);
    expect(glowOf(p).alpha).toBeLessThan(1);
  });
});

describe('Pickup — real weapon icon on the ground (design/03)', () => {
  it('falls back to the double-chevron shape when no texture is resolvable (unknown/unset weaponId)', () => {
    const p = new Pickup('weapon', 'not_a_real_weapon');
    expect(p.children.length).toBe(2); // glow + chevron, no sprite
    expect(shapeOf(p).getLocalBounds().width).toBeGreaterThan(0); // chevron actually drew something
  });

  it('draws the real weapon sprite in place of the chevron once a texture resolves', () => {
    mocks.blasterTexture = new Texture({ source: new TextureSource({ width: 8, height: 8 }) });
    try {
      const p = new Pickup('weapon', 'blaster');
      expect(p.children.length).toBe(3); // glow + icon sprite + the (now-empty) chevron Graphics
      const icon = p.children[1] as Sprite;
      expect(icon.texture).toBe(mocks.blasterTexture);
      const chevron = p.children[2] as Graphics;
      expect(chevron.getLocalBounds().width).toBe(0); // chevron never drew — icon took its place
    } finally {
      mocks.blasterTexture = undefined; // don't leak into later tests
    }
  });
});
