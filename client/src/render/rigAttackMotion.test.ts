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
  AttackMotion, RECOIL_MS, RECOIL_MODULE_PX, RECOIL_BODY_PX,
  SWING_MS, SWING_ARC_DEG, SWING_WINDUP_DEG, SWING_LUNGE_PX,
} from './rigAttackMotion';

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
    m.advance(SWING_MS * u);
    return m;
  };

  it('starts and ends exactly on the aim line', () => {
    expect(at(0).swingDeg).toBe(0);
    const spent = at(1);
    expect(spent.swingDeg).toBe(0);
    expect(spent.bodyPx).toBe(0);
    spent.advance(SWING_MS); // and stays there however long it is advanced afterwards
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
    m.advance(SWING_MS * 0.55);
    expect(m.swingDeg).toBeCloseTo(SWING_ARC_DEG, 6);
  });

  it('a swing restarts cleanly when the next one lands mid-recovery', () => {
    const m = new AttackMotion();
    m.kick('melee');
    m.advance(SWING_MS * 0.9);
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
    expect(SWING_MS).toBeLessThan((11 * 1000) / 30);
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
    m.advance(SWING_MS * 10);
    expect(m.swingDeg).toBe(0);
    expect(m.bodyPx).toBe(0);
    const r = new AttackMotion();
    r.kick('ranged');
    r.advance(RECOIL_MS * 10);
    expect(r.amount).toBe(0);
  });
});
