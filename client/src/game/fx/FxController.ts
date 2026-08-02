import { BlurFilter, Container, Graphics } from 'pixi.js';
import type { Layers } from '../scene/layers';
import { VignetteFilter, ChromaticAberrationFilter } from './filters';
import { ParticleSystem } from './Particles';

const FX_LIFE_MS = 170; // flash/trail lifetime
const MAX_SHAKE_PX = 14; // camera-shake offset at full trauma (design/01 milestone 3)
const MAX_ZOOM = 1.8; // cap on updateCamera's small-room fill zoom

/** Something that can report its interpolated ground position — the local player's
 *  Actor view, duck-typed so FxController never needs to import game/Actor.ts. */
export interface CameraTarget {
  interpGroundX(alpha: number): number;
  interpGroundY(alpha: number): number;
}

/**
 * Post-processing / game-feel (design/01 fidelity roadmap milestone 3), extracted out
 * of Game.ts 2026-07-28 (that file had accreted 6+ unrelated jobs — this is the "world
 * glow, driven by events" slice: flashes/trails, ambient particles, camera shake/hit-
 * stop/chromatic pulse, and the camera-follow math those feed into). Render-only,
 * reads no engine state directly — Game hands it whatever this frame's derived values
 * are (dust bounds, viewport size, player position) so this stays decoupled from
 * Scene/GameState.
 */
export class FxController {
  readonly particles = new ParticleSystem();
  readonly vignette = new VignetteFilter();
  readonly chromatic = new ChromaticAberrationFilter(0);
  private shakeTrauma = 0;
  private hitStopMs = 0;
  /** Current world→screen zoom applied in updateCamera — CommandBuilder needs this
   *  to convert a screen-space mouse point back to world space (Game.ts reads it
   *  into `cam.zoom`). 1 until the first updateCamera call (no zoom applied yet). */
  zoom = 1;

  constructor(private readonly layers: Layers) {}

  /** Wire post-processing filters + mount the particle view — call once from Game.start(). */
  attach(): void {
    this.layers.world.filters = [this.vignette, this.chromatic];
    // Bloom-lite: a modest blur directly on the ADDITIVE-blended fx layer (muzzle
    // flashes/trails/particles) gives a cheap glow halo without a real multi-pass
    // bright-pass bloom (first-pass approximation, design/01's own "milestone" framing).
    this.layers.fx.filters = [new BlurFilter({ strength: 3, quality: 2 })];
    this.layers.fx.addChild(this.particles.view);
  }

  /** Drop a fading dot at (x,y) — bullet trails (spawnBulletTrails). */
  trailDot(x: number, y: number, color: number, radius: number): void {
    const dot = new Graphics();
    dot.circle(0, 0, radius).fill({ color, alpha: 0.5 });
    dot.blendMode = 'add';
    dot.x = x;
    dot.y = y - 12;
    (dot as unknown as { _life: number })._life = FX_LIFE_MS;
    this.layers.fx.addChild(dot);
  }

  /** A radial glow burst at (x,y) — hit/pickup/status feedback (consumeEvents). */
  flash(x: number, y: number, color: number, radius: number): void {
    const glow = new Graphics();
    const steps = 5;
    for (let i = steps; i >= 1; i--) {
      glow.circle(0, 0, radius * (i / steps)).fill({ color, alpha: 0.16 });
    }
    glow.blendMode = 'add';
    glow.x = x;
    glow.y = y - 12;
    (glow as unknown as { _life: number })._life = FX_LIFE_MS;
    this.layers.fx.addChild(glow);
  }

  /** Fade/expire every `_life`-tagged fx child, step ambient dust, and decay the
   *  chromatic pulse + shake trauma. `dustBounds` is undefined outside a live room
   *  (dungeon mode resizes per room, ROADMAP 1.3); `dustRate` is particles/sec (0
   *  when not actually playing). */
  updateFx(dt: number, dustRate: number, dustBounds: { x: number; y: number; w: number; h: number } | undefined): void {
    for (const child of [...this.layers.fx.children] as Container[]) {
      const holder = child as unknown as { _life?: number };
      if (typeof holder._life !== 'number') continue; // e.g. `particles.view` — not a _life-tagged glow
      holder._life -= dt;
      child.alpha = Math.max(0, holder._life / FX_LIFE_MS);
      child.scale.set(1 + (1 - child.alpha) * 0.6);
      if (holder._life <= 0) {
        this.layers.fx.removeChild(child);
        child.destroy();
      }
    }

    this.particles.update(dt, dustRate, dustBounds);

    // Chromatic-aberration pulse decays back to 0 — a hit reaction, never a permanent look.
    this.chromatic.amount = Math.max(0, this.chromatic.amount - dt * 0.006);
    // Screen-shake trauma also decays here (updateCamera only gets `alpha`, not `dt`; it
    // just reads the current value to compute this frame's offset).
    this.shakeTrauma = Math.max(0, this.shakeTrauma - dt * 0.0025);
  }

  /** Follow `player`, pin the camera inside the room, then add screen-shake on top. A
   *  room smaller than the viewport is zoomed up to fill it (contain-fit: the tighter
   *  axis touches the viewport edge, capped at MAX_ZOOM so a tiny/degenerate room
   *  doesn't blow sprites up into blocks) instead of leaving it centred in a sea of
   *  black — a big room/arena that already covers the viewport at 1x is untouched
   *  (zoom floors at 1, never shrinks). No-op (leaves layers.world untouched) if
   *  there's no player yet. */
  updateCamera(alpha: number, viewport: { vw: number; vh: number }, worldSize: { w: number; h: number } | null, player: CameraTarget | null): void {
    if (!player) return;
    const { vw, vh } = viewport;
    const worldW = worldSize ? worldSize.w : vw;
    const worldH = worldSize ? worldSize.h : vh;
    const zoom = Math.min(MAX_ZOOM, Math.max(1, Math.min(vw / worldW, vh / worldH)));
    this.zoom = zoom;
    const effW = worldW * zoom;
    const effH = worldH * zoom;
    const cx = effW <= vw ? (vw - effW) / 2 : clamp(vw / 2 - player.interpGroundX(alpha) * zoom, vw - effW, 0);
    const cy = effH <= vh ? (vh - effH) / 2 : clamp(vh / 2 - player.interpGroundY(alpha) * zoom, vh - effH, 0);

    const shakeMag = this.shakeTrauma * this.shakeTrauma * MAX_SHAKE_PX;
    const shakeX = shakeMag > 0.05 ? (Math.random() * 2 - 1) * shakeMag : 0;
    const shakeY = shakeMag > 0.05 ? (Math.random() * 2 - 1) * shakeMag : 0;

    this.layers.world.scale.set(zoom);
    this.layers.world.x = cx + shakeX;
    this.layers.world.y = cy + shakeY;
  }

  /** Bump camera-shake trauma (clamped to 1) — call from consumeEvents on an impactful moment. */
  addShake(amount: number): void {
    this.shakeTrauma = Math.min(1, this.shakeTrauma + amount);
  }

  /** Freeze sim ticks for `ms` (offline-only — see Game.hitStopMs's original doc: a
   *  shared online/PvP match can't be frozen from one client). A bigger pause always
   *  wins over a smaller one still counting down, never additive. */
  addHitStop(ms: number): void {
    this.hitStopMs = Math.max(this.hitStopMs, ms);
  }

  /** Bump the chromatic-aberration pulse (clamped to a sane max) — decays in updateFx. */
  pulseChromatic(amount: number): void {
    this.chromatic.amount = Math.min(0.03, this.chromatic.amount + amount);
  }

  /** If hit-stop is active, consume `dt` from it and report true (caller should skip
   *  its sim step this frame); otherwise report false and do nothing. */
  consumeHitStop(dt: number): boolean {
    if (this.hitStopMs <= 0) return false;
    this.hitStopMs = Math.max(0, this.hitStopMs - dt);
    return true;
  }

  /** Reset transient game-feel state for a fresh run (beginRun) — NOT `particles.view`
   *  itself, which is a persistent child of layers.fx mounted once in attach(). */
  resetForNewRun(): void {
    this.particles.clear();
    this.shakeTrauma = 0;
    this.hitStopMs = 0;
    this.chromatic.amount = 0;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
