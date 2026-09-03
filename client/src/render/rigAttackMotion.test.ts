/**
 * The fire-recoil envelope (`rigAttackMotion.ts`) — the render-only "this rig just shot" pulse that
 * replaced the never-played `attack` clip.
 *
 * What these pin is the SHAPE, because every visible property of the recoil is a property of
 * the curve and none of them shows up in a screenshot of a single frame: it must start at
 * rest, spike fast, come back to exactly rest (a curve that settles at a non-zero value leaves
 * the gun permanently displaced), and restart cleanly when the next shot lands mid-settle,
 * which is the normal case for every weapon in the game — the starter blaster's cooldown is
 * 6 ticks / 200 ms against a 150 ms envelope.
 */
import { describe, it, expect } from 'vitest';
import {
  WEAPON_SIM_BY_ID, TICK_RATE, type MeleeSimSpec, type RangedSimSpec,
} from '@dd/engine';
// The mob gun is the roster's slowest weapon by a wide margin and is what every enemy in the
// game fires, but `weapons.ts` filters it out of `WEAPON_SIM_BY_ID` (it is not player-facing),
// so the ceiling case below has to reach for its own export.
import { ENEMY_GUN_SIM } from '@dd/engine/content/weapons';
import {
  AttackMotion, RECOIL_MS, RECOIL_MODULE_PX, RECOIL_BODY_PX, RECOIL_CLIMB_DEG,
  SWING_STRIKE, SWING_ARC_DEG, SWING_WINDUP_DEG, SWING_LUNGE_PX, SWING_THRUST_PX,
  DEFAULT_SWING, DEFAULT_SHOT, swingSchedule, recoilSchedule, heftOf, kickOf,
  type ShotShape, type SwingShape,
} from './rigAttackMotion';

/** A `SwingShape` differing from the starter saber only where a case says it does. Every melee
 *  literal below goes through this: the shape has four fields and any one of them left at a
 *  hand-typed value would quietly become a second variable in a test comparing two weapons. */
const swing = (over: Partial<SwingShape> = {}): SwingShape => ({ ...DEFAULT_SWING, ...over });

/**
 * The DEFAULT melee envelope's real length, ms. Not `SWING_MS`: since ENGINE_VERSION 53 the
 * envelope is derived from the swinging weapon's ACTIVE HIT WINDOW, and a caller with no weapon
 * to hand gets `DEFAULT_SWING` — the saber's 162° and its 4-tick window — which lands at
 * ~242 ms, not the 260 ms constant that used to be the answer. Every test below that samples
 * the envelope at a FRACTION of its length has to use this; `SWING_MS` is now only correct for
 * the fallback-value cases and for over-advancing past the end.
 */
const DEFAULT_TOTAL_MS = swingSchedule(DEFAULT_SWING).totalMs;

describe('AttackMotion, ranged — the envelope at rest', () => {
  it('is exactly zero before anything fires', () => {
    const r = new AttackMotion();
    expect(r.amount).toBe(0);
    expect(r.modulePx).toBe(0);
    expect(r.bodyPx).toBe(0);
  });

  it('stays zero however long an un-kicked envelope is advanced', () => {
    const r = new AttackMotion();
    for (let i = 0; i < 20; i++) r.advance(16);
    expect(r.amount).toBe(0);
  });

  it('returns to exactly zero once the envelope has run out — never a residual offset', () => {
    const r = new AttackMotion();
    r.kick('ranged');
    r.advance(RECOIL_MS);
    expect(r.amount).toBe(0);
    expect(r.modulePx).toBe(0);
    // ...and over-advancing past the end cannot drive it negative (which would push the gun
    // FORWARD out of the barrel rather than leave it alone).
    r.advance(RECOIL_MS * 10);
    expect(r.amount).toBe(0);
  });
});

describe('AttackMotion, ranged — the envelope shape', () => {
  it('kicks out fast and settles back slowly — not a symmetric wobble', () => {
    const r = new AttackMotion();
    r.kick('ranged');
    const at = (elapsed: number): number => {
      const s = new AttackMotion();
      s.kick('ranged');
      s.advance(elapsed);
      return s.amount;
    };
    const peakAt = RECOIL_MS * 0.22; // RECOIL_ATTACK, restated so a retune shows up as a failure
    expect(at(peakAt)).toBeCloseTo(1, 6);
    // Rising before the peak, falling after it.
    expect(at(peakAt * 0.5)).toBeGreaterThan(0);
    expect(at(peakAt * 0.5)).toBeLessThan(at(peakAt));
    expect(at(peakAt * 1.5)).toBeLessThan(at(peakAt));
    // The return takes longer than the kick: at the same DISTANCE either side of the peak the
    // returning value is still high, because it has much further to travel.
    expect(at(peakAt * 2)).toBeGreaterThan(at(peakAt * 0.5));
  });

  it('never exceeds 1, so the offsets never exceed their authored maxima', () => {
    for (let t = 0; t <= RECOIL_MS; t += 3) {
      const r = new AttackMotion();
      r.kick('ranged');
      r.advance(t);
      expect(r.amount).toBeLessThanOrEqual(1 + 1e-9);
      expect(r.amount).toBeGreaterThanOrEqual(0);
    }
  });

  it('scales the module kick and the body lean off the same envelope', () => {
    const r = new AttackMotion();
    r.kick('ranged');
    r.advance(RECOIL_MS * 0.22);
    expect(r.modulePx).toBeCloseTo(RECOIL_MODULE_PX, 6);
    expect(r.bodyPx).toBeCloseTo(RECOIL_BODY_PX, 6);
  });

  // The gun recoils, the character only leans. If these ever invert, the body slides out from
  // under a gun that stayed put, which is the opposite of the cue.
  it('leans the body less than it kicks the gun', () => {
    expect(RECOIL_BODY_PX).toBeLessThan(RECOIL_MODULE_PX);
  });
});

describe('AttackMotion, ranged — a shot landing while the last one is still settling', () => {
  it('restarts at full strength rather than accumulating', () => {
    const r = new AttackMotion();
    r.kick('ranged');
    r.advance(RECOIL_MS * 0.8); // mostly settled
    const mid = r.amount;
    expect(mid).toBeGreaterThan(0);
    r.kick('ranged');
    expect(r.amount).toBe(0); // back to the very start of the envelope, not stacked on `mid`
    r.advance(RECOIL_MS * 0.22);
    expect(r.amount).toBeCloseTo(1, 6);
  });

  it('is frame-rate independent — the value depends on elapsed time, not on step count', () => {
    const coarse = new AttackMotion();
    coarse.kick('ranged');
    coarse.advance(30);
    const fine = new AttackMotion();
    fine.kick('ranged');
    for (let i = 0; i < 6; i++) fine.advance(5);
    expect(fine.amount).toBeCloseTo(coarse.amount, 12);
  });

  it('tolerates a zero-length frame (the rest-pose layout pass calls it with dt 0)', () => {
    const r = new AttackMotion();
    r.kick('ranged');
    r.advance(0);
    expect(r.amount).toBe(0); // t=0 is the very start of the kick, not the peak
    expect(Number.isFinite(r.modulePx)).toBe(true);
  });
});

/**
 * The MELEE half (2026-09-02). A swing is not a recoil with a different constant — it is the
 * opposite motion, so what these pin is the three-phase SHAPE, which no single frame shows:
 * cock BEHIND the aim line, sweep PAST it, recover to exactly it, while the body drifts back
 * and then drives forward. A curve that settled anywhere but 0 would leave the blade
 * permanently off its aim, which is the same failure the ranged block above guards against.
 *
 * The blade's sweep can only live here. `RigSkin` OVERWRITES every aim-tracking bone's rotation
 * with the aim angle each frame (`rigWeaponMount.AIM_TRACKING_BONES`), so an authored clip
 * cannot rotate a weapon socket at all — an `attack` clip that tried would be discarded in
 * silence. `rigComposition.test.ts` pins the data side of the same split.
 */
describe('AttackMotion, melee — the swing arc', () => {
  const at = (u: number): AttackMotion => {
    const m = new AttackMotion();
    m.kick('melee');
    m.advance(DEFAULT_TOTAL_MS * u);
    return m;
  };

  it('starts and ends exactly on the aim line', () => {
    expect(at(0).weaponDeg).toBe(0);
    const spent = at(1);
    expect(spent.weaponDeg).toBe(0);
    expect(spent.bodyPx).toBe(0);
    spent.advance(DEFAULT_TOTAL_MS); // and stays there however long it is advanced afterwards
    expect(spent.weaponDeg).toBe(0);
  });

  it('cocks BEHIND the aim before it sweeps ahead of it — the wind-up is what sells the swing', () => {
    // Sign matters and is the whole read: a swing that only ever leads the aim looks like the
    // blade snapping to a new angle, not like a character winding up.
    expect(at(0.15).weaponDeg).toBeLessThan(0);
    expect(at(0.3).weaponDeg).toBeCloseTo(SWING_WINDUP_DEG, 6); // the deepest point of the wind-up
    expect(at(0.55).weaponDeg).toBeCloseTo(SWING_ARC_DEG, 6); // and the far end of the strike
    expect(at(0.8).weaponDeg).toBeGreaterThan(0); // recovering, still ahead of the aim
  });

  it('sweeps monotonically from the cock to the strike, then monotonically back', () => {
    const sample = (from: number, to: number, n = 24): number[] =>
      Array.from({ length: n + 1 }, (_, i) => at(from + ((to - from) * i) / n).weaponDeg);
    const rising = sample(0.3, 0.55);
    const falling = sample(0.55, 1);
    for (let i = 1; i < rising.length; i++) expect(rising[i]!).toBeGreaterThan(rising[i - 1]!);
    for (let i = 1; i < falling.length; i++) expect(falling[i]!).toBeLessThan(falling[i - 1]!);
  });

  it('leans the body INTO the swing, the opposite sign to a shot shoving it back', () => {
    // `bodyPx` is one signed number for both kinds so `RigSkin` keeps one formula (positive =
    // away from the aim, negative = into it). If this sign ever flipped, a swing would read as
    // the character recoiling from their own blade, and nothing else in the suite would notice.
    const shot = new AttackMotion();
    shot.kick('ranged');
    shot.advance(RECOIL_MS * 0.22);
    expect(shot.bodyPx).toBeGreaterThan(0);

    expect(at(0.55).bodyPx).toBeCloseTo(-SWING_LUNGE_PX, 6); // full lunge at the strike
    expect(at(0.15).bodyPx).toBeGreaterThan(0); // and drifting back during the wind-up
  });

  it('never slides a WIDE blade along its barrel — the saber rotates, it does not recoil', () => {
    // Held as an invariant for the default shape specifically. It used to be the rule for every
    // swing; since 2026-09-02 a NARROW weapon thrusts instead of sweeping (see
    // `attack/swingShape.ts`'s sweep/thrust trade, and the spear case further down), and the
    // saber at 162 degrees is comfortably on the sweep-only side of that trade.
    for (const u of [0, 0.2, 0.4, 0.6, 0.8, 1]) expect(at(u).modulePx).toBe(0);
  });

  it('keeps the two kinds off each other envelopes, on the one getter they share', () => {
    // `amount` is the ranged envelope and nothing else, so a swing must report 0 on it — a kind
    // leaking there would apply BOTH motions at once, the gun kick and the blade sweep on the
    // same frame. `weaponDeg` is deliberately NOT symmetric: since 2026-09-02 both kinds write
    // to it (a swing's arc, a shot's muzzle climb), so what it owes is that the two stay the
    // right SIZE for their kind — a shot must never rotate the weapon by a swing's tens of
    // degrees, which is what an envelope crossover would look like on screen.
    expect(at(0.5).amount).toBe(0);
    const shot = new AttackMotion();
    shot.kick('ranged');
    shot.advance(RECOIL_MS * 0.5);
    expect(Math.abs(shot.weaponDeg)).toBeLessThan(RECOIL_CLIMB_DEG + 0.001);
    expect(Math.abs(shot.weaponDeg)).toBeLessThan(Math.abs(at(0.3).weaponDeg)); // vs the wind-up
    expect(shot.modulePx).toBeGreaterThan(0); // and it slides back, where a wide blade does not
  });

  it('a swap mid-motion switches the envelope wholesale rather than blending', () => {
    const m = new AttackMotion();
    m.kick('ranged');
    m.advance(RECOIL_MS * 0.22); // at the recoil peak
    expect(m.modulePx).toBeCloseTo(RECOIL_MODULE_PX, 6);
    m.kick('melee');
    expect(m.modulePx).toBe(0); // the gun kick is gone the same frame
    expect(m.weaponDeg).toBe(0); // and the swing starts from its own t=0
    m.advance(DEFAULT_TOTAL_MS * 0.55);
    expect(m.weaponDeg).toBeCloseTo(SWING_ARC_DEG, 6);
  });

  it('a swing restarts cleanly when the next one lands mid-recovery', () => {
    const m = new AttackMotion();
    m.kick('melee');
    m.advance(DEFAULT_TOTAL_MS * 0.9);
    expect(m.weaponDeg).toBeGreaterThan(0); // still recovering
    m.kick('melee');
    expect(m.weaponDeg).toBe(0);
  });

  it('is frame-rate independent, like the recoil', () => {
    const coarse = new AttackMotion();
    coarse.kick('melee');
    coarse.advance(60);
    const fine = new AttackMotion();
    fine.kick('melee');
    for (let i = 0; i < 12; i++) fine.advance(5);
    expect(fine.weaponDeg).toBeCloseTo(coarse.weaponDeg, 12);
    expect(fine.bodyPx).toBeCloseTo(coarse.bodyPx, 12);
  });

  it('the swing fits inside the starter saber own recovery, so held fire reads as discrete swings', () => {
    // SABER_SIM.swingCooldownTicks is 11 ticks at 30 Hz = ~367 ms (engine/content/weaponSpecs
    // /starter.ts, pinned in WeaponFireSystem.test.ts). A swing longer than that would still be
    // mid-arc when the next one restarted it, and the blade would never return to the aim line.
    expect(DEFAULT_TOTAL_MS).toBeLessThan((11 * 1000) / 30);
  });

  it('never moves anything before the first attack', () => {
    const m = new AttackMotion();
    for (let i = 0; i < 20; i++) m.advance(16);
    expect(m.weaponDeg).toBe(0);
    expect(m.bodyPx).toBe(0);
    expect(m.modulePx).toBe(0);
    expect(m.amount).toBe(0);
  });

  it('starts from a standstill — the body has not moved on the trigger frame', () => {
    // The mirror of the ranged case above, and the same reason: a body that is already
    // displaced on the frame the attack lands reads as a teleport, not as a wind-up.
    const m = new AttackMotion();
    m.kick('melee');
    // closeTo, not toBe: the lunge profile is 0 at u=0 and `-0 * SWING_LUNGE_PX` is `-0`, which
    // `Object.is` rejects against `+0`. Same reason `RigSkin.test.ts` compares `view.x` this way.
    expect(m.bodyPx).toBeCloseTo(0, 12);
    expect(m.weaponDeg).toBe(0);
  });

  it('the wind-up pull-back is a fraction of the lunge, not a second lunge', () => {
    // Sized, not just signed. The pull-back exists to give the lunge somewhere to come FROM;
    // at parity the swing would read as a rock back and forth with no strike in it.
    const peakBack = Math.max(...[0.05, 0.1, 0.15, 0.2, 0.25, 0.3].map(u => at(u).bodyPx));
    expect(peakBack).toBeGreaterThan(0);
    expect(peakBack).toBeLessThan(SWING_LUNGE_PX / 2);
  });

  it('an advance past the end leaves the envelope at rest, however long the stall', () => {
    // A long stall — a tab regaining focus, a frame hitch — hands `advance` a dt many times the
    // envelope's own length. What matters is that the pose is at rest afterwards, which this
    // asserts directly.
    //
    // It does NOT pin `advance`'s `Math.max(0, ...)` clamp: dropping that clamp survives this
    // whole file, and it is a true equivalent rather than a gap. `progress` gates on
    // `this.ms <= 0`, which a negative `ms` satisfies exactly as zero does, and nothing
    // accumulates across a `kick()`. The clamp is kept because it states the intent, not
    // because any output depends on it — the same verdict `RigSkin.heldMountBody`'s unobservable
    // guard carries.
    const m = new AttackMotion();
    m.kick('melee');
    m.advance(DEFAULT_TOTAL_MS * 10);
    expect(m.weaponDeg).toBe(0);
    expect(m.bodyPx).toBe(0);
    const r = new AttackMotion();
    r.kick('ranged');
    r.advance(RECOIL_MS * 10);
    expect(r.amount).toBe(0);
  });
});

/**
 * The WEAPON's half of the swing (2026-09-02, asked directly: "is the melee attack animation's
 * amplitude tied to the weapon's own attack sector?" — it was not, and now it is).
 *
 * What these pin is the COUPLING, since that is the whole change: the constants above are still
 * the starter saber's, so a suite that only exercised `kick('melee')` with no shape would pass
 * identically before and after the pass. Every case here therefore either compares two DIFFERENT
 * weapons or walks the real roster.
 */
/**
 * The GUN's half of the same rule (2026-09-02, asked in the same breath as the melee amplitude:
 * *"then take a look at optimising the firing motion too"*).
 *
 * What these pin is again the COUPLING, and one outright defect the old single envelope carried:
 * at 150 ms against the repeater's and flamer's 100 ms cadence, a held trigger restarted the
 * kick before it could return, so those guns sat permanently displaced for the whole burst. The
 * constants are still the blaster's, so a suite that only exercised `kick('ranged')` with no
 * shape would pass identically before and after — every case here therefore either compares two
 * DIFFERENT weapons or walks the real roster.
 */
/** The shipped roster, split by kind, plus the two conversions `controllers/attackShapes.ts`
 *  does at the read site. Module scope because three describes below walk them. */
const ranged = Object.entries(WEAPON_SIM_BY_ID)
  .filter((entry): entry is [string, RangedSimSpec] => entry[1].kind === 'ranged');
const melee = Object.entries(WEAPON_SIM_BY_ID)
  .filter((entry): entry is [string, MeleeSimSpec] => entry[1].kind === 'melee');
const shotOf = (spec: RangedSimSpec): ShotShape => ({
  intervalMs: (spec.fireRateTicks * 1000) / TICK_RATE,
  punch: spec.damage * spec.bullets,
});
const shapeOf = (spec: MeleeSimSpec): SwingShape => ({
  arcDeg: (spec.arcHalf * 720) / 65536,
  windowMs: (spec.swingTicks * 1000) / TICK_RATE,
  recoveryMs: (spec.swingCooldownTicks * 1000) / TICK_RATE,
  knockback: (spec.knockback / 1000) * TICK_RATE,
});
const recoveryOf = (spec: MeleeSimSpec): number => (spec.swingCooldownTicks * 1000) / TICK_RATE;

describe('recoilSchedule — the gun sizes and paces the kick', () => {

  it('reproduces the hand-tuned blaster recoil exactly, since that is the shape it IS', () => {
    // `RECOIL_SHARE` is defined as the ratio between the blaster's cadence and these constants,
    // so this is not a coincidence to be re-derived — it is the property that makes the whole
    // derivation a no-op for the starter weapon, and therefore for every fallback path.
    const s = recoilSchedule(DEFAULT_SHOT);
    expect(s.totalMs).toBeCloseTo(RECOIL_MS, 6);
    expect(s.modulePx).toBeCloseTo(RECOIL_MODULE_PX, 6);
    expect(s.bodyPx).toBeCloseTo(RECOIL_BODY_PX, 6);
    expect(s.climbDeg).toBeCloseTo(-RECOIL_CLIMB_DEG, 6);
    expect(recoilSchedule()).toEqual(s); // and no shape at all is the same weapon
  });

  it('is the blaster that DEFAULT_SHOT describes, not a hand-typed pair of numbers', () => {
    const blaster = WEAPON_SIM_BY_ID.blaster as RangedSimSpec;
    expect(shotOf(blaster)).toEqual(DEFAULT_SHOT);
    expect(blaster.fireRateTicks).toBe(6); // the cadence the constant above encodes
  });

  it('fits the envelope inside the cadence of every gun that fires faster than the blaster', () => {
    // The defect. A recoil longer than the interval can never return: the next shot restarts it
    // mid-kick, so the gun is displaced for the whole of a held trigger and snaps home on
    // release. The repeater and the flamer (3 ticks, 100 ms) are the roster's binding case, and
    // under the old fixed 150 ms they failed this outright.
    for (const [id, spec] of ranged) {
      const shot = shotOf(spec);
      if (shot.intervalMs >= RECOIL_MS) continue; // covered by the roster case below
      expect(recoilSchedule(shot).totalMs, id).toBeLessThan(shot.intervalMs);
    }
    expect(recoilSchedule({ intervalMs: 100, punch: 1 }).totalMs).toBeLessThan(100);
    expect(RECOIL_MS).toBeGreaterThan(100); // ...which the constant it replaced was not
  });

  it('never lets the envelope outrun the cadence by more than the floor allows', () => {
    // The one clamp that CAN push past the interval, and only for a weapon faster than anything
    // authored: a hypothetical 1-tick gun. Bounded, and pinned so the bound is visible.
    for (const [id, spec] of ranged) {
      const shot = shotOf(spec);
      expect(recoilSchedule(shot).totalMs, id).toBeLessThanOrEqual(shot.intervalMs);
    }
    expect(recoilSchedule({ intervalMs: 33, punch: 1 }).totalMs).toBeLessThanOrEqual(70);
  });

  it('gives a slow gun a longer settle than a fast one, in the same order as the specs', () => {
    const length = (id: string): number =>
      recoilSchedule(shotOf(WEAPON_SIM_BY_ID[id] as RangedSimSpec)).totalMs;
    expect(length('flamer')).toBeLessThan(length('blaster')); // 3 ticks vs 6
    expect(length('blaster')).toBeLessThan(length('teslagun')); // 6 vs 11
    expect(length('teslagun')).toBeLessThan(length('cannon')); // 11 vs 18
  });

  it('caps the settle, so a 1.5 s weapon does not lean away from a shot that already left', () => {
    // Everything from the cannon up pins at the ceiling, which is the intent: past a point a
    // slower weapon should keep the heaviest recoil rather than keep getting a slower one.
    const gun = shotOf(ENEMY_GUN_SIM);
    const enemygun = recoilSchedule(gun);
    const mortar = recoilSchedule(shotOf(WEAPON_SIM_BY_ID.mortar as RangedSimSpec));
    expect(enemygun.totalMs).toBeCloseTo(mortar.totalMs, 6); // both pinned at the ceiling
    // Well under what the share alone would give — that is the cap doing the work, not tuning.
    expect(enemygun.totalMs).toBeLessThan(gun.intervalMs * 0.5);
    // ...and the cap must leave the derivation LIVE across the roster's fast half, which is the
    // thing a ceiling set too low silently undoes: at the first cut (260 ms) thirteen of the
    // eighteen guns derived one identical envelope — the defect this file exists to fix, moved
    // rather than removed. Counting DISTINCT lengths is the measurement that catches that, and
    // it catches the pre-2026-09-02 state too, where the answer was 1 for the whole roster.
    const lengths = new Set(ranged.map(([, spec]) => recoilSchedule(shotOf(spec)).totalMs));
    expect(lengths.size).toBeGreaterThanOrEqual(6);
    // The pin is the slow HALF sharing one settle, not the middle of the roster: every weapon
    // that reaches the ceiling is authored at half a second or slower.
    for (const [id, spec] of ranged) {
      const shot = shotOf(spec);
      if (recoilSchedule(shot).totalMs >= enemygun.totalMs) {
        expect(shot.intervalMs, id).toBeGreaterThan(500);
      }
    }
  });

  it('kicks a hard-hitting gun further than a chip-damage one, on all three channels', () => {
    const cannon = recoilSchedule(shotOf(WEAPON_SIM_BY_ID.cannon as RangedSimSpec)); // 3 dmg
    const blaster = recoilSchedule(DEFAULT_SHOT); // 1 dmg
    expect(cannon.modulePx).toBeGreaterThan(blaster.modulePx);
    expect(cannon.bodyPx).toBeGreaterThan(blaster.bodyPx);
    expect(cannon.climbDeg).toBeLessThan(blaster.climbDeg); // negative = up, so further up
    // One curve, three magnitudes: the ratios between the channels are the tuned constants and
    // must not drift apart per weapon.
    expect(cannon.modulePx / cannon.bodyPx).toBeCloseTo(RECOIL_MODULE_PX / RECOIL_BODY_PX, 6);
  });

  it('measures the punch per TRIGGER PULL, so a pellet spread kicks like a slug', () => {
    // The scattergun emits one `bullet_fired` per pellet, so a per-BULLET punch would make the
    // shotgun the softest gun in the game. Five 1-damage pellets, not five blasters.
    const scatter = recoilSchedule(shotOf(WEAPON_SIM_BY_ID.scattergun as RangedSimSpec));
    const cannon = recoilSchedule(shotOf(WEAPON_SIM_BY_ID.cannon as RangedSimSpec));
    expect(scatter.modulePx).toBeGreaterThan(cannon.modulePx);
  });

  it('bounds the magnitude — a ten-bullet ring does not throw the gun off its mount', () => {
    // Sub-linear then clamped: `punch` spans 10x across the roster and these are offsets in
    // authoring px. The novaburst is also a RADIAL volley, so there is no single direction it
    // could honestly be shoved away from in the first place.
    expect(kickOf(1)).toBe(1);
    expect(kickOf(4)).toBeCloseTo(2, 6); // the square root, before the clamp
    expect(kickOf(10)).toBeLessThan(3); // ...and the clamp, well under the linear 10x
    const nova = recoilSchedule(shotOf(WEAPON_SIM_BY_ID.novaburst as RangedSimSpec));
    expect(nova.modulePx).toBeLessThanOrEqual(RECOIL_MODULE_PX * 2.2);
  });

  it('falls back to the blaster for a malformed or missing shape', () => {
    // A shooter already gone from the state on the frame its own event is drained.
    const ref = recoilSchedule(DEFAULT_SHOT);
    for (const bad of [0, -5, Number.NaN]) {
      expect(recoilSchedule({ intervalMs: bad, punch: 1 }).totalMs).toBeCloseTo(ref.totalMs, 6);
      expect(recoilSchedule({ intervalMs: 200, punch: bad }).modulePx).toBeCloseTo(ref.modulePx, 6);
    }
  });
});

describe('AttackMotion, ranged — driven by the gun that fired', () => {
  const peak = (shot?: ShotShape): AttackMotion => {
    const m = new AttackMotion();
    m.kick('ranged', shot);
    m.advance(recoilSchedule(shot).totalMs * 0.22); // RECOIL_ATTACK, the top of the kick
    return m;
  };

  it('climbs the muzzle as well as sliding it back — the half a player can always see', () => {
    // The slide is foreshortened to nothing when firing toward or away from the camera, which is
    // half of all aim angles; the rotation is visible at every one of them. Negative is up, the
    // same sign convention the melee wind-up uses for "back and above the aim line".
    expect(peak().weaponDeg).toBeCloseTo(-RECOIL_CLIMB_DEG, 6);
    const rest = new AttackMotion();
    rest.kick('ranged');
    expect(rest.weaponDeg).toBe(0); // nothing on the trigger frame...
    rest.advance(RECOIL_MS);
    expect(rest.weaponDeg).toBe(0); // ...and nothing left once it settles
  });

  it('scales all three channels off the gun, from one trigger', () => {
    const heavy: ShotShape = { intervalMs: 600, punch: 3 };
    expect(peak(heavy).modulePx).toBeGreaterThan(peak().modulePx);
    expect(peak(heavy).bodyPx).toBeGreaterThan(peak().bodyPx);
    expect(peak(heavy).weaponDeg).toBeLessThan(peak().weaponDeg); // further UP
  });

  it('a gun swap between shots re-derives the envelope rather than keeping the last one', () => {
    const m = new AttackMotion();
    m.kick('ranged', { intervalMs: 600, punch: 3 });
    m.advance(recoilSchedule({ intervalMs: 600, punch: 3 }).totalMs * 0.22);
    const heavy = m.modulePx;
    m.kick('ranged', DEFAULT_SHOT);
    m.advance(RECOIL_MS * 0.22);
    expect(m.modulePx).toBeLessThan(heavy);
    expect(m.modulePx).toBeCloseTo(RECOIL_MODULE_PX, 6);
  });

  it('reports no swing while a shot is in flight, and settles every channel to exactly rest', () => {
    const m = peak({ intervalMs: 900, punch: 5 });
    expect(m.weaponDeg).not.toBe(0);
    m.advance(recoilSchedule({ intervalMs: 900, punch: 5 }).totalMs);
    expect(m.weaponDeg).toBe(0);
    expect(m.modulePx).toBe(0);
    expect(m.bodyPx).toBe(0);
    expect(m.amount).toBe(0);
  });
});

describe('swingSchedule — the weapon sizes and paces the swing', () => {
  const travelOf = (shape: SwingShape): number => {
    const s = swingSchedule(shape);
    return s.strikeDeg - s.windupDeg;
  };

  it('reproduces the hand-tuned SWEEP exactly for the shape it was tuned against', () => {
    // The saber IS `DEFAULT_SWING` and `SWEEP_PER_ARC_DEG` is defined as the ratio between it
    // and these constants — so this is not a coincidence to be re-derived, it is the property
    // that makes the derivation a no-op for the starter weapon's TRAVEL. A drifted factor shows
    // up here before it shows up on screen.
    const s = swingSchedule(DEFAULT_SWING);
    expect(s.windupDeg).toBeCloseTo(SWING_WINDUP_DEG, 6);
    expect(s.strikeDeg).toBeCloseTo(SWING_ARC_DEG, 6);
  });

  it('anchors the STRIKE on the hit window and the TAIL on the recovery — two segments, two inputs', () => {
    // The shape of the whole derivation, stated once. ENGINE_VERSION 53 put `strikeEndMs` on the
    // window (the ticks `HitResolveSystem` can connect on) and that half is unchanged; the
    // 2026-09-02 pass put the FOLLOW-THROUGH on the recovery, which the window cannot express —
    // it is 30-36% of the recovery across the roster, so no constant stands in for it.
    const s = swingSchedule(DEFAULT_SWING);
    expect(s.strikeEndMs).toBeCloseTo(DEFAULT_SWING.windowMs, 6);
    expect(s.totalMs).toBeGreaterThan(s.strikeEndMs);

    // Move ONLY the recovery: the strike is untouched, the envelope grows by the tail alone.
    const slowTail = swingSchedule(swing({ recoveryMs: DEFAULT_SWING.recoveryMs * 2 }));
    expect(slowTail.strikeEndMs).toBeCloseTo(s.strikeEndMs, 6);
    expect(slowTail.strikeStartMs).toBeCloseTo(s.strikeStartMs, 6);
    expect(slowTail.totalMs).toBeGreaterThan(s.totalMs);

    // Move ONLY the window: both strike marks move, and so does the total.
    const slowStrike = swingSchedule(swing({ windowMs: DEFAULT_SWING.windowMs * 2 }));
    expect(slowStrike.strikeEndMs).toBeCloseTo(s.strikeEndMs * 2, 6);
    expect(slowStrike.totalMs).toBeGreaterThan(s.totalMs);
  });

  it('leaves the saber byte-identical — this pass moved the roster, not the reference', () => {
    // `FOLLOW_SHARE` is DEFINED as the value reproducing the pre-2026-09-02 saber tail, so the
    // starter weapon's envelope has to come out at exactly the number the old one-input
    // derivation gave (`windowMs / SWING_STRIKE`). If this drifts, every "unchanged for the
    // starter weapon" claim in the suite quietly stops being true — including the fraction-based
    // sampling the whole first melee block above does.
    const s = swingSchedule(DEFAULT_SWING);
    expect(s.totalMs).toBeCloseTo(DEFAULT_SWING.windowMs / SWING_STRIKE, 6);
    expect(s.totalMs).toBeCloseTo(242.42, 1);
    expect(s.strikeStartMs / s.totalMs).toBeCloseTo(0.3, 6);
    expect(s.strikeEndMs / s.totalMs).toBeCloseTo(SWING_STRIKE, 6);
    expect(s.thrustPx).toBe(0); // and the saber sweeps, it does not stab
    expect(s.lungePx).toBeCloseTo(SWING_LUNGE_PX, 6);
  });

  it('is the saber that DEFAULT_SWING describes, not four hand-typed numbers', () => {
    // If the saber were retuned in the engine and this constant were not, every "unchanged for
    // the starter weapon" claim above would quietly stop being true.
    const saber = WEAPON_SIM_BY_ID.saber as MeleeSimSpec;
    expect(shapeOf(saber).arcDeg).toBeCloseTo(DEFAULT_SWING.arcDeg, 1);
    expect(shapeOf(saber).windowMs).toBeCloseTo(DEFAULT_SWING.windowMs, 6);
    expect(shapeOf(saber).recoveryMs).toBeCloseTo(DEFAULT_SWING.recoveryMs, 6);
    // Within the sim's own truncation: `toFpPerTick(6)` is 198, which reads back as 5.94. The
    // ONE input on which the reference does not reproduce to the bit — see `SwingShape`.
    expect(shapeOf(saber).knockback).toBeCloseTo(DEFAULT_SWING.knockback, 0.5);
    expect(saber.swingTicks).toBe(4); // the window the constant above encodes
    expect(saber.swingCooldownTicks).toBe(11); // ...and the recovery
  });

  it('defaults to that shape when the caller has no weapon to hand', () => {
    // The Graphics placeholder and every enemy (none of which carry a melee weapon — see
    // `EventReactor.meleeSwinger`) reach this path on every swing.
    expect(swingSchedule()).toEqual(swingSchedule(DEFAULT_SWING));
  });

  it('gives a wide weapon a wider sweep than a narrow one, in the same order as the specs', () => {
    // The spear (60°) and the hammer (220°) are the roster's extremes and used to draw the
    // IDENTICAL 68° sweep. Ordering, not exact values: the two clamps below are what bound this.
    const sweep = (arcDeg: number): number => travelOf(swing({ arcDeg }));
    expect(sweep(60)).toBeLessThan(sweep(140));
    expect(sweep(140)).toBeLessThan(sweep(220));
    expect(sweep(220) / sweep(60)).toBeGreaterThan(2);
  });

  it('gives a longer-windowed weapon a longer envelope than a shorter-windowed one', () => {
    // The STRIKE axis, held apart from the tail axis by fixing the recovery on both sides.
    expect(swingSchedule(swing({ windowMs: 100 })).totalMs)
      .toBeLessThan(swingSchedule(swing({ windowMs: 200 })).totalMs);
  });

  it('gives a slower-recovering weapon a longer envelope at the SAME hit window', () => {
    // The tail axis, and the whole 2026-09-02 change: two weapons that can hit for identical
    // ticks but recover at different speeds must not look alike, which is what one input could
    // not express. The stormglaive and the leech are the roster's own instance of the ratio
    // moving — pinned as a real pair below, in `walks the roster on BOTH axes`.
    expect(swingSchedule(swing({ recoveryMs: 300 })).totalMs)
      .toBeLessThan(swingSchedule(swing({ recoveryMs: 600 })).totalMs);
  });

  it('walks the roster on BOTH axes — a window-only or recovery-only derivation fails here', () => {
    // The regression guard for a silent collapse back to ONE input, in either direction, using
    // real roster weapons whose two numbers disagree.
    const frost = WEAPON_SIM_BY_ID.frostbrand as MeleeSimSpec;
    const storm = WEAPON_SIM_BY_ID.stormglaive as MeleeSimSpec;
    expect([frost.swingTicks, storm.swingTicks]).toEqual([5, 4]);
    expect([frost.swingCooldownTicks, storm.swingCooldownTicks]).toEqual([14, 12]);

    const f = swingSchedule(shapeOf(frost));
    const t = swingSchedule(shapeOf(storm));
    // The STRIKE is the window and nothing else: 5 ticks against 4, exactly 1.25x.
    expect(f.strikeEndMs / t.strikeEndMs).toBeCloseTo(5 / 4, 6);
    // The TOTAL is neither ratio, because it is the sum of two differently-scaled segments —
    // which is precisely what a one-input derivation cannot produce.
    const total = f.totalMs / t.totalMs;
    expect(total).not.toBeCloseTo(5 / 4, 2); // not window-only
    expect(total).not.toBeCloseTo(14 / 12, 2); // not recovery-only
    expect(total).toBeGreaterThan(1); // ...and still ordered, since both of its inputs are
  });

  it('spreads the roster wider than the window alone could, and in recovery order', () => {
    // The ASK (2026-09-02): a heavy weapon and a light one should not read alike. The spear and
    // the hammer are the extremes on both axes, so the claim is about the SIZE of the gap: by
    // window alone their envelopes differ 2.0x, and the cadence the player actually feels
    // differs 2.22x. Deriving the tail from the recovery closes most of that.
    const spear = swingSchedule(shapeOf(WEAPON_SIM_BY_ID.spear as MeleeSimSpec));
    const hammer = swingSchedule(shapeOf(WEAPON_SIM_BY_ID.hammer as MeleeSimSpec));
    const windowOnly = hammer.strikeEndMs / spear.strikeEndMs; // 200/100 = 2.0
    expect(hammer.totalMs / spear.totalMs).toBeGreaterThan(windowOnly);
    // And the follow-through itself, which is the part a player reads as weight: the hammer is
    // still recovering more than twice as long after its strike lands.
    const tail = (x: typeof spear): number => x.totalMs - x.strikeEndMs;
    expect(tail(hammer) / tail(spear)).toBeGreaterThan(2);
  });

  it('keeps the wind-up behind the aim and the strike ahead of it, at every arc in the roster', () => {
    // The sign split IS the swing (`rigAttackMotion`'s three phases). A derived sweep that put
    // both ends on the same side would read as the blade snapping to an angle.
    for (const [id, spec] of melee) {
      const s = swingSchedule(shapeOf(spec));
      expect(s.windupDeg, id).toBeLessThan(0);
      expect(s.strikeDeg, id).toBeGreaterThan(0);
      expect(Math.abs(s.windupDeg), id).toBeLessThan(s.strikeDeg); // it leads more than it cocks
    }
  });

  it('fits every roster weapon inside that weapon own recovery', () => {
    // The property the hardcoded 260 ms had against the saber alone, owed to the whole roster:
    // an envelope longer than the recovery is restarted mid-arc by a held trigger, and the blade
    // never returns to the aim line.
    for (const [id, spec] of melee) {
      expect(swingSchedule(shapeOf(spec)).totalMs, id).toBeLessThanOrEqual(recoveryOf(spec));
    }
    // Owed for a STRUCTURAL reason now that the recovery is itself the input: the tail is
    // `(recovery - window) * FOLLOW_SHARE` with the share under 1, so
    // `window + (recovery - window)*s <= recovery` for every `window <= recovery` — which
    // design/07 guarantees, since `toSimSpec` clamps `swingTicks` into [1, cooldown]. No tuned
    // millisecond ceiling is holding this line, which is why the case below can push an absurd
    // shape through it and still expect the property to hold.
    expect(swingSchedule(swing({ windowMs: 1000, recoveryMs: 1001 })).totalMs)
      .toBeLessThanOrEqual(1001 * 1.25); // the only overshoot possible is the tail's own floor
    expect(melee.length).toBeGreaterThanOrEqual(7); // and the sweep above ran over a real roster
  });

  it('bounds the derived travel — a 360° weapon stays on the body, a 20° one stops sweeping', () => {
    // The upper clamp exists because the blade hangs off an aim-tracking socket: past ~100° it
    // swings through the body. The SECTOR fx is unclamped (`game/fx/slashArc.ts`) — this bound is
    // about how the body moves, not about how far the weapon reaches.
    expect(travelOf(swing({ arcDeg: 360 }))).toBeCloseTo(104, 6);
    // The LOWER clamp is still 26°, but a sector that narrow is now a thrust, so what survives of
    // the rotation is 40% of it (`THRUST_SWEEP_TRADE`) — the line-up, not a sweep.
    expect(travelOf(swing({ arcDeg: 20 }))).toBeCloseTo(26 * 0.4, 6);
    // Far guard on the tail, for a weapon authored at an absurd `cooldownSec`.
    expect(swingSchedule(swing({ recoveryMs: 60_000 })).totalMs)
      .toBeCloseTo(DEFAULT_SWING.windowMs + 400, 6);
  });

  it('falls back to the saber field by field, so one bad number cannot freeze the blade', () => {
    // A non-positive or NaN input takes the saber's own value for THAT field rather than
    // poisoning the whole schedule — an `Infinity` reaching `swingRotationDeg`'s denominators
    // would leave the blade frozen mid-air forever, and a zero would divide by zero.
    const ref = swingSchedule(DEFAULT_SWING);
    for (const bad of [0, -5, Number.NaN]) {
      expect(swingSchedule(swing({ windowMs: bad })).totalMs).toBeCloseTo(ref.totalMs, 6);
      expect(swingSchedule(swing({ arcDeg: bad })).strikeDeg).toBeCloseTo(ref.strikeDeg, 6);
      expect(swingSchedule(swing({ knockback: bad })).lungePx).toBeCloseTo(ref.lungePx, 6);
      // A recovery under the window is not a shape `toSimSpec` can author; it floors at the
      // window, which yields the tail's own minimum rather than a negative one.
      expect(swingSchedule(swing({ recoveryMs: bad })).totalMs).toBeGreaterThan(DEFAULT_SWING.windowMs);
    }
  });

  it('turns a narrow sector into a THRUST, because a 60° stab is not an arc', () => {
    // The spear: the roster's narrowest sector (60°) and its longest reach (2.1 grid). Its
    // derived sweep hit the 26° floor, so it drew a small swing of a sector that is not one —
    // and the motion said nothing about the reach. It now drives the module down its own barrel
    // instead, through the same channel the gun's recoil uses with the sign reversed.
    const spear = swingSchedule(shapeOf(WEAPON_SIM_BY_ID.spear as MeleeSimSpec));
    expect(spear.thrustPx).toBeCloseTo(SWING_THRUST_PX, 6); // a pure thrust at exactly 60°
    expect(spear.strikeDeg).toBeLessThan(swingSchedule(DEFAULT_SWING).strikeDeg);
    // Wide weapons keep the rotation-only motion the constants were tuned for.
    for (const id of ['saber', 'emberblade', 'frostbrand', 'stormglaive', 'hammer']) {
      expect(swingSchedule(shapeOf(WEAPON_SIM_BY_ID[id] as MeleeSimSpec)).thrustPx, id).toBe(0);
    }
    // ...and the trade is continuous through the middle of the range, not a two-state switch:
    // the leech's 140° is mostly a sweep with a little drive behind it.
    const leech = swingSchedule(shapeOf(WEAPON_SIM_BY_ID.leech as MeleeSimSpec));
    expect(leech.thrustPx).toBeGreaterThan(0);
    expect(leech.thrustPx).toBeLessThan(spear.thrustPx / 4);
  });

  it('commits the body in proportion to the shove the swing delivers', () => {
    // The AMPLITUDE half of the ask (2026-09-02). `knockback` is the only field in the sim that
    // says how hard a swing hits, so a hammer that shoves twice as hard as a saber leans into it
    // — where before every weapon in the roster lunged the identical 5 px.
    const lunge = (id: string): number =>
      swingSchedule(shapeOf(WEAPON_SIM_BY_ID[id] as MeleeSimSpec)).lungePx;
    // To within the sim's fp truncation on `knockback` (~1%, see `SwingShape`) — which is why
    // the exact form of the claim is pinned on `heftOf` at the bottom of this case instead.
    expect(lunge('saber')).toBeCloseTo(SWING_LUNGE_PX, 1); // the reference, unmoved
    expect(lunge('hammer')).toBeCloseTo(SWING_LUNGE_PX * Math.sqrt(2), 1); // 12 vs 6 grid/s
    expect(lunge('leech')).toBeLessThan(lunge('spear')); // 3 vs 4 grid/s, the roster's lightest
    expect(lunge('hammer') / lunge('leech')).toBeGreaterThan(1.9);
    // Sub-linear on purpose: `knockback` spans 4x and this is a body offset in authoring px.
    expect(heftOf(DEFAULT_SWING.knockback * 4)).toBeLessThan(4);
    expect(heftOf(DEFAULT_SWING.knockback)).toBe(1);
  });

  it('schedules the strike window inside the envelope, in order', () => {
    // The sector fx schedules itself off these two (`EventReactor.slashSector`), so an inverted
    // or out-of-range pair would put the arc on screen before the wind-up or after the recovery.
    const shapes = [DEFAULT_SWING, swing({ arcDeg: 60, windowMs: 100 }), swing({ arcDeg: 220, windowMs: 200 })];
    for (const shape of shapes) {
      const s = swingSchedule(shape);
      expect(s.strikeStartMs).toBeGreaterThan(0);
      expect(s.strikeEndMs).toBeGreaterThan(s.strikeStartMs);
      expect(s.strikeEndMs).toBeLessThan(s.totalMs);
    }
  });
});

describe('AttackMotion, melee — driven by the weapon that swung', () => {
  /** Sampled at the schedule's OWN phase marks rather than at fractions of the total: the two
   *  segments are sized from different inputs now, so 30%/55% is the saber's split and not every
   *  weapon's. `strikeStartMs`/`strikeEndMs` are exact for all of them. */
  const sweepOf = (shape?: SwingShape): { windup: number; strike: number } => {
    const s = swingSchedule(shape); // `shape` undefined -> DEFAULT_SWING
    const cock = new AttackMotion();
    cock.kick('melee', shape);
    cock.advance(s.strikeStartMs);
    const strike = new AttackMotion();
    strike.kick('melee', shape);
    strike.advance(s.strikeEndMs);
    return { windup: cock.weaponDeg, strike: strike.weaponDeg };
  };

  it('sweeps a 220° weapon visibly further than a 60° one — one trigger, a different blade', () => {
    const poke = sweepOf(swing({ arcDeg: 60 }));
    const heave = sweepOf(swing({ arcDeg: 220 }));
    expect(heave.strike).toBeGreaterThan(poke.strike);
    expect(heave.windup).toBeLessThan(poke.windup); // and cocks further back too
  });

  it('an omitted shape sweeps exactly as the pre-2026-09-02 envelope did', () => {
    // Which is what keeps every ranged/placeholder/enemy path in this file honest: those callers
    // pass no shape at all, and their look must not have changed. Still exact after
    // ENGINE_VERSION 53 moved the TIMING onto the hit window, because `sweepOf` samples at
    // fractions of whichever total the schedule chose — the degrees are a function of the arc,
    // and the fallback arc is still the saber's. The fallback's LENGTH did move (260 -> ~242 ms),
    // which is pinned next door in `times the saber off its real 4-tick hit window`.
    const bare = sweepOf();
    expect(bare.windup).toBeCloseTo(SWING_WINDUP_DEG, 6);
    expect(bare.strike).toBeCloseTo(SWING_ARC_DEG, 6);
  });

  it('paces itself by the weapon own numbers, not by one constant', () => {
    // A slow weapon reaching its strike at the same MILLISECOND as a fast one would read as
    // every weapon having the same speed with different art. Both inputs are exercised: a longer
    // window alone, and a longer recovery alone, each has to outlast a whole saber swing.
    for (const shape of [swing({ windowMs: 200 }), swing({ recoveryMs: 900 })]) {
      const slow = new AttackMotion();
      slow.kick('melee', shape);
      slow.advance(DEFAULT_TOTAL_MS); // past a whole saber swing...
      expect(slow.weaponDeg).not.toBe(0); // ...and this one is still mid-arc
    }
  });

  it('drives a narrow weapon module forward and pulls it back first, on one profile', () => {
    // The thrust reaching the getter `RigSkin` actually reads. Negative is FORWARD along the
    // barrel (the gun's recoil is the positive direction), and it shares the lunge's profile, so
    // the wind-up pulls the point back before the stab rather than starting from a dead stop.
    const spear = swing({ arcDeg: 60 });
    const s = swingSchedule(spear);
    const at = (ms: number): AttackMotion => {
      const m = new AttackMotion();
      m.kick('melee', spear);
      m.advance(ms);
      return m;
    };
    expect(at(s.strikeStartMs).modulePx).toBeGreaterThan(0); // drawn back through the wind-up
    expect(at(s.strikeEndMs).modulePx).toBeCloseTo(-SWING_THRUST_PX, 6); // driven out at the strike
    expect(at(s.totalMs).modulePx).toBe(0); // and home again
    // The body goes with it — one motion, not a module sliding out of a stationary character.
    expect(at(s.strikeEndMs).bodyPx).toBeLessThan(0);
  });

  it('lunges a heavy weapon further than a light one, from the same trigger', () => {
    const lungeAt = (shape: SwingShape): number => {
      const m = new AttackMotion();
      m.kick('melee', shape);
      m.advance(swingSchedule(shape).strikeEndMs);
      return -m.bodyPx; // signed toward the aim; magnitude is what is being compared
    };
    expect(lungeAt(swing({ knockback: 12 }))).toBeGreaterThan(lungeAt(swing({ knockback: 3 })) * 1.9);
    expect(lungeAt(DEFAULT_SWING)).toBeCloseTo(SWING_LUNGE_PX, 6);
  });

  it('a weapon swap between swings re-derives the shape rather than keeping the last one', () => {
    // `kick` is the only place the shape enters, and a held trigger through a swap is exactly how
    // a stale schedule would survive — the blade would keep sweeping the old weapon's size.
    const wideShape = swing({ arcDeg: 220 });
    const narrowShape = swing({ arcDeg: 60 });
    const m = new AttackMotion();
    m.kick('melee', wideShape);
    m.advance(swingSchedule(wideShape).totalMs * 0.55);
    const wide = m.weaponDeg;
    m.kick('melee', narrowShape);
    m.advance(swingSchedule(narrowShape).totalMs * 0.55);
    expect(m.weaponDeg).toBeLessThan(wide);
  });

  it('still starts and ends on the aim line for any weapon in the roster', () => {
    // The invariant the original melee block opens with, re-checked across the whole derived
    // range: a swing that settled anywhere but 0 leaves that weapon permanently off its aim.
    for (const arcDeg of [20, 60, 162, 220, 360]) {
      const shape = swing({ arcDeg });
      const m = new AttackMotion();
      m.kick('melee', shape);
      expect(m.weaponDeg).toBe(0);
      expect(m.modulePx).toBe(0);
      m.advance(swingSchedule(shape).totalMs);
      expect(m.weaponDeg).toBe(0);
      expect(m.bodyPx).toBe(0);
      expect(m.modulePx).toBe(0); // the thrust settles back onto its mount too
    }
  });
});

/**
 * The end-to-end version of the property both derivations are BUILT on, driven through the
 * clock rather than read off the schedule: **at every weapon's own real cadence, the envelope is
 * back at exact rest before the next attack restarts it.**
 *
 * Worth its own block because it is the shape of the one outright DEFECT this pass fixed, and the
 * schedule-level cases next door cannot see it. Those compare `totalMs` against `intervalMs` —
 * two numbers. This steps `advance()` in real frame-sized chunks and reads the four public
 * getters, which is where "the gun sat permanently displaced for a whole held trigger" actually
 * showed: `modulePx` never reaching 0 again is a property of the CLOCK, not of the schedule.
 *
 * The frame size is deliberately 16.67 ms and not a divisor of anything, so no case can pass by
 * landing exactly on a boundary.
 */
describe('AttackMotion — a held trigger settles between attacks, at every roster cadence', () => {
  const FRAME_MS = 16.67;

  /**
   * Run one cadence of frames into a fresh envelope. Reports the four channels at the end, that
   * the envelope MOVED at all (so "at rest" is never vacuously true), and `restMs` — how much of
   * the cadence was left over once it settled.
   *
   * `restMs` is the load-bearing one. "It reached zero by the deadline" is satisfied by an
   * envelope exactly as long as the cadence, which is the degenerate case the source comment
   * rules out in words: a held trigger has to read as DISCRETE attacks with a beat between them,
   * not as one continuous blur that happens to touch rest on its last frame.
   */
  const afterCadence = (kick: (m: AttackMotion) => void, cadenceMs: number) => {
    const m = new AttackMotion();
    kick(m);
    let spent = 0;
    let sawMotion = false;
    let settledAt = -1;
    while (spent < cadenceMs) {
      const dt = Math.min(FRAME_MS, cadenceMs - spent);
      m.advance(dt);
      spent += dt;
      const moving = m.weaponDeg !== 0 || m.modulePx !== 0 || m.bodyPx !== 0 || m.amount !== 0;
      if (moving) { sawMotion = true; settledAt = -1; } else if (sawMotion && settledAt < 0) {
        settledAt = spent;
      }
    }
    return {
      sawMotion, deg: m.weaponDeg, mod: m.modulePx, body: m.bodyPx, amount: m.amount,
      restMs: settledAt < 0 ? 0 : cadenceMs - settledAt,
    };
  };

  it('every RANGED weapon returns to exact rest within its own fire interval', () => {
    // The defect, as a roster sweep. The repeater and the flamer (3 ticks, 100 ms) are the cases
    // that failed before this pass: a 150 ms envelope against a 100 ms cadence never settled.
    for (const [id, spec] of ranged) {
      const shot = shotOf(spec);
      const r = afterCadence(m => m.kick('ranged', shot), shot.intervalMs);
      expect(r.sawMotion, id).toBe(true); // ...and it did move, so "at rest" is not vacuous
      expect(r.mod, id).toBe(0);
      expect(r.body, id).toBe(0);
      expect(r.deg, id).toBe(0);
      expect(r.amount, id).toBe(0);
      expect(r.restMs, id).toBeGreaterThan(0); // ...with a beat left over, not just barely
    }
    expect(ranged.length).toBeGreaterThanOrEqual(17);
  });

  it('every MELEE weapon returns to exact rest within its own recovery', () => {
    for (const [id, spec] of melee) {
      const shape = shapeOf(spec);
      const r = afterCadence(m => m.kick('melee', shape), recoveryOf(spec));
      expect(r.sawMotion, id).toBe(true);
      expect(r.deg, id).toBe(0);
      expect(r.body, id).toBe(0);
      expect(r.mod, id).toBe(0);
      // The beat between swings the envelope's own doc comment promises: a stroke that filled its
      // whole recovery would be restarted on the frame it settled and read as a continuous blur.
      expect(r.restMs, id).toBeGreaterThan(FRAME_MS);
    }
    expect(melee.length).toBeGreaterThanOrEqual(7);
  });

  it('fails for the fastest guns under the FIXED envelope this pass replaced', () => {
    // The control, so the sweep above is not merely passing because everything settles eventually.
    // 150 ms was the old constant for every weapon; the repeater fires every 100.
    const repeater = shotOf(WEAPON_SIM_BY_ID.repeater as RangedSimSpec);
    expect(repeater.intervalMs).toBeCloseTo(100, 6);
    expect(RECOIL_MS).toBeGreaterThan(repeater.intervalMs);
    // A rig kicked with a hand-built shape whose envelope is the OLD constant is still displaced
    // when the next shot lands — i.e. this suite can tell the two states apart.
    const stale = afterCadence(
      m => m.kick('ranged', { intervalMs: RECOIL_MS / 0.75, punch: 1 }), repeater.intervalMs);
    expect(stale.mod).toBeGreaterThan(0);
    expect(afterCadence(m => m.kick('ranged', repeater), repeater.intervalMs).mod).toBe(0);
  });
});
