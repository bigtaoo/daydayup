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
  MAX_SCENE_LIGHTS,
  FLAT_KEY,
  flatReference,
  VignetteFilter,
  ChromaticAberrationFilter,
  EnergyShieldFilter,
  OutlineFilter,
  DissolveFilter,
  HeatHazeFilter,
  SceneLightFilter,
  FRAME_UV,
  hexToRgb,
} from './filters';
import { SHADOW_SQUASH } from '../scene/Entity';

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
// (EnergyShieldFilter/OutlineFilter/DissolveFilter/HeatHazeFilter/SceneLightFilter).
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
    // Joined 2026-08-24: the scene-lighting pass maps each texel to a WORLD position, which
    // is a region-relative read and so has exactly the pow2-pool trap this suite is about.
    ['SceneLightFilter', () => new SceneLightFilter()],
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
      // ...and only once. Prepending FRAME_UV to a filter that ALSO declares `uInputSize`
      // itself redeclares both the uniform and the helpers, and GL rejects that with
      // 'uInputSize : redefinition'. This is not hypothetical: SceneLightFilter shipped that
      // exact mistake for one iteration on 2026-08-24, and a filter whose program fails to
      // compile renders its whole layer BLACK rather than failing loudly.
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

  it('OutlineFilter stays on raw texel stepping (uInputSize.zw is already right for that)', () => {
    // It only ever steps by ONE TEXEL, never to a position, so the pool-texture trap above
    // cannot reach it. SceneLightFilter does both: texel stepping for its normal AND a
    // region-relative world position, which is why it appears in the list above instead.
    const src = new OutlineFilter().glProgram.fragment!;
    expect(src).toContain('uInputSize.zw');
    expect(src).not.toContain('frameUv');
  });

  it('declares every shared filter uniform highp, matching the vertex stage (or GL refuses to link)', () => {
    const all = [
      new VignetteFilter(),
      new ChromaticAberrationFilter(),
      new EnergyShieldFilter(),
      new OutlineFilter(),
      new DissolveFilter(),
      new HeatHazeFilter(),
      new SceneLightFilter(),
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
  // Actor pins `filterArea` to a 3x-body-radius square; the player's radius is 16px, and the
  // always-attached NormalLitFilter of the day padded the region by 2px per side. Kept AS IT
  // WAS WHEN THE BUG WAS REPORTED on purpose — this suite reproduces a specific historical
  // symptom from first principles, so it has to model that frame's geometry, not today's
  // (the lit filter and its padding left the actor on 2026-08-24). The live geometry is
  // asserted by the source-contract tests above, which is where a change to it belongs.
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

// What is left here after the 2026-08-26 shell rewrite: the handful of shield claims that text
// really is the right evidence for. Everything about the SHAPE moved to
// `filters/shieldShellModel.test.ts`, which runs the shader instead of reading it.
//
// That move was overdue and the rewrite forced it. This block used to pin the shape as literal
// source patterns — `shell * (FILL * (1.0 - K * color.a) + K2 * fresnel)`, `1.0 - smoothstep(
// SHELL_R, SHELL_R + K, dist)`, `float shimmer = A + B * sin(` — and every one of them passed
// against a shader whose brightness peaked exactly at the silhouette, i.e. against a ring. They
// were not wrong about their own clauses; they were asking about spelling when the question was
// about a profile. A regex cannot tell a rind from a line, and pinning the spelling made the
// shape harder to change than it made it safe.
describe('EnergyShieldFilter shell shape (the claims text is good evidence for)', () => {
  /** Shader source with comments stripped, so a number quoted in a comment cannot satisfy a
   *  regex meant to read the real code. The shield's own comments quote superseded formulas to
   *  explain what was wrong with them, so a naive scan matches the bug it is meant to catch. */
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');

  it('is a screen-space CIRCLE — a sphere around the body, not a disc on the floor', () => {
    // The 2026-08-18 depth pass squashed this vertically by SHADOW_SQUASH, reasoning that every
    // round thing wrapping a body in a tilted view foreshortens the same way. It does not: a
    // shadow and a status aura lie flat on the ground plane (so the tilt compresses them), while
    // a shield is a sphere AROUND the body, and a sphere's silhouette is a circle from every
    // angle. On screen the squashed version read as a flat hoop threaded through the character
    // at gun height — the reported "圆圈". These are what stop that fix being re-applied.
    const src = code(new EnergyShieldFilter().glProgram.fragment!);
    expect(src).not.toMatch(/uv\.y\s*[/*]=/);
    expect(src).not.toContain('uSquash');
  });

  it('does not take the ground shadow squash constant back by another name', () => {
    // The regression this guards is a NUMBER, not an identifier: re-introducing 0.62 (or its
    // reciprocal) on the vertical axis reproduces the flat hoop whatever the uniform is called.
    const src = code(new EnergyShieldFilter().glProgram.fragment!);
    expect(/uv\.y\s*[/*]=\s*([0-9.]+)/.exec(src)).toBeNull();
    expect(SHADOW_SQUASH).toBeLessThan(1); // the shadow itself is still an ellipse
  });

  it('derives the radius from an unmodified uv, so both axes reach equally far', () => {
    // `length(uv)` over a raw region-centred uv IS the circle. Anything that scaled one
    // component before this line would be an ellipse again.
    const src = code(new EnergyShieldFilter().glProgram.fragment!);
    const between = src.slice(src.indexOf('vec2 uv ='), src.indexOf('float dist'));
    expect(between).not.toMatch(/uv\.[xy]\s*[/*+-]?=/);
    expect(src).toContain('float dist = length(uv)');
  });

  it('encloses the whole character at ~1.9 body radii instead of ballooning past 2.1', () => {
    // The shell's SIZE, in the only unit that means anything to a player. `Actor` pins this
    // filter's area to a square `radiusPx * 3` per side, so `uv` spans ±0.5 across 6 body radii
    // and `dist = length(uv) * sqrt(2)`; a `dist` of D sits `D * 6 / sqrt(2)` body radii out.
    // Measured before the 2026-08-19 pass: the band peaked at 2.1 body radii, blanketing the
    // floor around a shielded actor's feet and hiding the ground shadow entirely.
    const src = code(new EnergyShieldFilter().glProgram.fragment!);
    const m = /const float SHELL_R = ([0-9.]+);/.exec(src);
    if (!m) throw new Error('shield shader no longer declares `const float SHELL_R`');
    const radii = (Number(m[1]) * 6) / Math.SQRT2;
    expect(radii).toBeGreaterThan(1.7); // encloses the whole character, mounted weapon included
    expect(radii).toBeLessThan(2.1); // ...and is not a pool on the floor
  });

  it('binds the membrane tile it samples', () => {
    // A sampler declared in GLSL but never handed a resource reads as black on some drivers and
    // as whatever was last bound on others — i.e. the membrane would silently vanish, or worse,
    // silently become another actor's texture. Neither shows up in a shape test.
    const f = new EnergyShieldFilter();
    const declared = [...code(f.glProgram.fragment!).matchAll(/uniform sampler2D (\w+);/g)]
      .map((m) => m[1]!)
      .filter((n) => n !== 'uTexture'); // Pixi binds the filter's own input itself
    expect(declared.length).toBeGreaterThan(0);
    for (const name of declared) expect(f.resources[name]).toBeDefined();
  });

  it('parks the impact clock instead of letting it run for the whole session', () => {
    // `exp(-uHit.z * k)` over an unbounded `uHit.z` eventually underflows to a denormal, which
    // some mobile GPUs flush to zero and others make very slow. `tick` clamps it.
    const f = new EnergyShieldFilter();
    const rest = f.hitAge;
    expect(rest).toBeGreaterThan(0);
    for (let i = 0; i < 100; i++) f.tick(1000);
    expect(f.hitAge).toBe(rest);
    f.hit(1, 0);
    expect(f.hitAge).toBe(0);
    f.tick(16);
    expect(f.hitAge).toBe(16);
  });

  it('normalizes the impact axis, and keeps the last one for a zero-length delta', () => {
    // A hit resolved exactly on the actor's own centre must not produce a NaN axis — every term
    // downstream of `uHit.xy` would then be NaN, which on a GPU is a black or white square.
    const f = new EnergyShieldFilter();
    f.hit(3, 4);
    const hit = f.resources.shieldUniforms.uniforms.uHit as number[];
    expect(Math.hypot(hit[0]!, hit[1]!)).toBeCloseTo(1, 9);
    f.tick(50);
    f.hit(0, 0);
    const after = f.resources.shieldUniforms.uniforms.uHit as number[];
    expect(after.slice(0, 2)).toEqual(hit.slice(0, 2)); // axis kept
    expect(after[2]).toBe(0); // ...but it is still a new impact
    expect(Number.isNaN(after[0])).toBe(false);
  });
});

// 2026-08-24: lighting moved from one filter PER ACTOR to one pass over the whole scene
// layer (see fx/filters/litFx.ts for the measurement that forced it). What these pin is the
// two things that move with it: the shading has to stay neutral on a flat surface (the pass
// now covers pre-shaded floor/wall art that must not be darkened), and the light set has to
// reach the shader as a bounded, in-place-written array.
describe('SceneLightFilter shading', () => {
  it('keeps the actor tuning the per-actor filter shipped with', () => {
    const f = new SceneLightFilter();
    expect(f.ambient).toBeCloseTo(0.55, 6);
    expect(f.gradient).toBeCloseTo(7.0, 6);
  });

  it('normalizes so a FLAT unlit texel comes out at exactly its painted colour', () => {
    // The whole reason the same ambient/key numbers can now apply to the environment: the
    // shader divides by this reference, so relief and lights read as relative brightening
    // and darkening of authored art instead of a flat ~21% dimming of the entire scene.
    const f = new SceneLightFilter();
    expect(f.flatReference).toBeCloseTo(f.ambient + FLAT_KEY * 0.55, 6);
    // ...and that divisor genuinely cancels: (ambient + flatKey*key) / itself is 1.
    expect((f.ambient + FLAT_KEY * 0.55) / f.flatReference).toBeCloseTo(1, 9);
  });

  it('takes FLAT_KEY from the shader own KEY_DIR, not a second copy of the number', () => {
    // A KEY_DIR edit that left FLAT_KEY behind would silently tint the whole scene, since
    // the divisor would no longer be what a flat texel actually computes.
    const src = new SceneLightFilter().glProgram.fragment!;
    const m = /const vec3 KEY_DIR = vec3\(([-0-9.]+), ([-0-9.]+), ([0-9.]+)\)/.exec(src);
    if (!m) throw new Error('scene-light shader no longer declares KEY_DIR');
    // dot(vec3(0,0,1), KEY_DIR) is just KEY_DIR.z.
    expect(Number(m[3])).toBeCloseTo(FLAT_KEY, 4);
  });

  it('divides by the reference rather than baking it into the ambient constant', () => {
    const src = new SceneLightFilter().glProgram.fragment!;
    expect(src).toContain('uniform float uFlatReference;');
    expect(src).toContain('lit / uFlatReference');
  });

  it('accepts a per-call-site look, and re-derives the reference from it', () => {
    // The reference is a FUNCTION of ambient and key: an override that changed one without
    // the other would put the neutral point somewhere other than 1.0 and tint the scene.
    const f = new SceneLightFilter({ ambient: 0.86, gradient: 2.6, keyIntensity: 0.3 });
    expect(f.ambient).toBeCloseTo(0.86, 6);
    expect(f.gradient).toBeCloseTo(2.6, 6);
    expect(f.flatReference).toBeCloseTo(flatReference(0.86, 0.3), 9);
  });

  it('drives ambient and gradient from uniforms, so every look shares one compiled program', () => {
    const src = new SceneLightFilter().glProgram.fragment!;
    expect(src).toContain('uniform float uAmbient;');
    expect(src).toContain('uniform float uGradient;');
    expect(src).not.toContain('GRADIENT_STRENGTH'); // the old hardcoded constant is gone
  });
});

describe('SceneLightFilter lights', () => {
  const uniformsOf = (f: SceneLightFilter) =>
    (f.resources.sceneLightUniforms as { uniforms: Record<string, unknown> }).uniforms;

  it('starts with no lights, so an un-synced filter is key-light only', () => {
    expect(new SceneLightFilter().lightCount).toBe(0);
  });

  it('packs position, radius and intensity into one vec4 per light', () => {
    const f = new SceneLightFilter();
    f.setLights([{ x: 12, y: -34, radius: 140, intensity: 0.35, color: 0xffffff }]);
    const data = uniformsOf(f).uLights as Float32Array;
    expect([...data.slice(0, 4)]).toEqual([12, -34, 140, 0.3499999940395355]);
    expect(f.lightCount).toBe(1);
  });

  it('writes colours as 0..1 triples in the matching slot', () => {
    const f = new SceneLightFilter();
    f.setLights([
      { x: 0, y: 0, radius: 1, intensity: 1, color: 0x000000 },
      { x: 0, y: 0, radius: 1, intensity: 1, color: 0xff8000 },
    ]);
    const c = uniformsOf(f).uLightColors as Float32Array;
    expect([...c.slice(0, 3)]).toEqual([0, 0, 0]);
    expect(c[3]).toBeCloseTo(1);
    expect(c[4]).toBeCloseTo(128 / 255);
    expect(c[5]).toBeCloseTo(0);
  });

  it('mutates the same buffers rather than allocating per frame', () => {
    // This runs every rendered frame; a fresh Float32Array each time is exactly the churn
    // the move away from per-actor filters was about.
    const f = new SceneLightFilter();
    const before = uniformsOf(f).uLights;
    f.setLights([{ x: 1, y: 2, radius: 3, intensity: 4, color: 0xffffff }]);
    expect(uniformsOf(f).uLights).toBe(before);
  });

  it('never writes past its slot count, however many lights it is handed', () => {
    // The shader loop is bounded by a compile-time constant; a longer array would run off
    // the end of the buffer (or silently corrupt the colour array next to it).
    const f = new SceneLightFilter();
    const many = Array.from({ length: MAX_SCENE_LIGHTS + 5 }, (_, i) => ({
      x: i, y: 0, radius: 1, intensity: 1, color: 0xffffff,
    }));
    f.setLights(many);
    expect(f.lightCount).toBe(MAX_SCENE_LIGHTS);
    expect((uniformsOf(f).uLights as Float32Array).length).toBe(MAX_SCENE_LIGHTS * 4);
  });

  it('honours an explicit count shorter than the array — the caller owns a reusable buffer', () => {
    // `LightRegistry.snapshot` returns a count and leaves stale entries past it; reading
    // `lights.length` instead would resurrect last frame's expired flashes.
    const f = new SceneLightFilter();
    const buf = [
      { x: 1, y: 1, radius: 1, intensity: 1, color: 0xffffff },
      { x: 9, y: 9, radius: 9, intensity: 9, color: 0xff0000 },
    ];
    f.setLights(buf, 1);
    expect(f.lightCount).toBe(1);
  });

  it('bounds the shader loop by the same constant the buffers are sized to', () => {
    const src = new SceneLightFilter().glProgram.fragment!;
    expect(src).toContain('uniform vec4 uLights[' + MAX_SCENE_LIGHTS + '];');
    expect(src).toContain('for (int i = 0; i < ' + MAX_SCENE_LIGHTS + '; i++)');
    expect(src).toContain('if (i >= uLightCount) break;');
  });

  it('records the world rect it was given, clamping a degenerate size', () => {
    const f = new SceneLightFilter();
    f.setRegion(400, 348, 800, 600);
    expect([...f.region]).toEqual([400, 348, 800, 600]);
    f.setRegion(0, 0, 0, 0); // a zero-size viewport would divide the world mapping by zero
    expect([...f.region]).toEqual([0, 0, 1, 1]);
  });

  it('mutates the region array in place too', () => {
    const f = new SceneLightFilter();
    const before = f.region;
    f.setRegion(1, 2, 3, 4);
    expect(f.region).toBe(before);
  });

  it('maps a texel through the region, so lights are compared in WORLD space', () => {
    const src = new SceneLightFilter().glProgram.fragment!;
    expect(src).toContain('uRegion.xy + frameUv(vTextureCoord) * uRegion.zw');
  });
});

// The 4-way split of this file (2026-08-18, 500-line convention) has exactly one regression mode:
// a symbol that stops being reachable from the original import path. Every caller in the codebase
// imports `game/fx/filters`, so the shell is the contract.
describe('game/fx/filters — the assembly shell after the split', () => {
  it('still exports every filter class from the original path', () => {
    for (const cls of [
      VignetteFilter,
      ChromaticAberrationFilter,
      EnergyShieldFilter,
      OutlineFilter,
      DissolveFilter,
      HeatHazeFilter,
      SceneLightFilter,
    ]) {
      expect(typeof cls).toBe('function');
    }
  });

  it('re-exports the shared GLSL prelude and the colour helper', () => {
    // `FRAME_UV` was file-private before the split and had to become an export for the sibling
    // modules to share it; the shell keeps it reachable so nothing outside has to know it moved.
    expect(FRAME_UV).toContain('vec2 frameUv(vec2 coord)');
    expect(hexToRgb(0xff8000)).toEqual([1, 128 / 255, 0]);
  });

  it('gives every filter its own distinct shader — the split copied nothing', () => {
    // Moving seven fragment sources across four new files is exactly the kind of edit that
    // duplicates one and drops another; two classes ending up on the same source would be
    // invisible at runtime until the wrong effect appeared on screen.
    const sources = [
      new VignetteFilter().glProgram.fragment,
      new ChromaticAberrationFilter().glProgram.fragment,
      new EnergyShieldFilter().glProgram.fragment,
      new OutlineFilter().glProgram.fragment,
      new DissolveFilter().glProgram.fragment,
      new HeatHazeFilter().glProgram.fragment,
      new SceneLightFilter().glProgram.fragment,
    ];
    for (const s of sources) expect(s).toBeTruthy();
    expect(new Set(sources).size).toBe(sources.length);
  });

  it('shares ONE copy of the prelude — the split did not fork FRAME_UV per module', () => {
    // `screenFx.ts` and `skinFx.ts` both need it. Pasting it into each is the tempting shortcut
    // and would let the two drift, which is how the original crescent bug got its long life.
    const withPrelude = [
      new VignetteFilter().glProgram.fragment!, // screenFx
      new EnergyShieldFilter().glProgram.fragment!, // skinFx
    ];
    // A substring check, not a prefix one: Pixi prepends its own version/precision header.
    for (const src of withPrelude) expect(src).toContain(FRAME_UV.trim());
  });
});
