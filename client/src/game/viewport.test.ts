import { describe, expect, it } from 'vitest';
import type { Application } from 'pixi.js';
import { computeScreenSize } from './viewport';

// A fake shaped exactly like the two properties computeScreenSize touches — no real
// Pixi Application needed (mirrors the fake-`host`/fake-`renderer` pattern used
// throughout this codebase, e.g. GameLoop.test.ts's `screenSize` host stub).
function fakeApp(screenWidth: number, screenHeight: number, resolution: number): Application {
  return {
    renderer: {
      screen: { width: screenWidth, height: screenHeight },
      // Present so a regression that reverts to the old `width / resolution` formula
      // would be caught: `.width`/`.resolution` deliberately DON'T equal `.screen`'s
      // values here, so any accidental reintroduction of resolution math produces a
      // visibly wrong number instead of accidentally matching by coincidence.
      width: screenWidth * resolution,
      resolution,
    },
  } as unknown as Application;
}

describe('computeScreenSize', () => {
  it('returns the renderer\'s logical screen size unchanged at resolution 1', () => {
    expect(computeScreenSize(fakeApp(1280, 720, 1))).toEqual({ w: 1280, h: 720 });
  });

  it('does NOT divide by resolution on a HiDPI display (the 2026-08-12 regression)', () => {
    // Before the fix, screenSize() computed `renderer.width / renderer.resolution`
    // (1920 / 1.5 = 1280 — happens to equal the right answer only because
    // `renderer.width` here is device pixels = screen * resolution; the real Pixi bug
    // was `renderer.width` already being logical, making that division shrink the
    // result to screen/resolution instead of leaving it as screen). The fix reads
    // `renderer.screen` directly, so this must equal the exact logical size
    // regardless of what resolution is set to.
    expect(computeScreenSize(fakeApp(1280, 631.333, 1.5))).toEqual({ w: 1280, h: 631.333 });
  });

  it('is unaffected by resolution 2 (common Retina/high-DPI value)', () => {
    expect(computeScreenSize(fakeApp(1512, 982, 2))).toEqual({ w: 1512, h: 982 });
  });

  it('passes through non-integer logical sizes as-is (e.g. an odd window height)', () => {
    expect(computeScreenSize(fakeApp(853.5, 420.25, 1.5))).toEqual({ w: 853.5, h: 420.25 });
  });
});
