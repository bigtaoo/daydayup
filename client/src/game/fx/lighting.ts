// Dynamic point-light bookkeeping (design/01 fidelity roadmap milestone 2, "point
// lights"). Pure data/logic, no Pixi/GPU dependency — a light here is just a position,
// colour, radius and intensity; `NormalLitFilter` (filters.ts) is what actually shades a
// sprite against the strongest one nearby. Kept deliberately small (no spatial index,
// linear scan): this project only ever has a handful of lights alive at once (one
// persistent local-player glow + a few transient muzzle-flash/impact bursts), so an
// O(n) scan per actor per frame is the "own the cost" simplification this codebase's
// other filters already established (VignetteFilter's UV-distance trick, HeatHazeFilter's
// sine wobble — no extra machinery bought for a cost this cheap).

export interface LightSource {
  x: number;
  y: number;
  color: number;
  radius: number;
  intensity: number;
}

/** What a lit actor's shader actually needs: a normalized direction (from the actor
 *  TOWARD the light) plus colour/intensity already falloff-adjusted for its distance. */
export interface LightHit {
  dirX: number;
  dirY: number;
  color: number;
  intensity: number;
}

interface TransientEntry {
  light: LightSource;
  lifeMs: number;
  totalMs: number;
}

export class LightRegistry {
  private readonly persistent = new Map<string, LightSource>();
  private transients: TransientEntry[] = [];

  /** Replace-in-place every frame — the local-player glow, re-added at its current
   *  position each tick rather than tracked as a one-time spawn. */
  addPersistent(id: string, light: LightSource): void {
    this.persistent.set(id, light);
  }

  removePersistent(id: string): void {
    this.persistent.delete(id);
  }

  /** A fading burst (muzzle flash / impact) — expires on its own via `update`. */
  addTransient(light: LightSource, lifeMs: number): void {
    this.transients.push({ light, lifeMs, totalMs: lifeMs });
  }

  /** Decay + drop expired transients. Persistent lights are untouched here — they live
   *  until `removePersistent`/re-added-elsewhere-next-frame. */
  update(dt: number): void {
    if (this.transients.length === 0) return;
    this.transients = this.transients.filter((t) => (t.lifeMs -= dt) > 0);
  }

  /** Drop every light — a fresh run shouldn't inherit the previous run's glow. */
  clear(): void {
    this.persistent.clear();
    this.transients = [];
  }

  /** The strongest light near (x, y), direction-and-falloff-adjusted for a shader to
   *  consume directly — `null` when nothing is close enough to matter (key light only). */
  strongestAt(x: number, y: number): LightHit | null {
    let best: LightHit | null = null;
    let bestScore = 0;

    const consider = (light: LightSource, fade: number): void => {
      const dx = light.x - x;
      const dy = light.y - y;
      const dist = Math.hypot(dx, dy);
      const falloff = Math.max(0, 1 - dist / Math.max(1, light.radius));
      const score = light.intensity * falloff * fade;
      if (score <= 0 || score <= bestScore) return;
      bestScore = score;
      const invLen = dist > 0.0001 ? 1 / dist : 0;
      best = { dirX: dx * invLen, dirY: dy * invLen, color: light.color, intensity: score };
    };

    for (const light of this.persistent.values()) consider(light, 1);
    for (const t of this.transients) consider(t.light, Math.max(0, t.lifeMs / t.totalMs));

    return best;
  }
}
