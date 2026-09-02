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
import { WEAPON_SIM_BY_ID, TICK_RATE, type MeleeSimSpec } from '@dd/engine';
import {
  AttackMotion, RECOIL_MS, RECOIL_MODULE_PX, RECOIL_BODY_PX,
  SWING_MS, SWING_STRIKE, SWING_ARC_DEG, SWING_WINDUP_DEG, SWING_LUNGE_PX,
  DEFAULT_SWING, swingSchedule, type SwingShape,
} from './rigAttackMotion';

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
    expect(at(0).swingDeg).toBe(0);
    const spent = at(1);
    expect(spent.swingDeg).toBe(0);
    expect(spent.bodyPx).toBe(0);
    spent.advance(DEFAULT_TOTAL_MS); // and stays there however long it is advanced afterwards
    expect(spent.swingDeg).toBe(0);
  });

  it('cocks BEHIND the aim before it sweeps ahead of it — the wind-up is what sells the swing', () => {
    // Sign matters and is the whole read: a swing that only ever leads the aim looks like the
    // blade snapping to a new angle, not like a character winding up.
    expect(at(0.15).swingDeg).toBeLessThan(0);
    expect(at(0.3).swingDeg).toBeCloseTo(SWING_WINDUP_DEG, 6); // the deepest point of the wind-up
    expect(at(0.55).swingDeg).toBeCloseTo(SWING_ARC_DEG, 6); // and the far end of the strike
    expect(at(0.8).swingDeg).toBeGreaterThan(0); // recovering, still ahead of the aim
  });

  it('sweeps monotonically from the cock to the strike, then monotonically back', () => {
    const sample = (from: number, to: number, n = 24): number[] =>
      Array.from({ length: n + 1 }, (_, i) => at(from + ((to - from) * i) / n).swingDeg);
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

  it('never slides the module along its barrel — a blade rotates, it does not recoil', () => {
    for (const u of [0, 0.2, 0.4, 0.6, 0.8, 1]) expect(at(u).modulePx).toBe(0);
  });

  it('reports no ranged envelope while a swing is in flight, and vice versa', () => {
    // The two read sites are independent, so a kind that leaked into the other`s getter would
    // apply BOTH motions at once — the gun kick and the blade sweep on the same frame.
    expect(at(0.5).amount).toBe(0);
    const shot = new AttackMotion();
    shot.kick('ranged');
    shot.advance(RECOIL_MS * 0.5);
    expect(shot.swingDeg).toBe(0);
  });

  it('a swap mid-motion switches the envelope wholesale rather than blending', () => {
    const m = new AttackMotion();
    m.kick('ranged');
    m.advance(RECOIL_MS * 0.22); // at the recoil peak
    expect(m.modulePx).toBeCloseTo(RECOIL_MODULE_PX, 6);
    m.kick('melee');
    expect(m.modulePx).toBe(0); // the gun kick is gone the same frame
    expect(m.swingDeg).toBe(0); // and the swing starts from its own t=0
    m.advance(DEFAULT_TOTAL_MS * 0.55);
    expect(m.swingDeg).toBeCloseTo(SWING_ARC_DEG, 6);
  });

  it('a swing restarts cleanly when the next one lands mid-recovery', () => {
    const m = new AttackMotion();
    m.kick('melee');
    m.advance(DEFAULT_TOTAL_MS * 0.9);
    expect(m.swingDeg).toBeGreaterThan(0); // still recovering
    m.kick('melee');
    expect(m.swingDeg).toBe(0);
  });

  it('is frame-rate independent, like the recoil', () => {
    const coarse = new AttackMotion();
    coarse.kick('melee');
    coarse.advance(60);
    const fine = new AttackMotion();
    fine.kick('melee');
    for (let i = 0; i < 12; i++) fine.advance(5);
    expect(fine.swingDeg).toBeCloseTo(coarse.swingDeg, 12);
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
    expect(m.swingDeg).toBe(0);
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
    expect(m.swingDeg).toBe(0);
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
    expect(m.swingDeg).toBe(0);
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
describe('swingSchedule — the weapon sizes and paces the swing', () => {
  const melee = Object.entries(WEAPON_SIM_BY_ID)
    .filter((entry): entry is [string, MeleeSimSpec] => entry[1].kind === 'melee');
  /** The same brad→deg / ticks→ms conversion `EventReactor.swingShapeOf` does at the read site. */
  const shapeOf = (spec: MeleeSimSpec): SwingShape => ({
    arcDeg: (spec.arcHalf * 720) / 65536,
    windowMs: (spec.swingTicks * 1000) / TICK_RATE,
  });
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

  it('times the saber off its real 4-tick hit window, which is NOT the 260 ms constant', () => {
    // The one deliberate behaviour change of ENGINE_VERSION 53's render half, stated as its own
    // test so it cannot be mistaken for drift. This file's timing used to derive from
    // `recoveryMs` — the 11-tick gap until you may swing AGAIN — because that was the only
    // number available: `swingSec` was authored but unconverted and the sim had no window at
    // all. It has one now (4 ticks, ~133 ms), and the envelope is anchored so the STRIKE ENDS
    // as the window closes: 133 / 0.55 ≈ 242 ms. `SWING_MS` survives only as the fallback.
    const s = swingSchedule(DEFAULT_SWING);
    expect(s.totalMs).toBeCloseTo(DEFAULT_SWING.windowMs / SWING_STRIKE, 6);
    expect(s.totalMs).toBeCloseTo(242.42, 1);
    expect(s.totalMs).toBeLessThan(SWING_MS); // shorter than the recovery-derived number it replaced
    // …and the anchor itself: at `strikeEndMs` exactly one window has elapsed, so the visible
    // stroke covers precisely the ticks `HitResolveSystem` can connect on.
    expect(s.strikeEndMs).toBeCloseTo(DEFAULT_SWING.windowMs, 6);
  });

  it('is the saber that DEFAULT_SWING describes, not a hand-typed pair of numbers', () => {
    // If the saber were retuned in the engine and this constant were not, every "unchanged for
    // the starter weapon" claim above would quietly stop being true.
    const saber = WEAPON_SIM_BY_ID.saber as MeleeSimSpec;
    expect(shapeOf(saber).arcDeg).toBeCloseTo(DEFAULT_SWING.arcDeg, 1);
    expect(shapeOf(saber).windowMs).toBeCloseTo(DEFAULT_SWING.windowMs, 6);
    expect(saber.swingTicks).toBe(4); // the window the constant above encodes
  });

  it('defaults to that shape when the caller has no weapon to hand', () => {
    // The Graphics placeholder and every enemy (none of which carry a melee weapon — see
    // `EventReactor.meleeSwinger`) reach this path on every swing.
    expect(swingSchedule()).toEqual(swingSchedule(DEFAULT_SWING));
  });

  it('gives a wide weapon a wider sweep than a narrow one, in the same order as the specs', () => {
    // The spear (60°) and the hammer (220°) are the roster's extremes and used to draw the
    // IDENTICAL 68° sweep. Ordering, not exact values: the two clamps below are what bound this.
    const sweep = (arcDeg: number): number => travelOf({ arcDeg, windowMs: DEFAULT_SWING.windowMs });
    expect(sweep(60)).toBeLessThan(sweep(140));
    expect(sweep(140)).toBeLessThan(sweep(220));
    expect(sweep(220) / sweep(60)).toBeGreaterThan(2);
  });

  it('gives a longer-windowed weapon a longer envelope than a shorter-windowed one', () => {
    // Was phrased as slow-vs-fast when the input was the recovery. The input is now the ACTIVE
    // WINDOW, and the two are not proportional across the roster (the spear spends 33% of its
    // recovery active, the frostbrand 36%), so this is a different claim about a different axis.
    expect(swingSchedule({ arcDeg: 162, windowMs: 100 }).totalMs)
      .toBeLessThan(swingSchedule({ arcDeg: 162, windowMs: 200 }).totalMs);
  });

  it('walks the roster in window order, not in recovery order — they disagree', () => {
    // The regression that would hide a silent revert to `recoveryMs`: the hammer has both the
    // longest window AND the longest recovery, so ordering alone cannot tell the two inputs
    // apart. The frostbrand vs the stormglaive can — 5 ticks of window on a 14-tick recovery
    // against 4 on 12 — so their envelope order flips depending on which number is read.
    const frost = WEAPON_SIM_BY_ID.frostbrand as MeleeSimSpec;
    const storm = WEAPON_SIM_BY_ID.stormglaive as MeleeSimSpec;
    expect([frost.swingTicks, storm.swingTicks]).toEqual([5, 4]);
    expect(frost.swingCooldownTicks).toBeGreaterThan(storm.swingCooldownTicks); // 14 > 12
    // Window order (5 > 4) and recovery order (14 > 12) agree in SIGN here, so pin the RATIO:
    // by window it is 5/4 = 1.25x, by recovery it would be 14/12 ≈ 1.167x.
    const ratio = swingSchedule(shapeOf(frost)).totalMs / swingSchedule(shapeOf(storm)).totalMs;
    expect(ratio).toBeCloseTo(5 / 4, 6);
    expect(ratio).not.toBeCloseTo(14 / 12, 2);
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
    // The property the hardcoded 260 ms had against the saber alone, now owed to the whole
    // roster: an envelope longer than the recovery is restarted mid-arc by a held trigger, and
    // the blade never returns to the aim line. The hammer is the binding case (667 ms recovery,
    // which derives 473 ms before the clamp).
    for (const [id, spec] of melee) {
      const recoveryMs = (spec.swingCooldownTicks * 1000) / TICK_RATE;
      expect(swingSchedule(shapeOf(spec)).totalMs, id).toBeLessThanOrEqual(recoveryMs);
    }
    // Still owed, and now owed for a structural reason rather than a tuned one: design/07 clamps
    // every `swingTicks` into [1, swingCooldownTicks], and the envelope is the window over
    // SWING_STRIKE (0.55) — so it can only exceed the recovery for a window past 55% of it,
    // which `toSimSpec` cannot produce. The old `recoveryMs` derivation needed SWING_MAX_MS to
    // hold this line for the hammer; nothing in the roster binds on it any more.
    expect(melee.length).toBeGreaterThanOrEqual(7); // and the sweep above ran over a real roster
  });

  it('bounds the derived travel — a 20° dagger still reads as a swing, a 360° one stays on the body', () => {
    // The clamps exist because the blade hangs off an aim-tracking socket: past ~100° it swings
    // through the body, and under ~26° it is a twitch at the ~13-20 px an actor occupies. The
    // SECTOR fx is unclamped (`game/fx/slashArc.ts`) — this bound is about how the body moves,
    // not about how far the weapon reaches.
    expect(travelOf({ arcDeg: 20, windowMs: DEFAULT_SWING.windowMs })).toBeCloseTo(26, 6);
    expect(travelOf({ arcDeg: 360, windowMs: DEFAULT_SWING.windowMs })).toBeCloseTo(104, 6);
    expect(swingSchedule({ arcDeg: 162, windowMs: 20 }).totalMs).toBeCloseTo(130, 6);
    expect(swingSchedule({ arcDeg: 162, windowMs: 5000 }).totalMs).toBeCloseTo(400, 6);
    // A non-positive or malformed window falls back to the saber's own length rather than
    // dividing — an Infinity here would leave the blade frozen mid-air forever.
    expect(swingSchedule({ arcDeg: 162, windowMs: 0 }).totalMs).toBeCloseTo(SWING_MS, 6);
    expect(swingSchedule({ arcDeg: 162, windowMs: -5 }).totalMs).toBeCloseTo(SWING_MS, 6);
    expect(swingSchedule({ arcDeg: 162, windowMs: Number.NaN }).totalMs).toBeCloseTo(SWING_MS, 6);
  });

  it('schedules the strike window inside the envelope, in order', () => {
    // The sector fx schedules itself off these two (`EventReactor.slashSector`), so an inverted
    // or out-of-range pair would put the arc on screen before the wind-up or after the recovery.
    for (const shape of [DEFAULT_SWING, { arcDeg: 60, windowMs: 100 }, { arcDeg: 220, windowMs: 200 }]) {
      const s = swingSchedule(shape);
      expect(s.strikeStartMs).toBeGreaterThan(0);
      expect(s.strikeEndMs).toBeGreaterThan(s.strikeStartMs);
      expect(s.strikeEndMs).toBeLessThan(s.totalMs);
    }
  });
});

describe('AttackMotion, melee — driven by the weapon that swung', () => {
  const sweepOf = (shape?: SwingShape): { windup: number; strike: number } => {
    const total = swingSchedule(shape).totalMs; // `shape` undefined -> DEFAULT_SWING
    const cock = new AttackMotion();
    cock.kick('melee', shape);
    cock.advance(total * 0.3);
    const strike = new AttackMotion();
    strike.kick('melee', shape);
    strike.advance(total * 0.55);
    return { windup: cock.swingDeg, strike: strike.swingDeg };
  };

  it('sweeps a 220° weapon visibly further than a 60° one — one trigger, a different blade', () => {
    const poke = sweepOf({ arcDeg: 60, windowMs: DEFAULT_SWING.windowMs });
    const heave = sweepOf({ arcDeg: 220, windowMs: DEFAULT_SWING.windowMs });
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

  it('paces itself by the weapon own recovery, not by one constant', () => {
    // A slow weapon reaching its strike at the same MILLISECOND as a fast one would read as
    // every weapon having the same speed with different art.
    const slow = new AttackMotion();
    slow.kick('melee', { arcDeg: 162, windowMs: 200 });
    slow.advance(DEFAULT_TOTAL_MS); // past a whole saber swing...
    expect(slow.swingDeg).not.toBe(0); // ...and this one is still mid-arc
  });

  it('a weapon swap between swings re-derives the shape rather than keeping the last one', () => {
    // `kick` is the only place the shape enters, and a held trigger through a swap is exactly how
    // a stale schedule would survive — the blade would keep sweeping the old weapon's size.
    const wideShape = { arcDeg: 220, windowMs: DEFAULT_SWING.windowMs };
    const narrowShape = { arcDeg: 60, windowMs: DEFAULT_SWING.windowMs };
    const m = new AttackMotion();
    m.kick('melee', wideShape);
    m.advance(swingSchedule(wideShape).totalMs * 0.55);
    const wide = m.swingDeg;
    m.kick('melee', narrowShape);
    m.advance(swingSchedule(narrowShape).totalMs * 0.55);
    expect(m.swingDeg).toBeLessThan(wide);
  });

  it('still starts and ends on the aim line for any weapon in the roster', () => {
    // The invariant the original melee block opens with, re-checked across the whole derived
    // range: a swing that settled anywhere but 0 leaves that weapon permanently off its aim.
    for (const arcDeg of [20, 60, 162, 220, 360]) {
      const shape = { arcDeg, windowMs: DEFAULT_SWING.windowMs };
      const m = new AttackMotion();
      m.kick('melee', shape);
      expect(m.swingDeg).toBe(0);
      m.advance(swingSchedule(shape).totalMs);
      expect(m.swingDeg).toBe(0);
      expect(m.bodyPx).toBe(0);
    }
  });
});
