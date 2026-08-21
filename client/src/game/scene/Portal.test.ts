/**
 * Portal — the extraction-checkpoint gate (design/10 legibility fix, 2026-08-02; VFX
 * redesign 2026-08-12). Built once in the constructor from static geometry (ground
 * glow, standing arch frame, a two-ring vortex + core), hidden until `setOpen(true)`,
 * animated in `interpolate` via ring rotation, an alpha pulse, and per-frame-redrawn
 * inward-spiralling particles — all deterministic functions of the accumulated
 * `frameDt` clock (no Math.random, so behavior at a given `t` is exactly reproducible).
 */
import { describe, it, expect, vi } from 'vitest';
import { Texture, TextureSource, type Container, type Graphics, type Sprite } from 'pixi.js';
import { Portal } from './Portal';

// `render/environmentSprites.ts` is mocked so BOTH arch paths are reachable under vitest,
// and defaults to "nothing loaded" so every other test in this file keeps exercising the
// stroked-ellipse fallback — same convention as Pickup.test.ts's two mocks.
const mocks = vi.hoisted(() => ({ archTexture: undefined as Texture | undefined }));

vi.mock('../../render/environmentSprites', () => ({
  getPortalArchTexture: () => mocks.archTexture,
}));

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

describe('Portal — the masonry arch, and the vortex sized to its opening (2026-08-20)', () => {
  const ARCH_W = 26 * 1.15;
  const ARCH_H = 26 * 2.15;

  /** The shipped file's real dimensions. Not a round number on purpose: the drawn height is
   *  derived from the art's aspect, so a square stand-in would hide that arithmetic. */
  function archTex(width = 576, height = 539): Texture {
    return new Texture({ source: new TextureSource({ width, height }) });
  }

  function withArch<T>(tex: Texture | undefined, run: () => T): T {
    mocks.archTexture = tex;
    try {
      return run();
    } finally {
      mocks.archTexture = undefined;
    }
  }

  it('mounts the arch sprite in place of the stroked ellipses', () => {
    withArch(archTex(), () => {
      const p = new Portal();
      expect(p.children.length).toBe(4); // unchanged: the sprite takes the frame's slot
      const arch = p.children[Child.Frame] as unknown as Sprite;
      expect(arch.texture).toBe(mocks.archTexture);
    });
  });

  it('stands the arch ON the ground, scaled by WIDTH', () => {
    // A gate is a standing fixture, so it is anchored at its bottom centre — the ground
    // point the shadow and the ground bloom are already drawn at. Fitting it by HEIGHT
    // instead would let a re-generated file change how wide the doorway is, which is the
    // one dimension the vortex constants below are measured against.
    withArch(archTex(), () => {
      const arch = new Portal().children[Child.Frame] as unknown as Sprite;
      expect(arch.anchor.x).toBe(0.5);
      expect(arch.anchor.y).toBe(1);
      expect(arch.y).toBe(0);
      expect(arch.width).toBeCloseTo(ARCH_W * 2, 4);
    });
  });

  it('lets the art aspect set how tall the gate stands', () => {
    // The shipped 576x539 lands within a pixel of archH — but the rule is the art's, not a
    // coincidence, so a squarer file must come out correspondingly taller.
    withArch(archTex(), () => {
      const arch = new Portal().children[Child.Frame] as unknown as Sprite;
      expect(Math.abs(arch.height - ARCH_H)).toBeLessThan(1);
    });
    withArch(archTex(500, 500), () => {
      const arch = new Portal().children[Child.Frame] as unknown as Sprite;
      expect(arch.height).toBeCloseTo(ARCH_W * 2, 4); // square art => as tall as it is wide
    });
  });

  it('keeps the whole vortex inside the arch opening, not on the masonry', () => {
    // The load-bearing consequence of the arch becoming real stone. Every radius used to be
    // a fraction of archW (the OUTER half-width) because the old arch was one stroked ellipse
    // with no thickness; the shipped sprite's legs take 22% of the outer width each, so
    // ringA's old 0.78 * archW drew the brightest ring straight onto the stone.
    // `environmentArt.test.ts` proves 0.56 * archW is what the file actually clears; this
    // proves the drawing stays inside it, ringA's own stroke width included.
    // Pixi's stroke bounds round outward a fraction of a pixel past radius + halfWidth, so
    // the bound is checked with a sub-pixel slack rather than exactly.
    const limit = ARCH_W * 0.56 + 0.05;
    const p = new Portal();
    const vortex = vortexOf(p);
    for (const ring of vortex.children) {
      const b = (ring as Graphics).getLocalBounds();
      expect(Math.max(b.width, b.height) / 2).toBeLessThanOrEqual(limit);
    }
    // ...and the outermost ring is close to that limit rather than timidly small — a vortex
    // shrunk to a dot would satisfy the bound above while losing the effect entirely.
    const outer = vortexOf(p).children[0] as Graphics;
    expect(Math.max(outer.getLocalBounds().width, outer.getLocalBounds().height) / 2).toBeGreaterThan(limit * 0.75);
  });

  it('sits the vortex LOW in the doorway, where an arch actually has a hole', () => {
    // Centring it on the object (the pre-sprite `-archH / 2`) costs 35% of the vortex's radius
    // for nothing, because the crown's curve bounds it from above. A quarter of the arch's
    // height is where the straight legs become the only constraint.
    const p = new Portal();
    expect(vortexOf(p).y).toBeCloseTo(-ARCH_H * 0.25, 4);
    expect(particlesOf(p).y).toBeCloseTo(vortexOf(p).y, 4); // motes fall into the same hole
  });

  it('starts its infalling motes at the opening, not at the outer half-width', () => {
    // `drawParticles` spawns at r * (1 - frac). It read `archW` directly until the arch became
    // masonry, which put the first half of every mote's fall on top of the stone.
    const p = new Portal();
    p.setOpen(true);
    p.interpolate(1, 1300); // mid-cycle: motes are spread across their whole travel
    const b = particlesOf(p).getLocalBounds();
    expect(Math.max(b.width, b.height) / 2).toBeLessThanOrEqual(ARCH_W * 0.56 + 3);
  });

  it('falls back to the stroked ellipse pair when the art has not loaded', () => {
    // Art never blocks gameplay (design/02/12) — and this is the state every other test in
    // this file runs in, which is why the sprite path is asserted separately above.
    const p = new Portal();
    expect(p.children.length).toBe(4);
    // Its own geometry, not just "something drew": the pair of ellipses spans the gate's full
    // outer width plus the dark rim's 10px stroke, which a sprite in the same slot cannot fake.
    expect(frameOf(p).getLocalBounds().width).toBeCloseTo(ARCH_W * 2 + 10, 4);
  });
});

describe('Portal — the vortex keeps its PROPORTIONS, not just its bounds', () => {
  interface Instr {
    action: string;
    data: {
      style?: { alpha: number; width: number; color: number };
      path?: { instructions: Array<{ action: string; data: unknown[] }> };
    };
  }

  /** ringA's arcs, as `{ width, radius }` — from Pixi's retained instruction list, since a
   *  stroke width is invisible to a bounds check (it only widens the bounds by half of it). */
  function arcs(g: Graphics): Array<{ width: number; radius: number }> {
    const out: Array<{ width: number; radius: number }> = [];
    for (const i of g.context.instructions as unknown as Instr[]) {
      if (i.action !== 'stroke') continue;
      for (const pi of i.data.path?.instructions ?? []) {
        if (pi.action !== 'arc') continue;
        out.push({ width: i.data.style!.width, radius: (pi.data as number[])[2]! });
      }
    }
    return out;
  }

  it('keeps its rings as thin, relative to their radius, as they were authored', () => {
    // The defect this pins, and it was introduced by the fix above rather than found in it:
    // pulling the radii in to fit the arch's opening while leaving the stroke widths at their
    // old absolute values took ringA from 26% of its own radius thick to 44%, and it read as
    // a scatter of debris rather than as a ring. The bound is a RATIO for that reason — an
    // absolute width would go stale the next time the arch art changes.
    const p = new Portal();
    for (const ring of vortexOf(p).children.slice(0, 2)) {
      for (const a of arcs(ring as Graphics)) {
        expect(a.width / a.radius).toBeGreaterThan(0.1); // still visible, not a hairline
        expect(a.width / a.radius).toBeLessThan(0.35); // reads as a ring, not as a blob
      }
    }
  });

  it('shrinks its infalling motes along with everything else', () => {
    // Same trap as the stroke widths: a mote sized for the old vortex is a boulder in the new
    // one. Measured as a fraction of the vortex's own reach so it cannot go stale either.
    const p = new Portal();
    p.setOpen(true);
    p.interpolate(1, 1300);
    const b = particlesOf(p).getLocalBounds();
    const motes = (particlesOf(p).context.instructions as unknown as Instr[])
      .filter((i) => i.action === 'fill')
      .flatMap((i) => (i.data.path?.instructions ?? []).filter((pi) => pi.action === 'circle'))
      .map((pi) => (pi.data as number[])[2]!);
    expect(motes.length).toBeGreaterThan(0);
    // 0.12 of the vortex's reach: the shrunk motes peak at 0.11 of it, the unshrunk ones at
    // 0.16. A looser bound passed both, which the mutation battery said out loud.
    expect(Math.max(...motes)).toBeLessThan(0.12 * (26 * 1.15 * 0.56));
    expect(b.width).toBeGreaterThan(0); // and they actually drew
  });
});
