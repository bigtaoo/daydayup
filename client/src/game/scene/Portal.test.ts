/**
 * Portal — the extraction-checkpoint gate (design/10 legibility fix, 2026-08-02):
 * a glow + ring built once in the constructor, hidden until `setOpen(true)`, and a
 * pulsing-alpha override layered on top of Entity.interpolate's normal position lerp.
 */
import { describe, it, expect } from 'vitest';
import type { Graphics } from 'pixi.js';
import { Portal } from './Portal';

const enum Child { Glow, Ring }
function glowOf(p: Portal): Graphics {
  return p.children[Child.Glow] as Graphics;
}
function ringOf(p: Portal): Graphics {
  return p.children[Child.Ring] as Graphics;
}

describe('Portal — construction', () => {
  it('builds exactly a glow + a ring (2 children) plus a soft shadow', () => {
    const p = new Portal();
    expect(p.children.length).toBe(2);
    expect(p.shadow).not.toBeNull();
  });

  it('the glow blends additively behind the crisp ring', () => {
    const p = new Portal();
    expect(glowOf(p).blendMode).toBe('add');
    expect(ringOf(p).blendMode).not.toBe('add');
  });

  it('both shapes actually draw geometry (non-zero bounds), scaled by radiusPx', () => {
    const small = new Portal(10);
    const big = new Portal(50);
    expect(ringOf(small).getLocalBounds().width).toBeGreaterThan(0);
    expect(ringOf(big).getLocalBounds().width).toBeGreaterThan(ringOf(small).getLocalBounds().width);
  });

  it('starts hidden (waves not yet exhausted)', () => {
    const p = new Portal();
    expect(p.visible).toBe(false);
  });
});

describe('Portal.setOpen', () => {
  it('toggles visibility both ways', () => {
    const p = new Portal();
    p.setOpen(true);
    expect(p.visible).toBe(true);
    p.setOpen(false);
    expect(p.visible).toBe(false);
  });
});

describe('Portal.interpolate — pulsing-alpha override', () => {
  it('overrides alpha with a sine pulse driven by the accumulated frameDt clock', () => {
    const p = new Portal();
    p.interpolate(1, 100); // t = 100
    expect(p.alpha).toBeCloseTo(0.85 + 0.15 * Math.sin(100 * 0.003), 10);
  });

  it('the pulse clock accumulates across calls (t keeps advancing, not reset per frame)', () => {
    const p = new Portal();
    p.interpolate(1, 100);
    p.interpolate(1, 50);
    // t is now 150
    expect(p.alpha).toBeCloseTo(0.85 + 0.15 * Math.sin(150 * 0.003), 10);
  });

  it('still applies the base Entity position interpolation underneath the alpha override', () => {
    const p = new Portal();
    p.pushState(10, 20, 0, 0);
    p.snap();
    p.pushState(30, 40, 0, 0);
    p.interpolate(0.5, 16);
    expect(p.x).toBeCloseTo(20, 6); // (10+30)/2
    expect(p.y).toBeCloseTo(30, 6); // (20+40)/2, z=0
  });
});
