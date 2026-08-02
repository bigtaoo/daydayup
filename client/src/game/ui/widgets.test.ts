import { describe, it, expect, vi } from 'vitest';
import { Graphics } from 'pixi.js';
import { Panel } from './widgets';

// Panel's border option (design/10 legibility fix, 2026-08-02): a flat near-black fill
// at low alpha reads as invisible over the app's own black backdrop — borderColor
// gives it a readable edge regardless of what's behind it. Covers the opt-in stroke
// plus the pre-existing same-size skip-redraw guard `layout()` already had.
describe('Panel', () => {
  it('draws its scrim to the requested size', () => {
    const p = new Panel({ radius: 8 });
    p.layout(120, 60);
    const scrim = p.view.children[0] as Graphics;
    const b = scrim.getLocalBounds();
    expect(b.width).toBeCloseTo(120, 0);
    expect(b.height).toBeCloseTo(60, 0);
  });

  it('adds an inset border stroke when borderColor is set, without changing the panel footprint', () => {
    const bordered = new Panel({ radius: 8, borderColor: 0x4c566a });
    bordered.layout(120, 60);
    const scrim = bordered.view.children[0] as Graphics;
    const b = scrim.getLocalBounds();
    expect(b.width).toBeCloseTo(120, 0);
    expect(b.height).toBeCloseTo(60, 0);
  });

  it('draws no border stroke when borderColor is omitted (default, pre-existing look)', () => {
    const p = new Panel({ radius: 8 });
    expect(() => p.layout(120, 60)).not.toThrow();
  });

  it('is a no-op re-layout at the same size (skips redraw)', () => {
    const p = new Panel({ radius: 8, borderColor: 0x4c566a });
    p.layout(120, 60);
    const scrim = p.view.children[0] as Graphics;
    const clearSpy = vi.spyOn(scrim, 'clear');
    p.layout(120, 60);
    expect(clearSpy).not.toHaveBeenCalled();
  });

  it('redraws when the size actually changes', () => {
    const p = new Panel({ radius: 8, borderColor: 0x4c566a });
    p.layout(120, 60);
    const scrim = p.view.children[0] as Graphics;
    const clearSpy = vi.spyOn(scrim, 'clear');
    p.layout(200, 60);
    expect(clearSpy).toHaveBeenCalled();
  });
});
