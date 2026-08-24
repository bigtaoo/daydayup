// Dynamic point-light bookkeeping (design/01 fidelity roadmap milestone 2, "point
// lights"). Pure data/logic, no Pixi/GPU dependency — a light here is just a position,
// colour, radius and intensity; `SceneLightFilter` (fx/filters/litFx.ts) is what actually
// shades the scene against them. Kept deliberately small (no spatial index, linear scan):
// this project only ever has a handful of lights alive at once (one persistent local-player
// glow + a few transient muzzle-flash/impact bursts), so an O(n) scan per FRAME is the "own
// the cost" simplification this codebase's other filters already established.
//
// 2026-08-24: `strongestAt(x, y)` — one winning light per actor, evaluated at that actor's
// centre — is gone, replaced by `snapshot`, which hands the whole active set to the shader.
// The old shape existed because lighting was a per-actor filter and each instance had room
// for exactly one light's direction; with one screen-space pass the falloff is computed per
// TEXEL, so several lights add up and a light near a body's edge no longer shades the whole
// body as if it were at its centre.

export interface LightSource {
  x: number;
  y: number;
  color: number;
  radius: number;
  intensity: number;
}

/** One live light as the shader wants it: world position and radius, with the transient
 *  fade already folded into `intensity` (distance falloff is the shader's job now — it has
 *  the texel's own world position, which this layer does not). */
export interface ActiveLight {
  x: number;
  y: number;
  color: number;
  radius: number;
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

  /**
   * Fill `out` with this frame's live lights, strongest first, and return how many were
   * written. Never allocates: `out` is a caller-owned scratch array whose entries are reused
   * in place, so this can run every render frame.
   *
   * `out.length` is a real cap — the shader has a fixed number of light slots
   * (`MAX_SCENE_LIGHTS`), and a busy fight registers one transient per impact, so a frame CAN
   * have more lights than slots. The ones dropped are the weakest by `intensity * fade`,
   * which is the right thing to lose: an almost-expired impact flash contributes least. This
   * is the only place that truncation happens, and it is deliberate rather than incidental.
   */
  snapshot(out: ActiveLight[]): number {
    if (out.length === 0) return 0; // no slots to rank into — the insert below indexes out[-1]
    let n = 0;

    const consider = (light: LightSource, fade: number): void => {
      const intensity = light.intensity * fade;
      if (intensity <= 0 || light.radius <= 0) return;
      // Insertion sort into the (very small, fixed-capacity) output: a full scan-then-sort
      // would allocate, and n is at most a handful.
      let at = n < out.length ? n : out.length - 1;
      if (n >= out.length && intensity <= out[at]!.intensity) return; // weaker than the weakest kept
      while (at > 0 && out[at - 1]!.intensity < intensity) {
        copyLight(out[at]!, out[at - 1]!);
        at--;
      }
      const slot = out[at]!;
      slot.x = light.x;
      slot.y = light.y;
      slot.color = light.color;
      slot.radius = light.radius;
      slot.intensity = intensity;
      if (n < out.length) n++;
    };

    for (const light of this.persistent.values()) consider(light, 1);
    for (const t of this.transients) consider(t.light, Math.max(0, t.lifeMs / t.totalMs));

    return n;
  }
}

/** A scratch buffer of `size` reusable light slots — build one per consumer, keep it. */
export function makeLightBuffer(size: number): ActiveLight[] {
  return Array.from({ length: size }, () => ({ x: 0, y: 0, color: 0xffffff, radius: 0, intensity: 0 }));
}

function copyLight(dst: ActiveLight, src: ActiveLight): void {
  dst.x = src.x;
  dst.y = src.y;
  dst.color = src.color;
  dst.radius = src.radius;
  dst.intensity = src.intensity;
}
