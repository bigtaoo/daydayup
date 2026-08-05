import { describe, it, expect, vi, afterEach } from 'vitest';
import { ParticleSystem } from './Particles';

// ParticleSystem is Container/Graphics-only (design/12 "no textures — every particle
// is a tiny Graphics shape") — no renderer/WebGL needed to construct or exercise it,
// same reasoning FxController.test.ts documents for the plain `Layers`/`Container` it
// builds. Every spawner rolls `Math.random()` for jitter (spread/speed/spin/lifeMs/
// count), so tests pin it with a spy for deterministic assertions.
function withRandom<T>(value: number, fn: () => T): T {
  const spy = vi.spyOn(Math, 'random').mockReturnValue(value);
  try {
    return fn();
  } finally {
    spy.mockRestore();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ParticleSystem.muzzleFlame', () => {
  it('spawns exactly 3 additive-blended particles at the muzzle', () => {
    const ps = new ParticleSystem();
    withRandom(0.5, () => ps.muzzleFlame(10, 20, 0, 0xffffff));
    expect(ps.view.children.length).toBe(3);
    for (const child of ps.view.children) {
      expect(child.blendMode).toBe('add');
    }
  });

  it('fires particles outward along the given facing direction', () => {
    const ps = new ParticleSystem();
    // spread = (0.5-0.5)*0.9 = 0, speed = 90+0.5*70 = 125 — straight along facingRad
    // with no gravity, so a single update step moves purely along that direction.
    // lifeMs = 70+0.5*50 = 95ms, so keep dt well under that or the particle is culled.
    withRandom(0.5, () => ps.muzzleFlame(0, 0, 0, 0xffffff));
    const g = ps.view.children[0]!;
    ps.update(50);
    expect(g.x).toBeCloseTo(6.25);
    expect(g.y).toBeCloseTo(0);
  });
});

describe('ParticleSystem.shellCasing', () => {
  it('spawns exactly one ejected casing particle', () => {
    const ps = new ParticleSystem();
    withRandom(0.5, () => ps.shellCasing(0, 0, 0));
    expect(ps.view.children.length).toBe(1);
  });

  it('arcs downward under gravity as it updates', () => {
    const ps = new ParticleSystem();
    // eject = 0 + PI/2 + 0 = PI/2, speed = 80 -> vx ~ 0, vy = 80 - 40 = 40; gravity 260
    // pulls vy further positive (down) over time.
    withRandom(0.5, () => ps.shellCasing(0, 0, 0));
    const g = ps.view.children[0]!;
    const y1 = g.y;
    ps.update(100);
    const y2 = g.y;
    ps.update(100);
    const y3 = g.y;
    expect(y2).toBeGreaterThan(y1);
    expect(y3 - y2).toBeGreaterThan(y2 - y1); // accelerating downward
  });

  it('spins when spin jitter is non-zero', () => {
    const ps = new ParticleSystem();
    // spin = (1-0.5)*12 = 6 rad/sec at random()=1.
    withRandom(1, () => ps.shellCasing(0, 0, 0));
    const g = ps.view.children[0]!;
    expect(g.rotation).toBe(0);
    ps.update(100);
    expect(g.rotation).not.toBe(0);
  });
});

describe('ParticleSystem.explosionDebris', () => {
  it('spawns the minimum debris count at the low end of the random range', () => {
    const ps = new ParticleSystem();
    // count = 6 + floor(0*3) = 6
    withRandom(0, () => ps.explosionDebris(0, 0, 0xff0000));
    expect(ps.view.children.length).toBe(6);
  });

  it('spawns the maximum debris count at the high end of the random range', () => {
    const ps = new ParticleSystem();
    // count = 6 + floor(0.999*3) = 8
    withRandom(0.999, () => ps.explosionDebris(0, 0, 0xff0000));
    expect(ps.view.children.length).toBe(8);
  });
});

describe('ParticleSystem.update', () => {
  it('fades alpha proportionally to remaining life', () => {
    const ps = new ParticleSystem();
    // lifeMs = 320 + 0.5*120 = 380; halfway through equals alpha 0.5.
    withRandom(0.5, () => ps.shellCasing(0, 0, 0));
    const g = ps.view.children[0]!;
    expect(g.alpha).toBe(1);
    ps.update(190);
    expect(g.alpha).toBeCloseTo(0.5);
  });

  it('removes and destroys a particle once its life is spent', () => {
    const ps = new ParticleSystem();
    withRandom(0.5, () => ps.shellCasing(0, 0, 0)); // lifeMs = 380
    const g = ps.view.children[0]!;
    const destroySpy = vi.spyOn(g, 'destroy');
    ps.update(380);
    expect(ps.view.children.length).toBe(0);
    expect(destroySpy).toHaveBeenCalled();
  });

  it('leaves untouched particles alone while removing expired ones', () => {
    const ps = new ParticleSystem();
    withRandom(0.5, () => {
      ps.shellCasing(0, 0, 0); // lifeMs 380, will expire
    });
    ps.update(380);
    withRandom(0.5, () => {
      ps.shellCasing(0, 0, 0); // fresh particle spawned after the first died
    });
    expect(ps.view.children.length).toBe(1);
  });

  it('does not spawn drifting dust when dustEvery is 0 (the default)', () => {
    const ps = new ParticleSystem();
    ps.update(10_000);
    expect(ps.view.children.length).toBe(0);
  });

  it('does not spawn drifting dust without bounds even if dustEvery is set', () => {
    const ps = new ParticleSystem();
    ps.update(10_000, 100);
    expect(ps.view.children.length).toBe(0);
  });

  it('spawns a drifting dust mote once the accumulator reaches dustEvery, carrying over the remainder', () => {
    const ps = new ParticleSystem();
    const bounds = { x: 0, y: 0, w: 100, h: 100 };
    withRandom(0.5, () => {
      ps.update(50, 100, bounds); // accum 50 < 100 — no spawn yet
      expect(ps.view.children.length).toBe(0);
      ps.update(60, 100, bounds); // accum 110 >= 100 — one dust mote, 10ms carries over
      expect(ps.view.children.length).toBe(1);
    });
  });

  it('places a drifting dust mote within the given bounds', () => {
    const ps = new ParticleSystem();
    const bounds = { x: 0, y: 0, w: 100, h: 100 };
    // The dust spawn happens after this same update() call's aging loop, so the
    // display-object alpha (which the aging loop fades toward 0) is still its default
    // 1 here — `alpha: 0.22` (design/13's "faint" bed) is baked into the fill draw
    // itself, not the container alpha, so it isn't observable from the outside without
    // introspecting Graphics geometry; position is what's assertable here.
    withRandom(0.5, () => ps.update(100, 100, bounds));
    const g = ps.view.children[0]!;
    expect(g.x).toBeCloseTo(50);
    expect(g.y).toBeCloseTo(50);
    expect(g.alpha).toBe(1);
  });

  it('can spawn multiple dust motes in a single update when dt covers several intervals', () => {
    const ps = new ParticleSystem();
    const bounds = { x: 0, y: 0, w: 100, h: 100 };
    withRandom(0.5, () => ps.update(250, 100, bounds)); // 250ms / 100ms interval = 2 motes
    expect(ps.view.children.length).toBe(2);
  });
});

describe('ParticleSystem.clear', () => {
  it('destroys and removes every live particle', () => {
    const ps = new ParticleSystem();
    withRandom(0.5, () => ps.muzzleFlame(0, 0, 0, 0xffffff));
    expect(ps.view.children.length).toBe(3);
    const destroySpies = ps.view.children.map((c) => vi.spyOn(c, 'destroy'));
    ps.clear();
    expect(ps.view.children.length).toBe(0);
    for (const spy of destroySpies) expect(spy).toHaveBeenCalled();
  });

  it('leaves the system usable for new particles afterwards', () => {
    const ps = new ParticleSystem();
    withRandom(0.5, () => ps.shellCasing(0, 0, 0));
    ps.clear();
    withRandom(0.5, () => ps.shellCasing(0, 0, 0));
    expect(ps.view.children.length).toBe(1);
  });
});
