import { describe, it, expect } from 'vitest';
import { FloorProgress } from './FloorProgress';

// Icon-first (design/10 legibility fix, 2026-08-02): the standalone text legend
// ("green=done amber=now diamond=checkpoint") was replaced by baking the meaning
// into the dots themselves (checkmark/ring/diamond) — this file's own Graphics is
// opaque to a vitest assertion, so these tests check the externally-visible shape
// (visibility, view child count, width growth) rather than glyph pixels.
describe('FloorProgress', () => {
  it('hides for a non-dungeon config (stageCount 0)', () => {
    const fp = new FloorProgress();
    fp.update(0, -1);
    expect(fp.view.visible).toBe(false);
    expect(fp.estimatedWidth()).toBe(0);
  });

  it('shows the dot track with no separate text legend once there are stages', () => {
    const fp = new FloorProgress();
    fp.update(2, 0);
    expect(fp.view.visible).toBe(true);
    // Only the shared dots Graphics — no Text child carrying a spelled-out legend.
    expect(fp.view.children.length).toBe(1);
  });

  it('widens as more stages are added (dots-only width, no legend term)', () => {
    const fp = new FloorProgress();
    fp.update(2, 0);
    const wFor2 = fp.estimatedWidth();

    fp.update(5, 0);
    const wFor5 = fp.estimatedWidth();

    expect(wFor5).toBeGreaterThan(wFor2);
  });
});
