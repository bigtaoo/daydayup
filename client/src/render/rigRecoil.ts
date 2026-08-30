// Split out of RigSkin.ts (2026-08-30, 500-line convention): the render-only fire-recoil
// envelope, form ① — a tiny independent state machine with no Pixi and no rig knowledge,
// same category as `facing.ts`/`interpolate.ts`.
//
// Why this is procedural and not an authored clip. Three of the seven shipped bundles
// (`char_*`) carry an `attack` clip; the four enemy ones do not, and every bundle's clips
// are sampled WHOLE — `RigSkin.playClip` swaps `this.clip` outright, there is no additive
// layer. So playing `attack` would (a) do nothing at all for any enemy, and (b) for a hero,
// drop every bone the clip does not track back to rest for its whole duration: orb-core's
// `attack` touches only `socket_r`, so the shell/eye/belly hover bob authored into `idle`
// would snap to 0 the instant a shot went out and snap back 350 ms later. At the starter
// gun's 6-tick cooldown (200 ms) the clip also re-triggers before it ends, so held fire
// would pin the body at bob 0 and release would pop it. An envelope layered ON TOP of
// whatever clip is playing has neither problem and covers all seven rigs with one path.
//
// The authored `attack` clips are left in the bundles untouched — they are still the right
// place for a real per-character firing pose once every rig has one and there is a blend to
// play it through.

/** Total time one shot's recoil takes to kick out and settle back, ms. */
export const RECOIL_MS = 150;
/** Fraction of `RECOIL_MS` spent kicking OUT. The rest is the return. A fast punch and a
 *  slow-ish settle is what reads as weight; a symmetric triangle reads as a wobble. */
const RECOIL_ATTACK = 0.22;
/** How far the weapon module slides back along its own barrel at the peak, in rig
 *  AUTHORING px (the space `rigWeaponMount` works in — a rig's own scale to world px is
 *  `radius / referenceRadius`, ~0.35 for orb-core, and the room camera then zooms ~4x, so
 *  this lands around a dozen screen px). Sized against the authored `attack` clip's own
 *  `translateX: -10` on the same bone, which is the look this replaces. */
export const RECOIL_MODULE_PX = 10;
/** How far the whole body shoves back with the shot, same units. Deliberately a small
 *  fraction of the module's kick: the gun recoils, the character only leans. */
export const RECOIL_BODY_PX = 3;

/**
 * A one-shot 0→1→0 envelope, restarted by every `kick()`. Sampling is pure — the value is
 * a function of the remaining time alone — so nothing here can drift with frame rate, and
 * a shot that lands while the previous one is still settling simply restarts it (which is
 * what a fast weapon should look like: the gun never gets back to rest).
 */
export class Recoil {
  private ms = 0;

  /** A shot just left this rig — restart the envelope at full strength. */
  kick(): void {
    this.ms = RECOIL_MS;
  }

  /** Advance by one render frame's `dt` (ms). Safe to call with 0. */
  advance(dtMs: number): void {
    this.ms = Math.max(0, this.ms - dtMs);
  }

  /** 0 at rest, 1 at the peak of the kick. */
  get amount(): number {
    if (this.ms <= 0) return 0;
    const u = 1 - this.ms / RECOIL_MS; // 0 at the shot, 1 when fully settled
    return u < RECOIL_ATTACK ? u / RECOIL_ATTACK : (1 - u) / (1 - RECOIL_ATTACK);
  }

  /** How far the weapon module sits back along its barrel this frame, authoring px. */
  get modulePx(): number {
    return this.amount * RECOIL_MODULE_PX;
  }

  /** How far the whole body sits back this frame, authoring px. */
  get bodyPx(): number {
    return this.amount * RECOIL_BODY_PX;
  }
}
