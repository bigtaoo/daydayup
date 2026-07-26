import { Container, Graphics } from 'pixi.js';

// A small in-house particle system (design/01 fidelity roadmap milestone 4: muzzle
// flames, shell casings, explosion debris, drifting dust). Pure render-side: driven
// by the engine's `events` queue same as the existing `flash()`/`trailDot()` helpers
// in Game.ts (design/08 "events are the only engine→render channel") — it never reads
// or writes GameState, so different clients can run this (or not) and stay
// byte-identical in simulation (design/06). No textures — every particle is a tiny
// Graphics shape, matching the demo's "Graphics-only, atlas comes later" convention
// (design/12).
interface Particle {
  g: Graphics;
  vx: number; // px/sec
  vy: number; // px/sec
  gravity: number; // px/sec^2
  spin: number; // rad/sec
  life: number; // ms remaining
  maxLife: number;
}

export class ParticleSystem {
  readonly view = new Container();
  private particles: Particle[] = [];
  private dustAccumMs = 0;

  private spawn(opts: {
    x: number; y: number; vx: number; vy: number; gravity?: number; spin?: number;
    color: number; alpha?: number; size: number; shape?: 'circle' | 'rect'; additive?: boolean; lifeMs: number;
  }) {
    const g = new Graphics();
    const a = opts.alpha ?? 1;
    if (opts.shape === 'rect') g.rect(-opts.size / 2, -opts.size / 2, opts.size, opts.size).fill({ color: opts.color, alpha: a });
    else g.circle(0, 0, opts.size / 2).fill({ color: opts.color, alpha: a });
    if (opts.additive) g.blendMode = 'add';
    g.position.set(opts.x, opts.y);
    this.view.addChild(g);
    this.particles.push({
      g, vx: opts.vx, vy: opts.vy, gravity: opts.gravity ?? 0, spin: opts.spin ?? 0,
      life: opts.lifeMs, maxLife: opts.lifeMs,
    });
  }

  /** Advance every live particle by `dt` ms; call once per render frame. `dustEvery`
   * (ms, 0 = off) opts into ambient drifting dust motes spawned within `bounds` —
   * design/13's "environment desaturated" law, so dust stays a faint background bed. */
  update(dt: number, dustEvery = 0, bounds?: { x: number; y: number; w: number; h: number }) {
    const dtSec = dt / 1000;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]!;
      p.life -= dt;
      if (p.life <= 0) {
        this.view.removeChild(p.g);
        p.g.destroy();
        this.particles.splice(i, 1);
        continue;
      }
      p.vy += p.gravity * dtSec;
      p.g.x += p.vx * dtSec;
      p.g.y += p.vy * dtSec;
      p.g.rotation += p.spin * dtSec;
      p.g.alpha = Math.max(0, p.life / p.maxLife);
    }

    if (dustEvery > 0 && bounds) {
      this.dustAccumMs += dt;
      while (this.dustAccumMs >= dustEvery) {
        this.dustAccumMs -= dustEvery;
        this.driftingDust(bounds);
      }
    }
  }

  clear() {
    for (const p of this.particles) p.g.destroy();
    this.particles.length = 0;
  }

  // ---- named spawners (design/01 milestone 4) ----

  /** A quick warm burst at the muzzle, jittered around the fire direction. */
  muzzleFlame(x: number, y: number, facingRad: number, color: number) {
    for (let i = 0; i < 3; i++) {
      const spread = (Math.random() - 0.5) * 0.9;
      const speed = 90 + Math.random() * 70;
      const a = facingRad + spread;
      this.spawn({
        x, y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed,
        color, size: 3 + Math.random() * 2, lifeMs: 70 + Math.random() * 50,
        additive: true, alpha: 0.9,
      });
    }
  }

  /** One ejected casing, roughly sideways-and-back from the fire direction, arcing
   * down under gravity — a physical (non-additive) little rect, not a glow. */
  shellCasing(x: number, y: number, facingRad: number) {
    const eject = facingRad + Math.PI / 2 + (Math.random() - 0.5) * 0.5;
    const speed = 60 + Math.random() * 40;
    this.spawn({
      x, y, vx: Math.cos(eject) * speed, vy: Math.sin(eject) * speed - 40,
      gravity: 260, spin: (Math.random() - 0.5) * 12,
      color: 0xd4af6a, size: 3, shape: 'rect', lifeMs: 320 + Math.random() * 120,
    });
  }

  /** A radial burst of debris on death — gravity-affected, faction/element-tinted. */
  explosionDebris(x: number, y: number, color: number) {
    const count = 6 + Math.floor(Math.random() * 3);
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.4;
      const speed = 70 + Math.random() * 90;
      this.spawn({
        x, y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed,
        gravity: 200, spin: (Math.random() - 0.5) * 8,
        color, size: 2.5 + Math.random() * 2.5, lifeMs: 260 + Math.random() * 240,
      });
    }
  }

  /** One faint, slow-drifting dust mote — ambient, desaturated (design/13 "quiet
   * world bed, punchy combat"). Spawned periodically within the current room bounds. */
  private driftingDust(bounds: { x: number; y: number; w: number; h: number }) {
    const x = bounds.x + Math.random() * bounds.w;
    const y = bounds.y + Math.random() * bounds.h;
    this.spawn({
      x, y, vx: (Math.random() - 0.5) * 8, vy: -6 - Math.random() * 6,
      color: 0x5c6577, size: 2 + Math.random() * 1.5, alpha: 0.22,
      lifeMs: 1800 + Math.random() * 1200,
    });
  }
}
