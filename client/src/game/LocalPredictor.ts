/**
 * Local-player prediction (ROADMAP 3.3 follow-up, design/06 "client-side prediction of the
 * local player only"). A pure RENDER-LAYER latency-hiding layer: it draws the local seat's
 * own sprite/camera ahead of the confirmed frame stream so twin-stick movement responds
 * instantly under network latency, then eases back to the authoritative position as
 * confirmed frames arrive. It NEVER touches the deterministic sim — the confirmed path stays
 * byte-identical (design/06 "slots on top without changing the confirmed path"), so there is
 * zero desync risk. Scope is the local player's MOVEMENT + AIM only; firing stays sim-
 * confirmed (bullets are sim entities — predicting them would need sim rollback, the costly
 * path design/06 rejects for casual/WeChat).
 *
 * Model: dead-reckon the predicted position by the live local input each render frame
 * (matching the sim's own speed, so at zero latency predicted ≈ confirmed), and on each new
 * confirmed frame correct the predicted position toward the true one — snap on a large error
 * (a teleport / room transition / bad desync), lerp on a small one. The snap-vs-lerp
 * threshold + gain are the tuning knob design/06 leaves open to tune against real RTT (feel
 * it via the `?lag=` harness in Game.ts). Working in float px is fine here — this is the
 * render layer, downstream of `fromFp`, and its output never re-enters the sim.
 */
import { bradToRad } from './coords';

export interface PredictorConfig {
  /** Local player top speed in px/sec — MUST match the sim (fpToPx(speedPerTick) × simHz). */
  speedPxPerSec: number;
  /** Confirmed-vs-predicted error (px) above which we snap instead of easing. */
  snapPx: number;
  /** Per-confirmed-frame lerp fraction (0..1) applied when the error is below `snapPx`. */
  correctionGain: number;
}

export interface Pose {
  x: number;
  y: number;
  facing: number; // radians
}

export const DEFAULT_PREDICTOR: Omit<PredictorConfig, 'speedPxPerSec'> = {
  snapPx: 48, // ~1.5 grid — a real desync / teleport, not normal RTT drift
  correctionGain: 0.25, // gentle ease; converges in a handful of confirmed frames
};

const MOVE_MAG_MAX = 255; // PlayerCommand.moveMag range (state/commands.ts)

export class LocalPredictor {
  private x = 0;
  private y = 0;
  private facing = 0;
  private active = false;

  constructor(private readonly cfg: PredictorConfig) {}

  get isActive(): boolean {
    return this.active;
  }
  get pose(): Pose {
    return { x: this.x, y: this.y, facing: this.facing };
  }

  /** Anchor prediction to a known confirmed pose (px/radians): match start, first frame,
   *  or any deliberate snap. Activates prediction. */
  reset(x: number, y: number, facing: number): void {
    this.x = x;
    this.y = y;
    this.facing = facing;
    this.active = true;
  }

  /** Suspend prediction (local player downed/dead) — the caller falls back to confirmed. */
  deactivate(): void {
    this.active = false;
  }

  /**
   * Dead-reckon one render frame from the live local command. Advances the predicted
   * position by the sim's own per-second speed scaled by move magnitude, and sets facing
   * straight from aim (instant — the felt win). No-op while inactive.
   */
  predict(moveBrad: number, moveMag: number, aimBrad: number, dtMs: number): void {
    if (!this.active) return;
    const mag = Math.max(0, Math.min(MOVE_MAG_MAX, moveMag)) / MOVE_MAG_MAX;
    const v = this.cfg.speedPxPerSec * mag * (dtMs / 1000);
    if (v > 0) {
      const dir = bradToRad(moveBrad);
      this.x += Math.cos(dir) * v;
      this.y += Math.sin(dir) * v;
    }
    this.facing = bradToRad(aimBrad);
  }

  /**
   * Correct the predicted position toward the authoritative confirmed one. Call ONCE per
   * newly-confirmed frame (never on a stall — that would drag prediction back). Snaps when
   * the gap exceeds `snapPx` (teleport/desync), otherwise eases by `correctionGain`.
   */
  reconcile(confirmedX: number, confirmedY: number): void {
    if (!this.active) return;
    const ex = confirmedX - this.x;
    const ey = confirmedY - this.y;
    if (Math.hypot(ex, ey) > this.cfg.snapPx) {
      this.x = confirmedX;
      this.y = confirmedY;
    } else {
      this.x += ex * this.cfg.correctionGain;
      this.y += ey * this.cfg.correctionGain;
    }
  }
}
