import { BlurFilter, Container, Graphics } from 'pixi.js';
import type { Layers } from '../scene/layers';
import { VignetteFilter, ChromaticAberrationFilter } from './filters';
import { ParticleSystem } from './Particles';
import { LightRegistry } from './lighting';

const FX_LIFE_MS = 170; // flash/trail lifetime
const MAX_SHAKE_PX = 14; // camera-shake offset at full trauma (design/01 milestone 3)
// Cap on updateCamera's fill zoom — raised from 1.8 (design/10's original legibility
// fix) to 2.5 (user report, 2026-08-12): a floor whose combined room width is well
// under the viewport left a wide dark `Backdrop` void beside the room that read as "the
// game viewport doesn't fill the window" rather than an intentional letterbox (the void
// colour is deliberately very dark — theme.ts's `BiomePalette.void` — so it's visually
// indistinguishable from an unrendered black canvas). A higher cap shrinks that void by
// zooming a small floor in further before the degenerate-blockiness limit kicks in; it
// does NOT touch the zoom=1 floor for anything already viewport-sized+. Superseded for
// the VOID ITSELF by the cover-fit switch below (2026-08-12 follow-up) — this cap now
// only guards against a truly tiny/degenerate room forcing an absurd zoom, not against
// letterboxing (cover-fit has none).
// Raised again 2026-08-17 (2.5 -> 4.5) when the fit target became the current ROOM
// rather than the whole floor: level 1's authored rooms are ~470-560 px square, so
// cover-fitting one into a 1920x911 viewport wants ~3.4-4.1x and the old 2.5 cap bound
// in every single room — the room rendered ~1170 px wide inside a 1920 px viewport and
// the neighbours on either side stayed on screen, which is exactly what the fit change
// was for. At 4x the hero reads about a seventh of the screen height, in line with the
// genre. This remains a guard against a degenerate/tiny room, not a framing dial.
const MAX_ZOOM = 4.5;
// How much of the frame the camera looks ABOVE the follow target's ground point, as a
// fraction of the viewport height (user report, 2026-08-17: "镜头往下一些 … 给角色最好
// 的展示"). Every entity reports its GROUND position — the point at its feet, where its
// shadow and collision footprint sit (Entity.applyTransform) — so a camera centred on
// it puts the character's feet dead centre and its whole body in the upper half of the
// screen, with a band of empty floor below. Biasing the look-at point upward in world
// space slides the rendered world DOWN, which is what re-centres the character in the
// frame. 8% of the viewport, not a fixed pixel count, so it scales with the window and
// with the zoom the frame-fit picks.
const CAMERA_BODY_BIAS_R = 0.08;

/** Something that can report its interpolated ground position — the local player's
 *  Actor view, duck-typed so FxController never needs to import game/Actor.ts. */
export interface CameraTarget {
  interpGroundX(alpha: number): number;
  interpGroundY(alpha: number): number;
}

/** A world-px rect for the camera to fill — the room the local player is standing in
 *  (`GameLoop.updateCamera` resolves it), falling back to the whole floor. */
export interface CameraFrame {
  x: number;
  y: number;
  w: number;
  h: number;
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
  /** Dynamic point lights (design/01 milestone 2) — the local-player glow (registered
   *  by Game.ts each frame) plus transient bursts registered by `flash()` below. */
  readonly lights = new LightRegistry();
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

  /** A radial glow burst at (x,y) — hit/pickup/status feedback (consumeEvents). Also
   *  registers a matching transient point light (design/01 milestone 2) so nearby
   *  actors visibly brighten for the same instant the burst is on screen — same
   *  lifetime, same colour, no separate call site needed. */
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
    this.lights.addTransient({ x, y, color, radius: radius * 3, intensity: 0.7 }, FX_LIFE_MS);
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
    this.lights.update(dt);

    // Chromatic-aberration pulse decays back to 0 — a hit reaction, never a permanent look.
    this.chromatic.amount = Math.max(0, this.chromatic.amount - dt * 0.006);
    // Screen-shake trauma also decays here (updateCamera only gets `alpha`, not `dt`; it
    // just reads the current value to compute this frame's offset).
    this.shakeTrauma = Math.max(0, this.shakeTrauma - dt * 0.0025);
  }

  /** Follow `player`, pin the camera inside the world, then add screen-shake on top.
   *
   *  Cover-fit zoom (design/10, 2026-08-12 follow-up — replaced the original contain-
   *  fit): zoom by whichever axis needs the MOST zoom to fill the viewport, so both
   *  axes always cover it — no letterbox void on either axis, ever, capped at MAX_ZOOM
   *  so a tiny/degenerate room doesn't blow sprites up into blocks. The tradeoff (the
   *  fitted rect is now routinely bigger than the viewport on the axis that didn't need
   *  the zoom) is exactly what the clamp branch below was already built to handle — an
   *  edge or door can scroll off-screen while the player is elsewhere, back into view as
   *  they approach it, same as any camera-follow game.
   *
   *  What it fits, though, is `frame` — the ROOM the player is standing in — not the
   *  whole floor (user report, 2026-08-17: "尽量视口内只有当前房间"). A dungeon floor is
   *  co-resident: every room of it is stitched into one world (`world/dungeon`'s
   *  `buildFloorGeometry`), so fitting `worldSize` meant fitting the whole floor, which
   *  is far wider than any viewport — cover-fit therefore resolved to zoom 1 and the
   *  player saw several rooms at once, each one small. Fitting the current room instead
   *  puts that room (and essentially only it) on screen. `frame` is null in a mode with
   *  no room model, or in the tick before the player's room is resolved; the whole floor
   *  is then the fallback, i.e. exactly the previous behaviour.
   *
   *  Panning still clamps to the WORLD, never to `frame`: clamping to the room would
   *  hard-stop the camera at a doorway, cutting off the corridor the player is about to
   *  walk into. A room whose fitted zoom leaves it larger than the viewport keeps the
   *  pan; one smaller than the viewport just shows a little of its neighbours at the
   *  edges, which reads as depth rather than as a mistake.
   *
   *  No-op (leaves layers.world untouched) if there's no player yet. */
  updateCamera(
    alpha: number,
    viewport: { vw: number; vh: number },
    worldSize: { w: number; h: number } | null,
    player: CameraTarget | null,
    frame: CameraFrame | null = null,
  ): void {
    if (!player) return;
    const { vw, vh } = viewport;
    const worldW = worldSize ? worldSize.w : vw;
    const worldH = worldSize ? worldSize.h : vh;
    const fitW = frame ? frame.w : worldW;
    const fitH = frame ? frame.h : worldH;
    const zoom = Math.min(MAX_ZOOM, Math.max(1, vw / fitW, vh / fitH));
    this.zoom = zoom;
    const effW = worldW * zoom;
    const effH = worldH * zoom;
    // Look slightly ABOVE the follow target's feet so the character sits in the middle
    // of the frame rather than in its top half — see CAMERA_BODY_BIAS_R.
    const targetY = player.interpGroundY(alpha) - (vh * CAMERA_BODY_BIAS_R) / zoom;
    const cx = effW <= vw ? (vw - effW) / 2 : clamp(vw / 2 - player.interpGroundX(alpha) * zoom, vw - effW, 0);
    const cy = effH <= vh ? (vh - effH) / 2 : clamp(vh / 2 - targetY * zoom, vh - effH, 0);

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
    this.lights.clear();
    this.shakeTrauma = 0;
    this.hitStopMs = 0;
    this.chromatic.amount = 0;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
