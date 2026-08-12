/**
 * Portal — the extraction-checkpoint gate (design/10 legibility fix, 2026-08-02; VFX
 * redesign 2026-08-12). Built once in the constructor from static geometry (ground
 * glow, standing arch frame, a two-ring vortex + core), hidden until `setOpen(true)`,
 * animated in `interpolate` via ring rotation, an alpha pulse, and per-frame-redrawn
 * inward-spiralling particles — all deterministic functions of the accumulated
 * `frameDt` clock (no Math.random, so behavior at a given `t` is exactly reproducible).
 */
import { describe, it, expect, vi } from 'vitest';
import type { Container, Graphics } from 'pixi.js';
import { Portal } from './Portal';

const enum Child {
  GroundGlow,
  Frame,
  Vortex,
  Particles,
}
function groundGlowOf(p: Portal): Graphics {
  return p.children[Child.GroundGlow] as Graphics;
}
function frameOf(p: Portal): Graphics {
  return p.children[Child.Frame] as Graphics;
}
function vortexOf(p: Portal): Container {
  return p.children[Child.Vortex] as Container;
}
function particlesOf(p: Portal): Graphics {
  return p.children[Child.Particles] as Graphics;
}

describe('Portal — construction', () => {
  it('builds groundGlow + frame + vortex + particles (4 children) plus a soft shadow', () => {
    const p = new Portal();
    expect(p.children.length).toBe(4);
    expect(p.shadow).not.toBeNull();
  });

  it('the vortex holds two counter-spinning rings plus a bright core (3 children)', () => {
    const p = new Portal();
    expect(vortexOf(p).children.length).toBe(3);
  });

  it('the ground glow blends additively behind the crisp frame', () => {
    const p = new Portal();
    expect(groundGlowOf(p).blendMode).toBe('add');
    expect(frameOf(p).blendMode).not.toBe('add');
  });

  it('all shapes actually draw geometry (non-zero bounds), scaled by radiusPx', () => {
    const small = new Portal(10);
    const big = new Portal(50);
    expect(frameOf(small).getLocalBounds().width).toBeGreaterThan(0);
    expect(frameOf(big).getLocalBounds().width).toBeGreaterThan(frameOf(small).getLocalBounds().width);
  });

  it('the vortex rings also draw non-zero, radius-scaled geometry', () => {
    const small = new Portal(10);
    const big = new Portal(50);
    const [ringASmall] = vortexOf(small).children as Graphics[];
    const [ringABig] = vortexOf(big).children as Graphics[];
    expect(ringASmall!.getLocalBounds().width).toBeGreaterThan(0);
    expect(ringABig!.getLocalBounds().width).toBeGreaterThan(ringASmall!.getLocalBounds().width);
  });

  it('the core is a distinct, non-zero-bounds shape at the vortex center', () => {
    const p = new Portal();
    const core = vortexOf(p).children[2] as Graphics;
    expect(core.getLocalBounds().width).toBeGreaterThan(0);
  });

  it('starts hidden (checkpoint not yet reached)', () => {
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

describe('Portal.interpolate — animation', () => {
  it('overrides alpha with a sine pulse driven by the accumulated frameDt clock', () => {
    const p = new Portal();
    p.interpolate(1, 100); // t = 100
    expect(p.alpha).toBeCloseTo(0.9 + 0.1 * Math.sin(100 * 0.003), 10);
  });

  it('the pulse clock accumulates across calls (t keeps advancing, not reset per frame)', () => {
    const p = new Portal();
    p.interpolate(1, 100);
    p.interpolate(1, 50);
    // t is now 150
    expect(p.alpha).toBeCloseTo(0.9 + 0.1 * Math.sin(150 * 0.003), 10);
  });

  it('the two vortex rings spin in opposite directions, at different speeds', () => {
    const p = new Portal();
    const vortex = vortexOf(p);
    const [ringA, ringB] = vortex.children as [Graphics, Graphics];
    expect(ringA.rotation).toBe(0);
    expect(ringB.rotation).toBe(0);
    p.interpolate(1, 100);
    expect(ringA.rotation).toBeGreaterThan(0);
    expect(ringB.rotation).toBeLessThan(0);
    expect(Math.abs(ringB.rotation)).toBeGreaterThan(Math.abs(ringA.rotation));
  });

  it('redraws the particle field every frame without throwing, keeping a stable point count', () => {
    const p = new Portal();
    for (let i = 0; i < 30; i++) p.interpolate(1, 16);
    expect(() => p.interpolate(1, 16)).not.toThrow();
    expect(particlesOf(p).getLocalBounds().width).toBeGreaterThan(0);
  });

  it('still applies the base Entity position interpolation underneath the animation', () => {
    const p = new Portal();
    p.pushState(10, 20, 0, 0);
    p.snap();
    p.pushState(30, 40, 0, 0);
    p.interpolate(0.5, 16);
    expect(p.x).toBeCloseTo(20, 6); // (10+30)/2
    expect(p.y).toBeCloseTo(30, 6); // (20+40)/2, z=0
  });
});

describe('Portal.interpolate — particle field (deterministic spiral-in motes)', () => {
  const PARTICLE_COUNT = 10; // mirrors Portal.ts's own module-level PARTICLE_COUNT

  it('redraws exactly PARTICLE_COUNT motes per frame via clear() + circle(), not accumulating', () => {
    const p = new Portal();
    const particles = particlesOf(p);
    const clearSpy = vi.spyOn(particles, 'clear');
    const circleSpy = vi.spyOn(particles, 'circle');

    p.interpolate(1, 16);
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(circleSpy).toHaveBeenCalledTimes(PARTICLE_COUNT);

    p.interpolate(1, 16);
    expect(clearSpy).toHaveBeenCalledTimes(2);
    expect(circleSpy).toHaveBeenCalledTimes(2 * PARTICLE_COUNT);
  });

  it('is a pure function of the accumulated clock — the same t reached via different step sequences draws identical motes', () => {
    const a = new Portal();
    const b = new Portal();
    const circleSpyA = vi.spyOn(particlesOf(a), 'circle');
    const circleSpyB = vi.spyOn(particlesOf(b), 'circle');

    a.interpolate(1, 60);
    a.interpolate(1, 40); // t = 100, reached in two steps
    b.interpolate(1, 100); // t = 100, reached in one step

    const lastFrameA = circleSpyA.mock.calls.slice(-PARTICLE_COUNT);
    expect(circleSpyB.mock.calls).toEqual(lastFrameA);
  });

  it('motes actually move between frames — not frozen geometry redrawn identically', () => {
    const p = new Portal();
    const circleSpy = vi.spyOn(particlesOf(p), 'circle');

    p.interpolate(1, 16);
    const firstFrame = circleSpy.mock.calls.slice(-PARTICLE_COUNT).map((args) => [args[0], args[1]]);

    p.interpolate(1, 800);
    const laterFrame = circleSpy.mock.calls.slice(-PARTICLE_COUNT).map((args) => [args[0], args[1]]);

    expect(laterFrame).not.toEqual(firstFrame);
  });
});
