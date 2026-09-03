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

/** `muzzleFlame`'s two authored populations, at budget 1 (see that method). */
const EMBERS = 3;
const GAS = 2;

describe('ParticleSystem.muzzleFlame', () => {
  it('spawns 3 embers then 2 gas puffs, all additive, at the muzzle', () => {
    const ps = new ParticleSystem();
    withRandom(0.5, () => ps.muzzleFlame(10, 20, 0, 0xffffff));
    expect(ps.view.children.length).toBe(EMBERS + GAS);
    for (const child of ps.view.children) {
      expect(child.blendMode).toBe('add');
    }
  });

  it('fires particles outward along the given facing direction', () => {
    const ps = new ParticleSystem();
    // At random=0.5 the ember jitter is (0.5-0.5)*0.34 = 0 — straight along facingRad, with
    // no gravity, so a single update step moves purely along that direction. speed =
    // 150+0.5*120 = 210, lifeMs = 60+0.5*60 = 90ms, so keep dt well under that or the
    // particle is culled before it can be read.
    withRandom(0.5, () => ps.muzzleFlame(0, 0, 0, 0xffffff));
    const g = ps.view.children[0]!;
    ps.update(50);
    expect(g.x).toBeCloseTo(10.5);
    expect(g.y).toBeCloseTo(0);
  });

  it('throws the gas slower than the embers — the two populations are not one spray', () => {
    // The whole point of splitting the burst (2026-08-30): fast collimated embers that carry
    // the shot's direction, and slow wide gas behind them. A regression that collapses the two
    // back into one mid-speed spray passes every other test in this block, so it is asserted
    // here directly — at random=0.5 the ember runs at 210 px/s and the gas at 35+0.5*55 = 62.5.
    const ps = new ParticleSystem();
    withRandom(0.5, () => ps.muzzleFlame(0, 0, 0, 0xffffff));
    ps.update(50);
    const ember = ps.view.children[0]!;
    const gas = ps.view.children[EMBERS]!;
    expect(gas.x).toBeCloseTo(3.125);
    expect(gas.x).toBeLessThan(ember.x / 2);
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

/** The basic mob / boss drawn radii (`engine/content/enemies.ts`) — the two ends of the
 *  roster the death ring is sized against, so every assertion below is made at BOTH. A ring
 *  measured at one body size cannot tell "sized off the body" from "an authored constant that
 *  happens to fit this body", which is the exact bug this replaced. */
const MOB_BODY_PX = 15;
const BOSS_BODY_PX = 30;
/** `DEBRIS_REACH_R` and the ±12% radius jitter, restated (both are module-private). */
const REACH_R = 1.6;
const JITTER = 0.12;

/**
 * Where each piece of a burst ended up, relative to where the burst was spawned, at the end
 * of its life. Measured by stepping the system rather than by reading velocities, which are
 * private — and 299 of the 300 ms life rather than all of it, since `update` destroys a
 * particle the frame its life runs out (the same reason `shieldShards`' own outward-direction
 * test steps one frame instead of inspecting the spawn).
 */
function debrisAtEndOfLife(ps: ParticleSystem): { a: number; r: number; x: number; y: number }[] {
  ps.update(299);
  return ps.view.children.map((c) => ({
    a: Math.atan2(c.y, c.x), r: Math.hypot(c.x, c.y), x: c.x, y: c.y,
  }));
}

describe('ParticleSystem.explosionDebris', () => {
  it('sizes the ring off the dying body — a boss burst is twice a mob burst', () => {
    // The report this method was rewritten for: the burst was one authored size for every
    // corpse. Two runs with the SAME dice, so the only thing that differs is the body.
    const mob = new ParticleSystem();
    withRandom(0.5, () => mob.explosionDebris(0, 0, 0xff0000, MOB_BODY_PX));
    const boss = new ParticleSystem();
    withRandom(0.5, () => boss.explosionDebris(0, 0, 0xff0000, BOSS_BODY_PX));

    const mobR = debrisAtEndOfLife(mob).map((d) => d.r);
    const bossR = debrisAtEndOfLife(boss).map((d) => d.r);
    expect(mobR.length).toBeGreaterThan(0);
    expect(bossR.length).toBeGreaterThan(0);
    const mean = (xs: number[]): number => xs.reduce((t, v) => t + v, 0) / xs.length;
    // Sized off the body, and to the authored multiple of it — not merely "bigger for a
    // bigger body", which a `bodyRadiusPx * 0.2 + 40` would also satisfy.
    expect(mean(mobR)).toBeCloseTo(MOB_BODY_PX * REACH_R, 0);
    expect(mean(bossR)).toBeCloseTo(BOSS_BODY_PX * REACH_R, 0);
    expect(mean(bossR) / mean(mobR)).toBeCloseTo(2, 1);
    // ...and the mob's ring is well inside what the old flat spray reached (18-80 px), which
    // is what "too big" meant: at 15 px of body it was up to 5 body radii of debris.
    expect(mean(mobR)).toBeLessThan(30);
  });

  for (const bodyPx of [MOB_BODY_PX, BOSS_BODY_PX]) {
    it(`lands as a circle at ${bodyPx} px of body, whatever the dice say`, () => {
      // The other half of the report. THREE properties in one measurement, because they are
      // one property of the burst: every piece the same distance out (speed solved from the
      // reach, never rolled), no downward drift (no gravity term), and the whole circle
      // covered (evenly walked angles). A jittered PRNG, not a pinned one — a constant
      // `Math.random` would make "every piece the same distance" true by construction even
      // if the speed were rolled, which is the shape of a test that pins nothing.
      const rolls = [0.02, 0.31, 0.5, 0.77, 0.94, 0.63, 0.18, 0.86, 0.41, 0.99];
      let i = 0;
      const spy = vi.spyOn(Math, 'random').mockImplementation(() => rolls[i++ % rolls.length]!);
      const ps = new ParticleSystem();
      try {
        ps.explosionDebris(0, 0, 0xff0000, bodyPx);
      } finally {
        spy.mockRestore();
      }

      const reach = bodyPx * REACH_R;
      const debris = debrisAtEndOfLife(ps);
      expect(debris.length).toBeGreaterThan(4);
      for (const d of debris) {
        // Inside the authored jitter band and nowhere else. This single bound is what kills
        // gravity as well as a rolled speed: 200 px/s^2 over the 300 ms life is ~9 px of sag,
        // which at a mob's 24 px reach would throw the down-going pieces to 1.4x and the
        // up-going ones to 0.6x — both far outside 1 ± 0.12.
        expect(d.r).toBeGreaterThan(reach * (1 - JITTER - 0.01));
        expect(d.r).toBeLessThan(reach * (1 + JITTER + 0.01));
      }
      // No net drift in any direction: a ring, not a plume leaning somewhere.
      const cx = debris.reduce((t, d) => t + d.x, 0) / debris.length;
      const cy = debris.reduce((t, d) => t + d.y, 0) / debris.length;
      expect(Math.hypot(cx, cy)).toBeLessThan(reach * 0.35);
      // ...and the pieces cover the circle rather than clustering on one arc.
      const sorted = debris.map((d) => d.a).sort((x, y) => x - y);
      const gaps = sorted.map((a, k) => (k === 0 ? a + Math.PI * 2 - sorted[sorted.length - 1]! : a - sorted[k - 1]!));
      expect(Math.max(...gaps)).toBeLessThan(Math.PI);
    });
  }

  it('stays physical debris rather than glow', () => {
    // The one visual property of the burst that is NOT geometry, and the neighbouring
    // spawners in this file split on it: `muzzleFlame` and `shieldShards` are additive
    // (light), casings and this are not (matter). Debris flipped to additive would read as a
    // ring of sparks — plausible on its own, wrong for a body coming apart, and invisible to
    // every other assertion here since blend mode moves nothing.
    const ps = new ParticleSystem();
    withRandom(0.5, () => ps.explosionDebris(0, 0, 0xff0000, MOB_BODY_PX));
    expect(ps.view.children.length).toBeGreaterThan(0);
    for (const child of ps.view.children) expect(child.blendMode).not.toBe('add');
  });

  it('holds the piece count proportional to the body, so density survives the size', () => {
    // A boss ring is twice the circumference; the authored 6-8 spread over it would read as a
    // handful of stray dots. Same dice again, so the count is the body's doing.
    const mob = new ParticleSystem();
    withRandom(0.5, () => mob.explosionDebris(0, 0, 0xff0000, MOB_BODY_PX));
    const boss = new ParticleSystem();
    withRandom(0.5, () => boss.explosionDebris(0, 0, 0xff0000, BOSS_BODY_PX));
    // count = round((6 + floor(0.5*3)) * bodyPx / 15) = 7 and 14.
    expect(mob.view.children.length).toBe(7);
    expect(boss.view.children.length).toBe(14);
  });

  it('spawns the authored count band at the reference body size', () => {
    // The 6-8 roll itself, unchanged by the rewrite — at `DEBRIS_REF_BODY_PX` the
    // proportional scaling above is exactly 1x.
    const low = new ParticleSystem();
    withRandom(0, () => low.explosionDebris(0, 0, 0xff0000, MOB_BODY_PX));
    expect(low.view.children.length).toBe(6); // 6 + floor(0*3)
    const high = new ParticleSystem();
    withRandom(0.999, () => high.explosionDebris(0, 0, 0xff0000, MOB_BODY_PX));
    expect(high.view.children.length).toBe(8); // 6 + floor(0.999*3)
  });
});

describe('ParticleSystem.shieldShards', () => {
  it('throws a ring of additive shards, one per authored slot', () => {
    const ps = new ParticleSystem();
    withRandom(0.5, () => ps.shieldShards(0, 0, 0x66e0ff));
    expect(ps.view.children.length).toBe(11);
    for (const child of ps.view.children) expect(child.blendMode).toBe('add');
  });

  it('sends them OUTWARD in every direction, not in one', () => {
    // The property that makes this read as a shell letting go rather than as a directional
    // spray: the shards' velocities have to cover the circle. Measured after one step, since
    // the velocity itself is private — and with jitter pinned to 0 so the walk is exact.
    const ps = new ParticleSystem();
    withRandom(0.5, () => ps.shieldShards(0, 0, 0x66e0ff));
    ps.update(40);
    const moved = ps.view.children.map((c) => ({ a: Math.atan2(c.y, c.x), r: Math.hypot(c.x, c.y) }));
    expect(moved).toHaveLength(11);
    for (const m of moved) expect(m.r).toBeGreaterThan(1); // every shard left the centre
    // ...and they left in distinct directions spanning the whole circle.
    const sorted = moved.map((m) => m.a).sort((x, y) => x - y);
    const gaps = sorted.map((a, i) => (i === 0 ? a + Math.PI * 2 - sorted[sorted.length - 1]! : a - sorted[i - 1]!));
    expect(Math.max(...gaps)).toBeLessThan(Math.PI / 2); // no empty half or quadrant
    expect(Math.min(...gaps)).toBeGreaterThan(0); // ...and no two shards on the same heading
  });

  it('spawns at the position it is given', () => {
    const ps = new ParticleSystem();
    withRandom(0.5, () => ps.shieldShards(120, -45, 0x66e0ff));
    for (const c of ps.view.children) {
      expect(c.x).toBe(120);
      expect(c.y).toBe(-45);
    }
  });

  it('is gone inside the shell exit it belongs to', () => {
    // The shards and `EnergyShieldFilter.shatter` are two halves of one moment (~200ms). Shards
    // still drifting after the shell has finished leaving read as unrelated debris.
    const ps = new ParticleSystem();
    withRandom(0.999, () => ps.shieldShards(0, 0, 0x66e0ff)); // the longest-lived roll
    ps.update(260);
    expect(ps.view.children.length).toBe(0);
  });

  it('is thinned by the quality budget like every other burst', () => {
    const thin = new ParticleSystem();
    thin.setBudget(0.25);
    withRandom(0.5, () => thin.shieldShards(0, 0, 0x66e0ff));
    expect(thin.view.children.length).toBeLessThan(11);
    expect(thin.view.children.length).toBeGreaterThan(0); // ...never to nothing
    const off = new ParticleSystem();
    off.setBudget(0);
    withRandom(0.5, () => off.shieldShards(0, 0, 0x66e0ff));
    expect(off.view.children.length).toBe(0);
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
    expect(ps.view.children.length).toBe(EMBERS + GAS);
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

/**
 * The quality budget (`render/quality.ts`, 2026-08-25) — the cheapest knob in the fx budget.
 * Each particle is its own `Graphics` node, so this is CPU per frame plus a draw call whenever
 * one fails to batch.
 */
describe('ParticleSystem.setBudget', () => {
  it('thins a burst in proportion to the budget', () => {
    const full = new ParticleSystem();
    withRandom(0.5, () => full.explosionDebris(0, 0, 0xffffff, 15));
    const thin = new ParticleSystem();
    thin.setBudget(0.35);
    withRandom(0.5, () => thin.explosionDebris(0, 0, 0xffffff, 15));
    expect(thin.view.children.length).toBeLessThan(full.view.children.length);
    expect(thin.view.children.length).toBeGreaterThan(0);
  });

  it('thins the death ring without resizing it — the budget owns the count, not the reach', () => {
    // The quality tier is allowed to make a burst sparser; it is not allowed to make a mob's
    // death a different SIZE than it is on another machine, which is what would happen if the
    // budget ever reached the reach (a `scaled(reach)` looks just as reasonable as
    // `scaled(count)` in a diff, and `setBudget`'s own doc calls itself a multiplier on
    // "every burst count"). Same dice both sides, so the only variable is the budget.
    const full = new ParticleSystem();
    withRandom(0.5, () => full.explosionDebris(0, 0, 0xff0000, MOB_BODY_PX));
    const thin = new ParticleSystem();
    thin.setBudget(0.35);
    withRandom(0.5, () => thin.explosionDebris(0, 0, 0xff0000, MOB_BODY_PX));

    const fullR = debrisAtEndOfLife(full).map((d) => d.r);
    const thinR = debrisAtEndOfLife(thin).map((d) => d.r);
    expect(thinR.length).toBeLessThan(fullR.length); // sparser...
    expect(thinR.length).toBeGreaterThan(0);
    const mean = (xs: number[]): number => xs.reduce((t, v) => t + v, 0) / xs.length;
    expect(mean(thinR)).toBeCloseTo(mean(fullR), 6); // ...and exactly as big
  });

  it('never silences a burst entirely, however small the budget', () => {
    // A muzzle flash that emits ZERO particles reads as the gun failing to fire — a legibility
    // regression, not a quality one. At budget 0.01 the arithmetic alone rounds to 0 for both
    // of muzzleFlame's populations; the floor is what keeps one of each alive.
    const p = new ParticleSystem();
    p.setBudget(0.01);
    withRandom(0.5, () => p.muzzleFlame(0, 0, 0, 0xffffff));
    expect(p.view.children.length).toBe(2);
  });

  it('emits nothing at a budget of exactly 0 — the only value allowed to', () => {
    const p = new ParticleSystem();
    p.setBudget(0);
    withRandom(0.5, () => {
      p.muzzleFlame(0, 0, 0, 0xffffff);
      p.explosionDebris(0, 0, 0xffffff, 15);
      p.shellCasing(0, 0, 0);
    });
    expect(p.view.children.length).toBe(0);
  });

  it('stretches the ambient dust interval instead of dropping motes from a burst', () => {
    const bounds = { x: 0, y: 0, w: 100, h: 100 };
    // 1000ms of frames at a 100ms dust interval: 10 motes at full budget.
    const full = new ParticleSystem();
    withRandom(0.5, () => { for (let i = 0; i < 10; i++) full.update(100, 100, bounds); });
    const thin = new ParticleSystem();
    thin.setBudget(0.5);
    withRandom(0.5, () => { for (let i = 0; i < 10; i++) thin.update(100, 100, bounds); });
    // Half the budget, half the motes over the same wall-clock — a sparser room, with no change
    // in the rhythm of any individual spawn.
    expect(full.view.children.length).toBe(10);
    expect(thin.view.children.length).toBe(5);
  });

  it('stops spawning dust at a budget of 0', () => {
    const p = new ParticleSystem();
    p.setBudget(0);
    withRandom(0.5, () => { for (let i = 0; i < 10; i++) p.update(100, 100, { x: 0, y: 0, w: 100, h: 100 }); });
    expect(p.view.children.length).toBe(0);
  });
});
