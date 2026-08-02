import { describe, it, expect } from 'vitest';
import type { Graphics } from 'pixi.js';
import { Pickup, type PickupKind } from './Pickup';

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
