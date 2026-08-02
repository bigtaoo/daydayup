/**
 * `StatChip` owns the one number the rest of the HUD layout depends on: `width`.
 * `HudView.layout` packs the chip row left-to-right from it and sizes the backing
 * panel to the total, all without a canvas — so a chip that under-reports its width
 * produces overlapping pills, and one that never recomputes leaves a stale gap.
 */
import { describe, it, expect } from 'vitest';
import { StatChip } from './StatChip';

describe('StatChip — width', () => {
  it('is zero before the first set() (nothing to lay out yet)', () => {
    expect(new StatChip('score', 0xffffff).width).toBe(0);
  });

  it('grows with a longer value', () => {
    const short = new StatChip('score', 0xffffff);
    short.set('SCORE', '0');
    const long = new StatChip('score', 0xffffff);
    long.set('SCORE', '1234567');
    expect(long.width).toBeGreaterThan(short.width);
  });

  it('grows with a longer label', () => {
    const short = new StatChip('banked', 0xffffff);
    short.set('BAG', '0');
    const long = new StatChip('banked', 0xffffff);
    long.set('MATERIALS BANKED', '0');
    expect(long.width).toBeGreaterThan(short.width);
  });

  it('tracks whichever of label/value is wider, not just the label', () => {
    const chip = new StatChip('score', 0xffffff);
    chip.set('S', '0');
    const tiny = chip.width;
    chip.set('S', '9999999999');
    expect(chip.width).toBeGreaterThan(tiny);
  });

  it('shrinks back when the content gets shorter again', () => {
    const chip = new StatChip('enemies', 0xffffff);
    chip.set('FOES', '0');
    const narrow = chip.width;
    chip.set('FOES', '1000');
    expect(chip.width).toBeGreaterThan(narrow);
    chip.set('FOES', '0');
    expect(chip.width).toBe(narrow);
  });

  it('leaves room for the icon: even an empty chip is wider than its glyph box', () => {
    const chip = new StatChip('floor', 0xffffff);
    chip.set('', '');
    expect(chip.width).toBeGreaterThanOrEqual(30); // icon box + right padding
  });

  it('is wider for a CJK label than for the Latin one it translates', () => {
    const en = new StatChip('floor', 0xffffff);
    en.set('FLOOR', '1/3');
    const zh = new StatChip('floor', 0xffffff);
    zh.set('楼层楼层楼层', '1/3');
    expect(zh.width).toBeGreaterThan(en.width);
  });
});

describe('StatChip — content + redraw', () => {
  it('exposes the label and value it was set to', () => {
    const chip = new StatChip('room', 0xffffff);
    chip.set('ROOM', '2/5');
    expect(chip.labelText).toBe('ROOM');
    expect(chip.valueText).toBe('2/5');
  });

  it('is a no-op for an unchanged set() (called every frame from update())', () => {
    const chip = new StatChip('score', 0xffffff);
    chip.set('SCORE', '10');
    const w = chip.width;
    for (let i = 0; i < 100; i++) chip.set('SCORE', '10');
    expect(chip.width).toBe(w);
    expect(chip.valueText).toBe('10');
  });

  it('draws the pill background wide enough to cover its own reported width', () => {
    const chip = new StatChip('buffs', 0xffffff);
    chip.set('BUFFS', '3');
    const bg = chip.view.children[0] as { getLocalBounds(): { width: number; height: number } };
    expect(bg.getLocalBounds().width).toBeGreaterThanOrEqual(chip.width);
    expect(bg.getLocalBounds().height).toBeGreaterThanOrEqual(StatChip.HEIGHT);
  });

  it('keeps every chip the same height, whatever its content (they share one row)', () => {
    const a = new StatChip('floor', 0xffffff);
    a.set('FLOOR', '1/3');
    const b = new StatChip('score', 0xffffff);
    b.set('SCORE', '1234567');
    const heightOf = (c: StatChip) =>
      (c.view.children[0] as { getLocalBounds(): { height: number } }).getLocalBounds().height;
    expect(heightOf(a)).toBe(heightOf(b));
  });
});
