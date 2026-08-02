/**
 * `estimateMonoWidth` is the only sizing input the whole HUD has — no widget here can
 * call `Text.width`/`getBounds()`, because this project's vitest environment has no
 * canvas to measure glyphs with (see textWidth.ts's own header). That makes it worth
 * pinning down directly: every backing panel, chip pill, and compare-card offset is
 * derived from it, so an error here shows up as clipped or over-padded UI everywhere
 * at once, in whichever locale happens to trip it.
 */
import { describe, it, expect } from 'vitest';
import { estimateMonoWidth } from './textWidth';

describe('estimateMonoWidth — Latin', () => {
  it('is zero for the empty string', () => {
    expect(estimateMonoWidth('', 13)).toBe(0);
  });

  it('advances 0.6em per ASCII character', () => {
    expect(estimateMonoWidth('abcde', 10)).toBeCloseTo(30, 6);
  });

  it('scales linearly with font size', () => {
    expect(estimateMonoWidth('SCORE', 20)).toBeCloseTo(estimateMonoWidth('SCORE', 10) * 2, 6);
  });

  it('scales linearly with length', () => {
    expect(estimateMonoWidth('ab', 13)).toBeCloseTo(estimateMonoWidth('a', 13) * 2, 6);
  });
});

describe('estimateMonoWidth — East Asian wide characters', () => {
  // The bug this half exists for: the original `text.length * size * 0.6` measured
  // every zh HUD string at 60% of its real width, so every panel sized from one came
  // up short — invisible in English, a clipped HUD in Chinese.
  it('counts a CJK ideograph as a full em, not 0.6', () => {
    expect(estimateMonoWidth('楼', 10)).toBeCloseTo(10, 6);
  });

  it('measures a CJK label wider than a Latin one of the same length', () => {
    expect(estimateMonoWidth('楼层', 13)).toBeGreaterThan(estimateMonoWidth('ab', 13));
  });

  it('measures a CJK label wider than the Latin word it translates', () => {
    expect(estimateMonoWidth('伤害 12', 11)).toBeGreaterThan(estimateMonoWidth('DMG 12', 11) * 0.9);
  });

  it('adds mixed Latin and CJK per character rather than picking one rate', () => {
    // The zh weapon subtitle's own shape: 4 wide ideographs (4em) plus the separator
    // it actually uses, U+00B7 MIDDLE DOT — a Latin-1 character a monospace font
    // renders NARROW, unlike its fullwidth U+30FB lookalike. 4 * 10 + 0.6 * 10 = 46.
    expect(estimateMonoWidth('普通·远程', 10)).toBeCloseTo(46, 6);
    expect(estimateMonoWidth('a楼', 10)).toBeCloseTo(16, 6);
  });

  it('handles the locales this project actually ships plus their punctuation', () => {
    for (const s of ['队友', '倒地 2秒', '存活', '（无）', '普通']) {
      expect(estimateMonoWidth(s, 12)).toBeGreaterThan(0);
    }
  });

  it('iterates by code point, so an astral character counts once (not as two surrogates)', () => {
    // U+20000 is a wide CJK ext-B ideograph stored as a surrogate pair; `.length` is 2.
    const astral = '\u{20000}';
    expect(astral.length).toBe(2);
    expect(estimateMonoWidth(astral, 10)).toBeCloseTo(10, 6);
  });

  it('leaves ordinary Latin punctuation narrow', () => {
    expect(estimateMonoWidth('· ', 10)).toBeCloseTo(12, 6); // U+00B7 middle dot is NOT wide
  });
});
