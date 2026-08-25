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

// 2026-08-19 volume pass, then 2026-08-24 user report *"护盾成了一个圆圈, 我希望是圆形护盾的
// 效果, 最初那种效果是对的"*.
describe('EnergyShieldFilter shell shape', () => {
  /** Shader source with comments stripped, so a number quoted in a comment cannot satisfy a
   *  regex meant to read the real code (same helper the shimmer suite above uses). */
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');

  it('is a screen-space CIRCLE — a sphere around the body, not a disc on the floor', () => {
    // The 2026-08-18 depth pass squashed this ring vertically by SHADOW_SQUASH, reasoning
    // that every round thing wrapping a body in a tilted view foreshortens the same way.
    // It does not: a shadow and a status aura lie flat on the ground plane (so the tilt
    // compresses them), while a shield is a sphere AROUND the body, and a sphere's
    // silhouette is a circle from every angle. On screen the squashed version read as a
    // flat hoop threaded through the character at gun height — the reported "圆圈".
    // These two assertions are what stop that fix being silently re-applied.
    const src = code(new EnergyShieldFilter().glProgram.fragment!);
    expect(src).not.toMatch(/uv\.y\s*[\/*]=/);
    expect(src).not.toContain('uSquash');
  });

  it('does not take the ground shadow squash constant back by another name', () => {
    // The regression this suite exists for is a NUMBER, not an identifier: re-introducing
    // 0.62 (or its reciprocal) on the vertical axis reproduces the flat hoop no matter what
    // the uniform ends up being called.
    const src = code(new EnergyShieldFilter().glProgram.fragment!);
    const yScaled = /uv\.y\s*[\/*]=\s*([0-9.]+)/.exec(src);
    expect(yScaled).toBeNull();
    expect(SHADOW_SQUASH).toBeLessThan(1); // the shadow itself is still an ellipse
  });

  it('derives the radius from an unmodified uv, so both axes reach equally far', () => {
    // `length(uv)` over a raw region-centred uv IS the circle. Anything that scaled one
    // component before this line would be an ellipse again.
    const src = code(new EnergyShieldFilter().glProgram.fragment!);
    const between = src.slice(src.indexOf('vec2 uv ='), src.indexOf('float dist'));
    expect(between).not.toMatch(/uv\.[xy]/);
    expect(src).toContain('float dist = length(uv)');
  });

  // 2026-08-19 volume pass, then 2026-08-25's shell rewrite. The shell's SIZE, expressed in the
  // only unit that means anything to a player: body radii. `Actor` pins this filter's area to a
  // square `radiusPx * 3` per side, so `uv` (region-normalized, minus 0.5) spans ±0.5 across
  // 6 body radii, and `dist = length(uv) * sqrt(2)`. A `dist` of D therefore sits
  // `D * 6 / sqrt(2)` body radii out.
  const radii = (dist: number): number => (dist * 6) / Math.SQRT2;

  /** The shell's outer-surface radius, in `dist` units, as the shader actually declares it. */
  function shellRadius(src: string): number {
    const m = /const float SHELL_R = ([0-9.]+);/.exec(code(src));
    if (!m) throw new Error('shield shader no longer declares `const float SHELL_R`');
    return Number(m[1]);
  }

  it('encloses the whole character at ~1.9 body radii instead of ballooning past 2.1', () => {
    // Measured before the 2026-08-19 pass: the band peaked at dist 0.5, i.e. **2.1 body radii** —
    // more than twice the size of the character it wrapped, blanketing the floor around a shielded
    // actor's feet with opaque cyan and hiding the ground shadow entirely. That is the whole
    // grounding cue of the volume pass, lost whenever a shield was up.
    const src = code(new EnergyShieldFilter().glProgram.fragment!);
    const r = shellRadius(src);
    expect(radii(r)).toBeGreaterThan(1.7); // encloses the whole character, mounted weapon included
    expect(radii(r)).toBeLessThan(2.1); // ...and is not a pool on the floor
    // The soft outer bloom past the surface has to stay close to it for the same reason.
    const fade = /1\.0 - smoothstep\(SHELL_R, SHELL_R \+ ([0-9.]+), dist\)/.exec(src);
    if (!fade) throw new Error('shield shader no longer fades out just past SHELL_R');
    expect(radii(r + Number(fade[1]))).toBeLessThan(2.3);
  });

  // 2026-08-25 user report: *"现在的护盾是一个圆圈包裹着角色, 我希望的是类似一个透明的蛋壳一样的
  // 效果将角色全部包裹, 而不是一个圆环"*. Every version through 2026-08-24 drew
  // `smoothstep(a, b, dist) * (1.0 - smoothstep(b, c, dist))` — a band with a HOLE in it, so the
  // character stood in empty space with a hoop round its waist. These four are what stop a
  // future retune from reintroducing the hole; the shape they pin is "solid disc, bright limb".
  describe('is a solid shell, not a ring', () => {
    it('never gates brightness on being FAR ENOUGH from the centre', () => {
      // A ring is exactly one thing: a term that RISES with `dist`, zeroing the middle. Every
      // smoothstep over `dist` in a shell shader must be a negated (falling) one.
      const src = code(new EnergyShieldFilter().glProgram.fragment!);
      const steps = [...src.matchAll(/(1\.0 - )?smoothstep\([^)]*dist\)/g)];
      expect(steps.length).toBeGreaterThan(0);
      for (const s of steps) expect(s[1]).toBe('1.0 - ');
    });

    it('fills the interior with a real tint, faint enough to read the character through', () => {
      const src = code(new EnergyShieldFilter().glProgram.fragment!);
      const declared = /const float FILL = ([0-9.]+);/.exec(src);
      if (!declared) throw new Error('shield shader no longer declares `const float FILL`');
      const m = /shell \* \(FILL \* \(1\.0 - ([0-9.]+) \* color\.a\) \+ ([0-9.]+) \* fresnel\)/.exec(src);
      if (!m) throw new Error('shield shader no longer mixes a body-damped fill with a fresnel limb');
      const [fill, damp, limb] = [Number(declared[1]), Number(m[1]), Number(m[2])];
      expect(fill).toBeGreaterThan(0.05); // a glass shell, not an outline: the middle is painted
      expect(fill).toBeLessThan(0.3); // ...but the character underneath still has to read
      // Composited with `color.a = max(color.a, glow * K)` below, the interior is what covers the
      // ground shadow, so its worst case matters more than its nominal value.
      const k = Number(/color\.a = max\(color\.a, glow \* ([0-9.]+)\)/.exec(src)![1]);
      expect(fill * k).toBeLessThan(0.15);
      expect(fill + limb).toBeCloseTo(1, 6); // the limb reaches full brightness at the surface
      expect(limb).toBeGreaterThan(fill); // ...and it is the limb that dominates, not the fill
      // The damping term is what keeps the fill off the ART: at full body alpha the additive wash
      // drops to `fill * (1 - damp)`. Measured with no damping at all (2026-08-25): the hero's
      // saturated blue eye came out the same pale cyan as the shell around it. A damp of 1 would
      // be the other failure — the character would punch a hole in its own bubble.
      expect(damp).toBeGreaterThan(0.25);
      expect(damp).toBeLessThan(0.8);
    });

    it('brightens toward the limb via a sphere normal, which is what makes it read as curved', () => {
      // `nz` is the sphere normal's z (1 face-on, 0 at the silhouette edge) and `1 - nz` the
      // grazing-angle term. Flattening the exponent to 1 would wash the whole disc out into a
      // uniform cyan blob; dropping the term entirely leaves a flat decal.
      const src = code(new EnergyShieldFilter().glProgram.fragment!);
      expect(src).toContain('float nz = sqrt(max(0.0, 1.0 - r * r));');
      const m = /float fresnel = pow\(1\.0 - nz, ([0-9.]+)\);/.exec(src);
      if (!m) throw new Error('shield shader no longer derives a fresnel term from the sphere normal');
      expect(Number(m[1])).toBeGreaterThanOrEqual(2); // tight against the edge, not a wash
    });

    it('carries a specular highlight, offset from the centre and inside the shell', () => {
      // The one cue that reads instantly as "curved and transparent". Centred, it would just be a
      // second glow blob; outside the surface it would float free of the shell.
      const src = code(new EnergyShieldFilter().glProgram.fragment!);
      const m = /vec2 hi = uv - vec2\(([-0-9.]+), ([-0-9.]+)\);/.exec(src);
      if (!m) throw new Error('shield shader no longer places a specular highlight');
      const offset = Math.hypot(Number(m[1]), Number(m[2])) * Math.SQRT2; // in `dist` units
      expect(offset).toBeGreaterThan(0.05 * shellRadius(src)); // genuinely off-centre
      expect(offset).toBeLessThan(0.8 * shellRadius(src)); // ...and well inside the surface
      expect(src).toContain('float spec = shell *'); // masked by the shell, so it cannot outlive it
    });
  });

  it('paints itself onto transparent background at well under full opacity', () => {
    // `color.a = max(color.a, glow * K)` is what draws the shell OUTSIDE the body's own alpha, so
    // K is also the knob deciding how much floor a shielded actor hides. 1.0 would be a solid
    // cyan disc over the shadow.
    const src = code(new EnergyShieldFilter().glProgram.fragment!);
    const m = /color\.a = max\(color\.a, glow \* ([0-9.]+)\)/.exec(src);
    if (!m) throw new Error('shield shader no longer writes `color.a = max(color.a, glow * K)`');
    expect(Number(m[1])).toBeLessThanOrEqual(0.75);
    expect(Number(m[1])).toBeGreaterThan(0.4); // still a visible shell, not a hint
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
