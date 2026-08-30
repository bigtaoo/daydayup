/**
 * The fire-recoil envelope (`rigRecoil.ts`) — the render-only "this rig just shot" pulse that
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
import { Recoil, RECOIL_MS, RECOIL_MODULE_PX, RECOIL_BODY_PX } from './rigRecoil';

describe('Recoil — the envelope at rest', () => {
  it('is exactly zero before anything fires', () => {
    const r = new Recoil();
    expect(r.amount).toBe(0);
    expect(r.modulePx).toBe(0);
    expect(r.bodyPx).toBe(0);
  });

  it('stays zero however long an un-kicked envelope is advanced', () => {
    const r = new Recoil();
    for (let i = 0; i < 20; i++) r.advance(16);
    expect(r.amount).toBe(0);
  });

  it('returns to exactly zero once the envelope has run out — never a residual offset', () => {
    const r = new Recoil();
    r.kick();
    r.advance(RECOIL_MS);
    expect(r.amount).toBe(0);
    expect(r.modulePx).toBe(0);
    // ...and over-advancing past the end cannot drive it negative (which would push the gun
    // FORWARD out of the barrel rather than leave it alone).
    r.advance(RECOIL_MS * 10);
    expect(r.amount).toBe(0);
  });
});

describe('Recoil — the envelope shape', () => {
  it('kicks out fast and settles back slowly — not a symmetric wobble', () => {
    const r = new Recoil();
    r.kick();
    const at = (elapsed: number): number => {
      const s = new Recoil();
      s.kick();
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
      const r = new Recoil();
      r.kick();
      r.advance(t);
      expect(r.amount).toBeLessThanOrEqual(1 + 1e-9);
      expect(r.amount).toBeGreaterThanOrEqual(0);
    }
  });

  it('scales the module kick and the body lean off the same envelope', () => {
    const r = new Recoil();
    r.kick();
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

describe('Recoil — a shot landing while the last one is still settling', () => {
  it('restarts at full strength rather than accumulating', () => {
    const r = new Recoil();
    r.kick();
    r.advance(RECOIL_MS * 0.8); // mostly settled
    const mid = r.amount;
    expect(mid).toBeGreaterThan(0);
    r.kick();
    expect(r.amount).toBe(0); // back to the very start of the envelope, not stacked on `mid`
    r.advance(RECOIL_MS * 0.22);
    expect(r.amount).toBeCloseTo(1, 6);
  });

  it('is frame-rate independent — the value depends on elapsed time, not on step count', () => {
    const coarse = new Recoil();
    coarse.kick();
    coarse.advance(30);
    const fine = new Recoil();
    fine.kick();
    for (let i = 0; i < 6; i++) fine.advance(5);
    expect(fine.amount).toBeCloseTo(coarse.amount, 12);
  });

  it('tolerates a zero-length frame (the rest-pose layout pass calls it with dt 0)', () => {
    const r = new Recoil();
    r.kick();
    r.advance(0);
    expect(r.amount).toBe(0); // t=0 is the very start of the kick, not the peak
    expect(Number.isFinite(r.modulePx)).toBe(true);
  });
});
