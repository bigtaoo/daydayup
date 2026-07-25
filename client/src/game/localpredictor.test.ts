/**
 * LocalPredictor (ROADMAP 3.3 follow-up / design/06 local-player prediction). Pins the
 * render-layer predictor's math headlessly — the properties that matter for feel under
 * latency: at zero lag it tracks the confirmed sim exactly (no visible correction); under
 * lag it LEADS the confirmed position (that lead IS the hidden latency) and CONVERGES back
 * as confirmed catches up; a large gap snaps, a small one eases. No real RTT needed — the
 * lag is simulated by feeding reconcile() an intentionally-stale confirmed position.
 */
import { describe, it, expect } from 'vitest';
import { LocalPredictor, DEFAULT_PREDICTOR } from './LocalPredictor';
import { bradToRad } from './coords';

const SPEED = 192; // px/sec — the real sim value (fpToPx(6.4px/tick) × 30Hz)
const DT = 1000 / 30; // one sim-frame's worth of render time (ms)
const STEP = (SPEED * DT) / 1000; // px advanced per full-magnitude frame = 6.4
const EAST = 0; // brad 0 → +x

const make = (over: Partial<typeof DEFAULT_PREDICTOR> = {}) =>
  new LocalPredictor({ speedPxPerSec: SPEED, ...DEFAULT_PREDICTOR, ...over });

describe('LocalPredictor — prediction', () => {
  it('is inert until reset (no pose drift, ignores predict/reconcile)', () => {
    const p = make();
    expect(p.isActive).toBe(false);
    p.predict(EAST, 255, EAST, DT);
    p.reconcile(500, 500);
    expect(p.pose).toEqual({ x: 0, y: 0, facing: 0 });
  });

  it('dead-reckons at the sim speed and takes facing straight from aim', () => {
    const p = make();
    p.reset(0, 0, 0);
    p.predict(EAST, 255, /*aim=*/ 16384, DT); // quarter turn aim
    expect(p.pose.x).toBeCloseTo(STEP, 5);
    expect(p.pose.y).toBeCloseTo(0, 5);
    expect(p.pose.facing).toBeCloseTo(bradToRad(16384), 5);
  });

  it('scales displacement by move magnitude (half stick → half step, zero → still)', () => {
    const half = make();
    half.reset(0, 0, 0);
    half.predict(EAST, 128, EAST, DT);
    expect(half.pose.x).toBeCloseTo(STEP * (128 / 255), 5);

    const idle = make();
    idle.reset(0, 0, 0);
    idle.predict(EAST, 0, EAST, DT);
    expect(idle.pose.x).toBe(0);
  });
});

describe('LocalPredictor — reconciliation', () => {
  it('at zero lag, predicted tracks confirmed within a sub-pixel epsilon (no visible pop)', () => {
    const p = make();
    p.reset(0, 0, 0);
    let confirmed = 0;
    for (let f = 0; f < 60; f++) {
      p.predict(EAST, 255, EAST, DT); // local input advances predicted
      confirmed += STEP; // confirmed advances in lockstep (no latency)
      p.reconcile(confirmed, 0);
    }
    expect(Math.abs(p.pose.x - confirmed)).toBeLessThan(0.5);
  });

  it('under lag, predicted LEADS the confirmed position (the hidden latency)', () => {
    const K = 6; // confirmed trails 6 frames behind
    const p = make();
    p.reset(0, 0, 0);
    for (let f = 1; f <= 40; f++) {
      p.predict(EAST, 255, EAST, DT);
      const confirmedX = Math.max(0, f - K) * STEP; // stale confirmed
      p.reconcile(confirmedX, 0);
    }
    const confirmedNow = Math.max(0, 40 - K) * STEP;
    expect(p.pose.x).toBeGreaterThan(confirmedNow); // leads the confirmed edge
    expect(p.pose.x).toBeLessThan(40 * STEP + STEP); // but not past the true leading edge
  });

  it('converges to confirmed once input stops (error decays monotonically to ~0)', () => {
    const target = 100;
    const p = make();
    p.reset(target + 40, 0, 0); // a 40px lead built up under lag; input has now stopped
    let prevErr = Infinity;
    for (let f = 0; f < 30; f++) {
      p.predict(EAST, 0, EAST, DT); // input released → no advance
      p.reconcile(target, 0);
      const err = Math.abs(p.pose.x - target);
      expect(err).toBeLessThanOrEqual(prevErr + 1e-9); // never diverges
      prevErr = err;
    }
    expect(prevErr).toBeLessThan(0.1); // settled onto the confirmed position
  });

  it('snaps on a large gap (teleport / room transition), eases on a small one', () => {
    const snap = make();
    snap.reset(0, 0, 0);
    snap.reconcile(1000, 0); // >> snapPx → jump
    expect(snap.pose.x).toBe(1000);

    const ease = make();
    ease.reset(0, 0, 0);
    ease.reconcile(10, 0); // < snapPx → lerp by gain (0.25)
    expect(ease.pose.x).toBeCloseTo(10 * DEFAULT_PREDICTOR.correctionGain, 5);
  });

  it('deactivate() halts prediction so the caller can fall back to confirmed', () => {
    const p = make();
    p.reset(5, 5, 0);
    p.deactivate();
    p.predict(EAST, 255, EAST, DT);
    p.reconcile(999, 999);
    expect(p.pose).toEqual({ x: 5, y: 5, facing: 0 });
    expect(p.isActive).toBe(false);
  });
});
