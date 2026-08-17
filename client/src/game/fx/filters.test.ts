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

import { defaultFilterVert, nextPow2 } from 'pixi.js';
import {
  VignetteFilter,
  ChromaticAberrationFilter,
  EnergyShieldFilter,
  OutlineFilter,
  DissolveFilter,
  HeatHazeFilter,
  NormalLitFilter,
} from './filters';

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

// Shader-source contract tests (added 2026-08-15 with the `frameUv` fix). These assert
// GLSL text rather than rendered pixels because nothing in this repo can run a real GL
// context under vitest — but the bug they guard is a pure source-level mistake, so the
// text IS the invariant. See `FRAME_UV` in filters.ts for the mechanism: `vTextureCoord`
// spans 0..(region / pow2-pooled texture), so treating 0.5 as "the centre" silently
// centres the effect on the pool texture instead of on the actor, which is what made the
// shield ring render as a partial crescent at some camera zooms and not others.
describe('region-relative filters normalize vTextureCoord (frameUv)', () => {
  const REGION_RELATIVE = [
    ['VignetteFilter', () => new VignetteFilter()],
    ['ChromaticAberrationFilter', () => new ChromaticAberrationFilter()],
    ['EnergyShieldFilter', () => new EnergyShieldFilter()],
    ['DissolveFilter', () => new DissolveFilter()],
    ['HeatHazeFilter', () => new HeatHazeFilter()],
  ] as const;

  const countOf = (src: string, needle: string) => src.split(needle).length - 1;

  for (const [name, make] of REGION_RELATIVE) {
    it(`${name} derives its position from frameUv, never raw vTextureCoord`, () => {
      const src = make().glProgram.fragment!;
      expect(src).toContain('frameUv(vTextureCoord)');
      // The exact pre-fix expressions — a bare centre and a bare cell grid.
      expect(src).not.toContain('vTextureCoord - vec2(0.5)');
      expect(src).not.toContain('vTextureCoord * 36.0');
    });

    it(`${name} carries the FRAME_UV prelude exactly once (calling it without defining it, or defining it twice, is a runtime-only link failure)`, () => {
      const src = make().glProgram.fragment!;
      // Defined — a shader that CALLS frameUv without the prelude compiles nowhere, and
      // vitest can't see that, so assert the definition is actually present.
      expect(countOf(src, 'vec2 frameUv(vec2 coord)')).toBe(1);
      // ...and only once. Prepending FRAME_UV to a filter that already declares
      // `uInputSize` itself (OutlineFilter/NormalLitFilter) would redeclare both the
      // uniform and the helpers — GL rejects that too.
      expect(countOf(src, 'uniform highp vec4 uInputSize;')).toBe(1);
      expect(countOf(src, 'uniform highp vec4 uOutputFrame;')).toBe(1);
    });
  }

  it('the two filters that DISPLACE their sample point clamp it back inside the region', () => {
    // Sampling past the region reads whatever the last filter to borrow that pooled
    // texture left behind — not transparent black. Only these two move their sample.
    for (const src of [
      new ChromaticAberrationFilter().glProgram.fragment!,
      new HeatHazeFilter().glProgram.fragment!,
    ]) {
      expect(src).toContain('clampToFrame(');
      // A displacement computed in region space has to come back to texcoord space
      // before it is added to vTextureCoord.
      expect(src).toContain('frameOffset(');
    }
  });

  it('OutlineFilter/NormalLitFilter stay on raw texel stepping (uInputSize.zw is already right for that)', () => {
    for (const src of [new OutlineFilter().glProgram.fragment!, new NormalLitFilter().glProgram.fragment!]) {
      expect(src).toContain('uInputSize.zw');
      expect(src).not.toContain('frameUv');
    }
  });

  it('declares every shared filter uniform highp, matching the vertex stage (or GL refuses to link)', () => {
    const all = [
      new VignetteFilter(),
      new ChromaticAberrationFilter(),
      new EnergyShieldFilter(),
      new OutlineFilter(),
      new DissolveFilter(),
      new HeatHazeFilter(),
      new NormalLitFilter(),
    ];
    for (const f of all) {
      for (const decl of f.glProgram.fragment!.matchAll(/uniform\s+(\w+\s+)?vec4\s+(uInputSize|uOutputFrame|uInputClamp)/g)) {
        expect(decl[1]?.trim()).toBe('highp');
      }
    }
  });
});

// The `frameUv` fix is only correct as long as two upstream Pixi behaviours hold. Both
// are load-bearing and neither is part of Pixi's documented public API, so a version bump
// could change either silently — and the symptom would be a shield ring that drifts off
// the character again, which no other test in this repo can see. Pin them here.
describe('Pixi filter-pipeline assumptions frameUv depends on', () => {
  it("defaultFilterVert still scales vTextureCoord by the region/texture ratio (NOT a true 0..1)", () => {
    // If Pixi ever changes this to emit a real 0..1 varying, `frameUv` becomes a second,
    // wrong correction and every filter using it breaks — delete FRAME_UV at that point.
    const normalized = defaultFilterVert.replace(/\s+/g, ' ');
    expect(normalized).toContain('return aPosition * (uOutputFrame.zw * uInputSize.zw);');
  });

  it('pools filter textures at power-of-two dimensions, so region size != texture size', () => {
    // `TexturePool.getOptimalTexture` rounds each dimension up with exactly this call.
    // A region that is already a power of two is the ONLY case where the old
    // `vTextureCoord - 0.5` maths happened to be right.
    expect(nextPow2(200)).toBe(256);
    expect(nextPow2(264)).toBe(512);
    expect(nextPow2(512)).toBe(512);
  });
});

// A numeric model of the bug, driven by Pixi's own `nextPow2`. This mirrors
// `FilterSystem._updateFilterUniforms` + `TexturePool.getOptimalTexture` rather than
// running the real shader (no GL under vitest), so it locks the REASONING, not the
// compiled program — the source-contract tests above are what tie the reasoning to the
// actual GLSL. Its value is that it reproduces, from first principles, the exact
// "some camera zooms are fine and others aren't" pattern that got this bug misdiagnosed
// once already.
describe('the pow2 filter-texture mechanism (why vTextureCoord - 0.5 was wrong)', () => {
  const RESOLUTION = 2; // WebPlatform: Math.min(devicePixelRatio, 2)
  // Actor pins `filterArea` to a 3x-body-radius square; the player's radius is 16px, and
  // NormalLitFilter (always attached) pads the region by 2px per side.
  const REGION_WORLD_PX = 16 * 3 * 2 + 2 * 2;

  /** Where the OLD shader's hardcoded `0.5` actually landed, in 0..1 region space.
   *  0.5 would be the character's centre; 1.0 is the region's far edge. */
  function legacyCentre(zoom: number): number {
    const regionPx = REGION_WORLD_PX * zoom * RESOLUTION;
    const texturePx = nextPow2(Math.ceil(regionPx - 1e-6));
    // vTextureCoord spans 0..(regionPx / texturePx), so 0.5 sits this far across it.
    return 0.5 / (regionPx / texturePx);
  }

  /** The same point under `frameUv` — `coord * uInputSize.xy / uOutputFrame.zw`. */
  function frameUvCentre(zoom: number): number {
    const regionPx = REGION_WORLD_PX * zoom * RESOLUTION;
    const texturePx = nextPow2(Math.ceil(regionPx - 1e-6));
    const centreCoord = 0.5 * (regionPx / texturePx); // the varying at the region's middle
    return centreCoord * (texturePx / regionPx);
  }

  // Every zoom named here was observed live before the fix; the model reproduces which
  // ones looked broken and which looked fine, which is the point of keeping it.
  const ZOOMS = [1, 1.32, 1.5, 1.818, 2, 2.5];

  it('frameUv puts the ring centre exactly at the region centre at every zoom', () => {
    for (const zoom of ZOOMS) expect(frameUvCentre(zoom)).toBeCloseTo(0.5, 10);
  });

  it('a fractional zoom shoved the legacy centre almost onto the region edge (the reported crescent)', () => {
    // The rim band peaks ~0.35 of the region away from its centre, so a centre past ~0.9
    // puts most of the ring outside the region entirely — a partial arc, exactly the
    // user-reported symptom.
    expect(legacyCentre(1.32)).toBeGreaterThan(0.9);
    expect(legacyCentre(1.5)).toBeGreaterThan(0.8);
  });

  it('but integer zooms happened to land near-centre — which is what made it read as "non-integer zoom breaks Pixi"', () => {
    expect(legacyCentre(1)).toBeLessThan(0.7);
    expect(legacyCentre(2)).toBeLessThan(0.7);
  });

  it('is never off by less than the pow2 slack — the legacy centre can only ever overshoot', () => {
    for (const zoom of ZOOMS) expect(legacyCentre(zoom)).toBeGreaterThanOrEqual(0.5);
  });
});

describe('EnergyShieldFilter viewport clipping', () => {
  it('opts out of viewport clipping so a shielded actor at a screen edge keeps a centered ring', () => {
    expect(new EnergyShieldFilter().clipToViewport).toBe(false);
  });

  it('leaves the two screen-wide post-fx clipped (they size themselves to the viewport)', () => {
    expect(new VignetteFilter().clipToViewport).toBe(true);
    expect(new ChromaticAberrationFilter().clipToViewport).toBe(true);
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

// Shimmer PACE (2026-08-17, live report: "护盾的闪烁频率降低"). Another shader-source
// contract test, for the same reason as the `frameUv` block above — no GL context under
// vitest — but asserted as a derived FREQUENCY rather than as the literal constant, so
// it guards the intent ("a slow breathing pulse, not a strobe on the character's
// silhouette") instead of pinning a number nobody may retune.
describe('EnergyShieldFilter shimmer pace', () => {
  /**
   * GLSL with its comments removed. Necessary, not incidental: the shield shader's own
   * comment quotes the PREVIOUS shimmer expression verbatim to explain what was wrong
   * with it, so a naive source scan matches the old constants and reports the bug it is
   * supposed to catch. (Written after doing exactly that.) Anything scanning shader text
   * for a value should strip comments the same way.
   */
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');

  /** The `sin(uTime * K + ...)` coefficient, in radians per millisecond. */
  function timeCoefficient(src: string): number {
    const m = /sin\(uTime \* ([0-9.]+)/.exec(code(src));
    if (!m) throw new Error('shield shader no longer has a `sin(uTime * K` shimmer term');
    return Number(m[1]);
  }

  /** The `+ dist * K` radial-banding coefficient inside the same sin(). */
  function radialCoefficient(src: string): number {
    const m = /sin\(uTime \* [0-9.]+ \+ dist \* ([0-9.]+)\)/.exec(code(src));
    if (!m) throw new Error('shield shader no longer has a `+ dist * K` radial term');
    return Number(m[1]);
  }

  it('pulses well under 0.5 Hz — a breath, not a flicker', () => {
    const hz = (timeCoefficient(new EnergyShieldFilter().glProgram.fragment!) * 1000) / (2 * Math.PI);
    expect(hz).toBeGreaterThan(0); // still animated at all
    expect(hz).toBeLessThan(0.5); // was ~0.95 Hz, which read as a strobe
  });

  it('never dims the ring below 50% of its peak — a live shield stays readable throughout', () => {
    // `shimmer = base + swing * sin(...)`, so the trough is base - swing.
    const src = new EnergyShieldFilter().glProgram.fragment!;
    const m = /float shimmer = ([0-9.]+) \+ ([0-9.]+) \* sin\(/.exec(code(src));
    expect(m).not.toBeNull();
    const [base, swing] = [Number(m![1]), Number(m![2])];
    expect(base + swing).toBeCloseTo(1, 6); // peak is full brightness
    expect(base - swing).toBeGreaterThanOrEqual(0.5);
  });

  it('keeps the radial banding coarse enough that a slow pulse does not read as ripple', () => {
    // The `dist * K` term makes K concentric bands across the rim; scroll enough of them
    // past and a slowed-down pulse turns back into visible travelling ripple, which is
    // the same complaint by another route.
    expect(radialCoefficient(new EnergyShieldFilter().glProgram.fragment!)).toBeLessThanOrEqual(12);
  });
});
