// The MELEE half of one attack's derivation — split out of rigAttackMotion.ts (2026-09-02,
// 500-line convention) as form (1) — pure functions over a weapon's four numbers, no state, no
// clock and no Pixi. Its sibling is `shotShape.ts` (the ranged half); the shell that owns the
// clock and reads both is `../rigAttackMotion.ts`.
//
// ## What the weapon decides, and what the body keeps
//
// The weapon sets the SIZE, the DIRECTION and the PACE of the stroke. The motion keeps its own
// SHAPE — three phases, a wind-up that leads the strike, a lunge that peaks on it — because that
// is a property of how a body swings rather than of what it is holding.
//
// Four fields drive it, and each one answers a question no other field can:
//
//   arcDeg      how far around the body the stroke travels, AND whether it is a sweep at all —
//               a 60 deg spear sector is a thrust, not an arc (see the sweep/thrust trade below)
//   windowMs    when the strike lands, anchored so the visible stroke covers exactly the ticks
//               the sim can damage on (design/07 step 7)
//   recoveryMs  how long the FOLLOW-THROUGH runs, i.e. how heavy the weapon is to recover from
//   knockback   how hard the body commits, i.e. the impulse the swing actually delivers
//
// ## Why the recovery is back as an input (and is NOT a revert)
//
// `ENGINE_VERSION` 53 moved the timing OFF the recovery and onto the hit window, and that half
// stands unchanged: `strikeEndMs` is still exactly `windowMs`, so the stroke still covers the
// live ticks and nothing else. What that pass could not express is the TAIL. It sized the whole
// envelope as `windowMs / SWING_STRIKE`, so the follow-through was a fixed 82% of the window for
// every weapon — the hammer snapped back to guard in 164 ms and then stood still for the
// remaining ~300 ms of its own recovery, and a 667 ms weapon and a 300 ms one differed only by
// how long their strike took.
//
// So the two segments now derive from the two DIFFERENT quantities they each describe:
//
//   wind-up + strike   <- windowMs      "how long this swing can hit"
//   follow-through     <- recoveryMs    "how long until you may swing again"
//
// The saber comes out byte-identical (see `FOLLOW_SHARE`), which is the point: this is not a
// retune of the reference weapon, it is the roster around it spreading out. Envelope lengths go
// from 182-364 ms (a 2.0x spread, tracking only the window) to 194-418 ms (2.16x, tracking the
// cadence the player actually feels — the recovery's own spread is 2.22x).

/** The weapon-side inputs the swing's shape is derived from, restated in render units so this
 *  file needs no engine import (brad/tick/fp conversion belongs at the read site,
 *  `game/controllers/EventReactor.swingShapeOf`). */
export interface SwingShape {
  /** The weapon's FULL hit sector, degrees — `MeleeSimSpec.arcHalf` x 2. */
  arcDeg: number;
  /**
   * The weapon's ACTIVE HIT WINDOW, ms — `MeleeSimSpec.swingTicks` at the sim's tick rate
   * (design/07 step 7). The ticks during which `HitResolveSystem` is really re-testing this
   * swing's arc, so it is the honest length for the visible STRIKE to cover.
   *
   * Not interchangeable with `recoveryMs` below, and not proportional to it: the spear's window
   * is 33% of its recovery, the hammer's 30%, the frostbrand's 36%. Each sizes its own segment.
   */
  windowMs: number;
  /** The weapon's recovery, ms — `MeleeSimSpec.swingCooldownTicks` at the sim's tick rate. How
   *  long until this actor may swing AGAIN, and therefore how long the follow-through has to
   *  play out in. Always >= `windowMs`: `toSimSpec` clamps `swingTicks` into `[1, cooldown]`. */
  recoveryMs: number;
  /** The weapon's knockback impulse, GRID/S as authored (`MeleeSimSpec.knockback` is fp/tick;
   *  the read site converts back). The roster's own heft axis — hammer 12, saber 6, spear 4,
   *  leech 3 — and the only sim field that states how hard the swing shoves. Drives the body's
   *  commitment, so the lunge you see matches the shove you deliver.
   *
   *  The round trip is LOSSY by up to ~1%, and it is the sim's loss rather than the read site's:
   *  `toFpPerTick` truncates (6 grid/s becomes 198 fp/tick, which reads back as 5.94). It is not
   *  worth recovering — a percent of a 5 px body offset is a hundredth of a screen pixel — but
   *  it does mean this is the ONE input on which the saber does not reproduce its tuned constant
   *  to the bit, and `heftOf` is pinned separately so the curve itself stays exact. */
  knockback: number;
}

/** How far back past the aim line the module cocks before the strike, degrees, FOR THE SABER.
 *  Negative = behind. Applied in the socket's CANONICAL (pre-mirror) space like every other
 *  socket offset, so the arc mirrors with the body instead of sweeping backwards facing left. */
export const SWING_WINDUP_DEG = -22;
/** How far past the aim line the strike carries, degrees, FOR THE SABER. Its full sweep is
 *  `SWING_ARC_DEG - SWING_WINDUP_DEG` = 68 deg, readable at the ~13-20 px an actor occupies
 *  before the room camera's ~4x zoom. */
export const SWING_ARC_DEG = 46;
/** How far the whole body lunges FORWARD at the strike, rig authoring px, FOR THE SABER — the
 *  mirror image of `RECOIL_BODY_PX`, and larger, because a swing is the character committing
 *  weight into the attack where a shot is the character absorbing it. Scaled per weapon by
 *  `heftOf`. */
export const SWING_LUNGE_PX = 5;
/** How far a PURE THRUST drives the weapon module forward along its own barrel at the strike,
 *  rig authoring px. Bigger than the gun's `RECOIL_MODULE_PX` kick because it is the whole read
 *  of the motion rather than a flourish on top of one. */
export const SWING_THRUST_PX = 14;
/** Fraction of the pre-53 envelope spent winding UP. Kept only as the numerator of the
 *  wind-up/strike RATIO below — the envelope is no longer one number long. */
const SWING_WINDUP = 0.3;
/** Exported because it is the ANCHOR between the render envelope and the sim: with
 *  `SWING_WINDUP` these are the pre-53 fractions of the whole envelope, and the wind-up/strike
 *  split is still taken as their ratio so the saber's phase timings are unchanged. */
export const SWING_STRIKE = 0.55;
/** How far the body drifts BACK during the wind-up, as a fraction of the forward travel. Small:
 *  without it the lunge starts from a dead stop and reads as a twitch rather than a swing. */
const SWING_WINDUP_LUNGE = 0.35;

/** The starter saber (`weaponSpecs/starter.ts`: 162 deg, a 4-tick window inside an 11-tick
 *  recovery @ 30 Hz, 6 grid/s knockback). Every derived constant below is defined AS a ratio
 *  against this shape, so `swingSchedule(DEFAULT_SWING)` — and therefore every caller with no
 *  spec to hand, i.e. the Graphics placeholder and any enemy, none of which carry a melee
 *  weapon — reproduces the hand-tuned saber swing EXACTLY rather than approximately. */
export const DEFAULT_SWING: SwingShape = {
  arcDeg: 162,
  windowMs: (4 * 1000) / 30,
  recoveryMs: (11 * 1000) / 30,
  knockback: 6,
};

const SWEEP_DEG = SWING_ARC_DEG - SWING_WINDUP_DEG; // 68 deg — the saber's full travel
const SWEEP_PER_ARC_DEG = SWEEP_DEG / DEFAULT_SWING.arcDeg;
const WINDUP_SHARE = -SWING_WINDUP_DEG / SWEEP_DEG;
/** Bounds on the DERIVED travel, degrees. The blade is drawn from an aim-tracking socket, so a
 *  sweep much past ~100 deg swings it through the body rather than around it; and a sector
 *  narrow enough to derive under ~26 deg stops reading as a swing at the ~13-20 px an actor
 *  occupies. The sector FX (`game/fx/slashArc.ts`) shows the weapon's TRUE arc, unclamped —
 *  these two bounds are about the body's motion staying legible, not about hiding the sector. */
const SWEEP_MIN_DEG = 26;
const SWEEP_MAX_DEG = 104;

// ── The sweep/thrust trade ────────────────────────────────────────────────────
//
// `SWEEP_MIN_DEG` is where a rotation-only motion stops being honest. The spear's sector is
// 60 deg, which derives 25, which the clamp raises to 26 — so the spear was drawing a small
// SWEEP of a sector that is not an arc at all, while its 2.1-grid reach (the longest in the
// roster) went unstated. A 60 deg sector reaching two grid units is a THRUST. Rotation cannot
// express one; a slide along the barrel can, and the channel already exists — it is what the
// gun's recoil uses (`RigSkin`'s aim-tracking `modulePx` offset), just with the sign reversed.

/** At or above this sector the motion is a pure sweep — the saber (162) and everything wider.
 *  Deliberately NOT 150, which is the stormglaive's authored sector: a knee sitting exactly on a
 *  shipped weapon is decided by brad quantization (75 degrees round-trips to 74.998), so that
 *  weapon would derive a hairline thrust or not depending on a rounding direction. */
const SWEEP_ONLY_ARC_DEG = 145;
/** At or below this sector, a pure thrust. The spear's 60 deg is exactly this: the roster floor. */
const THRUST_ONLY_ARC_DEG = 60;
/** How much of its derived rotation a PURE thrust gives up. Not all of it: a stab still lines the
 *  point up, and a slide with zero rotation reads as the weapon being pushed rather than driven. */
const THRUST_SWEEP_TRADE = 0.6;

// ── Heft: how hard the body commits ───────────────────────────────────────────

/** Bounds on the derived lunge multiplier. A square root rather than a straight ratio because
 *  `knockback` spans 4x across the roster (3 to 12) and the lunge is a body offset in authoring
 *  px — a linear map would have the hammer lunging 10 px, which walks the character into its own
 *  target. Under the root the same span becomes 0.71-1.41. */
const HEFT_MIN = 0.6;
const HEFT_MAX = 1.8;

// ── Timing: the two segments, from the two quantities that describe them ──────

/** Share of the weapon's remaining recovery (`recoveryMs - windowMs`) that the follow-through
 *  occupies. Defined as the value that reproduces the pre-2026-09-02 saber tail exactly: that
 *  pass sized the whole envelope as `windowMs / SWING_STRIKE`, so its tail was
 *  `windowMs * (1/0.55 - 1)` = 109.1 ms against the saber's 233.3 ms of post-window recovery.
 *
 *  Being under 1 is also what makes "the stroke fits inside its own recovery" STRUCTURAL rather
 *  than tuned: `total = window + (recovery - window) * s <= recovery` for any `s <= 1` whenever
 *  `window <= recovery`, which `toSimSpec` guarantees. */
const FOLLOW_SHARE =
  (DEFAULT_SWING.windowMs * (1 / SWING_STRIKE - 1))
  / (DEFAULT_SWING.recoveryMs - DEFAULT_SWING.windowMs);
/** Floor on the follow-through, as a fraction of the WINDOW rather than an absolute ms — a
 *  weapon active for most of its own recovery would otherwise derive a near-zero tail and the
 *  blade would STEP back to the aim line on the frame the strike ended. Expressed against the
 *  window so the guard scales with the weapon instead of being one more tuned millisecond count.
 *  It binds only past a window ~65% of the recovery; the roster's widest is the frostbrand's
 *  36%, so nothing shipped reaches it, and where it does bind the overshoot past the recovery is
 *  capped at a quarter of the window. */
const FOLLOW_MIN_OF_WINDOW = 0.25;
/** Far guard on the follow-through, ms — for a future weapon authored at an extreme
 *  `cooldownSec`. The hammer, the roster's slowest, derives 218 ms. Only ever SHORTENS, so it
 *  cannot break the fits-inside-the-recovery property above. */
const FOLLOW_MAX_MS = 400;

/** One swing's fully-derived travel and timing. Shared with the sector FX, which schedules
 *  itself off `strikeStartMs`/`strikeEndMs` so the arc on the ground and the blade in the air
 *  are the same event rather than two effects that happen to overlap. */
export interface SwingSchedule {
  /** Total envelope length, ms — wind-up + strike (the hit window) + follow-through. */
  totalMs: number;
  /** Degrees BEHIND the aim line the module cocks to (negative). */
  windupDeg: number;
  /** Degrees PAST the aim line the strike carries to (positive). */
  strikeDeg: number;
  /** How far the module drives FORWARD along its own barrel at the strike, authoring px, >= 0.
   *  Zero for anything the sweep can express on its own (every weapon at or above 150 deg). */
  thrustPx: number;
  /** How far the body travels into the strike, authoring px, > 0. `SWING_LUNGE_PX` scaled by the
   *  weapon's own heft; `AttackMotion.bodyPx` applies the sign (a lunge is toward the aim). */
  lungePx: number;
  /** ms into the envelope at which the blade leaves the cock and starts crossing the aim line. */
  strikeStartMs: number;
  /** ms into the envelope at which it reaches `strikeDeg` — the sector is fully swept by here,
   *  and the sim's hit window closes on the same millisecond. */
  strikeEndMs: number;
}

/**
 * Derive one swing's schedule. Pure, and cheap enough to call per swing (three clamps, a square
 * root and a handful of multiplies) — nothing caches it, so a weapon retune needs no
 * invalidation anywhere.
 *
 * Worked, against the roster's two extremes and the reference:
 *
 *   weapon   sector  window  recovery  ->  travel   thrust   lunge   strike ends   total
 *   spear     60deg   100ms    300ms       10.4deg  14.0px   4.08px      100ms     194ms
 *   saber    162deg   133ms    367ms       68.0deg   0.0px   5.00px      133ms     242ms
 *   hammer   220deg   200ms    667ms       92.4deg   0.0px   7.07px      200ms     418ms
 *
 * Three weapons, three motions: the spear stabs and is back at guard before the hammer has
 * finished its wind-up. The sector fx inherits all of the timing, since it schedules off
 * `strikeStartMs`/`strikeEndMs`.
 */
export function swingSchedule(shape: SwingShape = DEFAULT_SWING): SwingSchedule {
  const arcDeg = positive(shape.arcDeg, DEFAULT_SWING.arcDeg);
  const windowMs = positive(shape.windowMs, DEFAULT_SWING.windowMs);
  // Never below the window: a recovery shorter than the swing's own live ticks is not a shape
  // this file can honour, and `toSimSpec` cannot author one.
  const recoveryMs = Math.max(positive(shape.recoveryMs, DEFAULT_SWING.recoveryMs), windowMs);

  const thrustShare = clamp(
    (SWEEP_ONLY_ARC_DEG - arcDeg) / (SWEEP_ONLY_ARC_DEG - THRUST_ONLY_ARC_DEG), 0, 1,
  );
  const sweep = clamp(arcDeg * SWEEP_PER_ARC_DEG, SWEEP_MIN_DEG, SWEEP_MAX_DEG)
    * (1 - THRUST_SWEEP_TRADE * thrustShare);
  const followMs = Math.min(
    Math.max((recoveryMs - windowMs) * FOLLOW_SHARE, windowMs * FOLLOW_MIN_OF_WINDOW),
    FOLLOW_MAX_MS,
  );

  return {
    totalMs: windowMs + followMs,
    windupDeg: -sweep * WINDUP_SHARE,
    strikeDeg: sweep * (1 - WINDUP_SHARE),
    thrustPx: SWING_THRUST_PX * thrustShare,
    lungePx: SWING_LUNGE_PX * heftOf(shape.knockback),
    // The RATIO of the two pre-53 envelope fractions, so the saber's wind-up still ends at 30%
    // of its (unchanged) total. The wind-up necessarily plays INSIDE the live hit window — the
    // render layer learns about a swing on the tick it starts and cannot anticipate it — which
    // is the one part of the shape that cannot be honest, and is unchanged from before.
    strikeStartMs: windowMs * (SWING_WINDUP / SWING_STRIKE),
    strikeEndMs: windowMs,
  };
}

/** The body's commitment multiplier for a weapon that shoves this hard, 1 at the saber's own
 *  6 grid/s. Its own function so the curve is stated once and can be asked for rather than
 *  restated by a future read site. */
export function heftOf(knockback: number): number {
  const k = positive(knockback, DEFAULT_SWING.knockback);
  return clamp(Math.sqrt(k / DEFAULT_SWING.knockback), HEFT_MIN, HEFT_MAX);
}

/**
 * Extra rotation the weapon socket carries `elapsedMs` into this swing, DEGREES in canonical
 * (pre-mirror) space: cock back, drive through the aim line, settle onto it. Exactly 0 at both
 * ends — a swing that finished anywhere else leaves that weapon permanently off its aim.
 */
export function swingRotationDeg(elapsedMs: number, s: SwingSchedule): number {
  const { windupDeg, strikeDeg, strikeStartMs, strikeEndMs, totalMs } = s;
  if (elapsedMs <= 0 || elapsedMs >= totalMs) return 0;
  if (elapsedMs < strikeStartMs) return lerp(0, windupDeg, elapsedMs / strikeStartMs);
  if (elapsedMs < strikeEndMs)
    return lerp(windupDeg, strikeDeg, (elapsedMs - strikeStartMs) / (strikeEndMs - strikeStartMs));
  return lerp(strikeDeg, 0, (elapsedMs - strikeEndMs) / (totalMs - strikeEndMs));
}

/**
 * The swing's TRAVEL profile — the same three phases as `swingRotationDeg`, as a unitless
 * multiplier: drift back through the wind-up, drive forward to 1 at the strike, recover to 0.
 * Both things the swing moves in a straight line read it, so the body's lunge and a spear's
 * thrust are one motion rather than two that happen to peak together.
 */
export function swingTravel(elapsedMs: number, s: SwingSchedule): number {
  const { strikeStartMs, strikeEndMs, totalMs } = s;
  if (elapsedMs <= 0 || elapsedMs >= totalMs) return 0;
  if (elapsedMs < strikeStartMs) return lerp(0, -SWING_WINDUP_LUNGE, elapsedMs / strikeStartMs);
  if (elapsedMs < strikeEndMs)
    return lerp(-SWING_WINDUP_LUNGE, 1, (elapsedMs - strikeStartMs) / (strikeEndMs - strikeStartMs));
  return lerp(1, 0, (elapsedMs - strikeEndMs) / (totalMs - strikeEndMs));
}

/** `v` when it is a usable positive number, else `fallback`. Guards every derived quantity in
 *  one place: a caller with a malformed spec gets the saber's own shape rather than an
 *  `Infinity` that would freeze the blade mid-air forever. */
function positive(v: number, fallback: number): number {
  return v > 0 ? v : fallback;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
