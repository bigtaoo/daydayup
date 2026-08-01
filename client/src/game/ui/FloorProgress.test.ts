import { describe, it, expect } from 'vitest';
import type { Text } from 'pixi.js';
import { FloorProgress } from './FloorProgress';

// The legend is the second child (after the dots' shared Graphics) — same
// index-by-construction-order convention as TouchControlsView.test.ts (no public
// API for it, this mirrors the fixed order build() uses).
function legendOf(fp: FloorProgress): Text {
  return fp.view.children[1] as Text;
}

describe('FloorProgress', () => {
  it('hides (and clears the legend) for a non-dungeon config (stageCount 0)', () => {
    const fp = new FloorProgress();
    fp.update(0, -1);
    expect(fp.view.visible).toBe(false);
    expect(legendOf(fp).text).toBe('');
  });

  it('shows a plain-language legend once there are stages, spelled out in ASCII', () => {
    const fp = new FloorProgress();
    fp.update(2, 0);
    expect(fp.view.visible).toBe(true);
    // Design/10 2026-08-01 legibility fix: no unicode glyph (e.g. "◆") restated
    // here — only the shape-key words, so every color/shape has a name a first-time
    // player can read instead of decoding on sight.
    const text = legendOf(fp).text;
    expect(text).toContain('done');
    expect(text).toContain('now');
    expect(text).toContain('checkpoint');
    expect(text).not.toMatch(/[^\x00-\x7F]/); // ASCII-only
  });

  it('positions the legend clear of the dots row, sliding right as more stages are added', () => {
    const fp = new FloorProgress();
    fp.update(2, 0);
    const xFor2 = legendOf(fp).position.x;

    fp.update(5, 0);
    const xFor5 = legendOf(fp).position.x;

    expect(xFor5).toBeGreaterThan(xFor2);
  });
});
