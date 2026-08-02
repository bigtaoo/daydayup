/**
 * `drawHudIcon`'s contract is a layout contract, not an art one: `StatChip`/`AllyRow`
 * position text and size their pill from the declared (cx±r, cy±r) box WITHOUT ever
 * measuring what was drawn, so a glyph that spills outside it silently overlaps its
 * own label. These tests pin that box down for every icon id, and pin down that each
 * id draws something at all — the switch has no `default:`, so a new id added to
 * `HudIconId` without a case would otherwise render an invisible, silent nothing.
 */
import { describe, it, expect } from 'vitest';
import { Graphics } from 'pixi.js';
import { drawHudIcon, type HudIconId } from './hudIcons';

const ALL_ICONS: readonly HudIconId[] = [
  'floor',
  'room',
  'enemies',
  'banked',
  'score',
  'buffs',
  'alive',
  'stage',
  'ally',
];

// Strokes straddle the path, so a 2px stroke on the box edge reads 1px outside it.
const STROKE_SLOP = 2;

function drawn(icon: HudIconId, cx = 15, cy = 15, r = 7): Graphics {
  const g = new Graphics();
  drawHudIcon(g, icon, cx, cy, r, 0xffffff);
  return g;
}

describe('drawHudIcon', () => {
  it.each(ALL_ICONS)('%s draws visible geometry', (icon) => {
    const b = drawn(icon).getLocalBounds();
    expect(b.width).toBeGreaterThan(0);
    expect(b.height).toBeGreaterThan(0);
  });

  it.each(ALL_ICONS)('%s stays inside its declared (cx±r, cy±r) box', (icon) => {
    const cx = 15;
    const cy = 15;
    const r = 7;
    const b = drawn(icon, cx, cy, r).getLocalBounds();
    expect(b.left).toBeGreaterThanOrEqual(cx - r - STROKE_SLOP);
    expect(b.right).toBeLessThanOrEqual(cx + r + STROKE_SLOP);
    expect(b.top).toBeGreaterThanOrEqual(cy - r - STROKE_SLOP);
    expect(b.bottom).toBeLessThanOrEqual(cy + r + STROKE_SLOP);
  });

  it.each(ALL_ICONS)('%s fills a usable share of its box (not a lone hairline)', (icon) => {
    const r = 7;
    const b = drawn(icon, 15, 15, r).getLocalBounds();
    expect(b.width).toBeGreaterThan(r); // > half the box across
    expect(b.height).toBeGreaterThan(r);
  });

  it.each(ALL_ICONS)('%s scales with r rather than baking in a fixed pixel size', (icon) => {
    const small = drawn(icon, 40, 40, 5).getLocalBounds();
    const large = drawn(icon, 40, 40, 20).getLocalBounds();
    expect(large.width).toBeGreaterThan(small.width);
    expect(large.height).toBeGreaterThan(small.height);
  });

  it.each(ALL_ICONS)('%s translates with (cx, cy)', (icon) => {
    const at0 = drawn(icon, 0, 0, 7).getLocalBounds();
    const at100 = drawn(icon, 100, 60, 7).getLocalBounds();
    expect(at100.left - at0.left).toBeCloseTo(100, 4);
    expect(at100.top - at0.top).toBeCloseTo(60, 4);
    expect(at100.width).toBeCloseTo(at0.width, 4);
  });

  it('appends to the Graphics it is given rather than clearing it (chips draw once)', () => {
    const g = new Graphics();
    drawHudIcon(g, 'score', 15, 15, 7, 0xffffff);
    const oneIcon = g.getLocalBounds().width;
    drawHudIcon(g, 'score', 60, 15, 7, 0xffffff);
    expect(g.getLocalBounds().width).toBeGreaterThan(oneIcon);
  });
});
