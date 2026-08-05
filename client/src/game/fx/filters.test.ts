import { describe, it, expect, vi, beforeAll } from 'vitest';

// VignetteFilter/ChromaticAberrationFilter build a real WebGL `GlProgram` at
// construction time via `GlProgram.from()`, which — unlike the 5 other filters in this
// file — is never exercised for real anywhere else: FxController.test.ts stubs this
// whole module with hand-rolled mocks, and Actor.test.ts doesn't touch these two at
// all. `GlProgram.from()` only needs a `document.createElement('canvas')` that returns
// something with a `getContext()` method (pixi.js's `getMaxFragmentPrecision` probes it
// then falls back to 'mediump' if it returns null/undefined — see
// node_modules/pixi.js/lib/rendering/renderers/gl/shader/program/getMaxFragmentPrecision.mjs)
// — no real WebGL context is ever created, so a tiny stub is enough; this repo's plain
// -node vitest otherwise has no `document` at all (same "no jsdom" note as
// bootError.test.ts/store.test.ts).
beforeAll(() => {
  vi.stubGlobal('document', {
    createElement: () => ({ width: 0, height: 0, getContext: () => null }),
  });
});

import { VignetteFilter, ChromaticAberrationFilter, EnergyShieldFilter } from './filters';

describe('VignetteFilter', () => {
  it('constructs with the documented defaults', () => {
    const f = new VignetteFilter();
    expect(f.intensity).toBeCloseTo(0.35);
    expect(f.radius).toBeCloseTo(0.55);
  });

  it('constructs with caller-supplied intensity/radius', () => {
    const f = new VignetteFilter(0.8, 0.2);
    expect(f.intensity).toBeCloseTo(0.8);
    expect(f.radius).toBeCloseTo(0.2);
  });

  it('intensity getter/setter round-trips through the uniform group', () => {
    const f = new VignetteFilter();
    f.intensity = 0.9;
    expect(f.intensity).toBe(0.9);
  });

  it('radius getter/setter round-trips through the uniform group', () => {
    const f = new VignetteFilter();
    f.radius = 0.1;
    expect(f.radius).toBe(0.1);
  });
});

describe('ChromaticAberrationFilter', () => {
  it('constructs with amount 0 by default', () => {
    const f = new ChromaticAberrationFilter();
    expect(f.amount).toBe(0);
  });

  it('constructs with a caller-supplied amount', () => {
    const f = new ChromaticAberrationFilter(0.05);
    expect(f.amount).toBeCloseTo(0.05);
  });

  it('amount getter/setter round-trips through the uniform group (Game.ts decays this each frame)', () => {
    const f = new ChromaticAberrationFilter();
    f.amount = 0.02;
    expect(f.amount).toBeCloseTo(0.02);
    f.amount = 0;
    expect(f.amount).toBe(0);
  });
});

// `hexToRgb` and `tick()` live in this same file but belong to the other 5 filters
// (EnergyShieldFilter/OutlineFilter/DissolveFilter/HeatHazeFilter/NormalLitFilter).
// Every existing test that touches those replaces the whole module with hand-rolled
// mocks (Actor.test.ts, FxController.test.ts via this file), so `hexToRgb`'s actual
// bit-shifting/normalization and `tick()`'s clock accumulation have never run for real
// either — closing that gap here costs nothing extra now that `document` is stubbed.
// `EnergyShieldFilter` is the one class that exercises both in a single instance.
describe('hexToRgb (exercised via EnergyShieldFilter color uniform)', () => {
  it('normalizes a hex color into 0..1 RGB channels', () => {
    const f = new EnergyShieldFilter(0x66e0ff);
    const [r, g, b] = f.resources.shieldUniforms.uniforms.uColor as [number, number, number];
    expect(r).toBeCloseTo(0x66 / 255);
    expect(g).toBeCloseTo(0xe0 / 255);
    expect(b).toBeCloseTo(0xff / 255);
  });

  it('re-derives RGB channels when `color` is reassigned', () => {
    const f = new EnergyShieldFilter(0x000000);
    f.color = 0xff0000;
    const [r, g, b] = f.resources.shieldUniforms.uniforms.uColor as [number, number, number];
    expect(r).toBeCloseTo(1);
    expect(g).toBe(0);
    expect(b).toBe(0);
  });
});

describe('EnergyShieldFilter.tick', () => {
  it('advances the shimmer clock uniform by frameDt on each call', () => {
    const f = new EnergyShieldFilter();
    expect(f.resources.shieldUniforms.uniforms.uTime).toBe(0);
    f.tick(16);
    expect(f.resources.shieldUniforms.uniforms.uTime).toBe(16);
    f.tick(16);
    expect(f.resources.shieldUniforms.uniforms.uTime).toBe(32);
  });
});
