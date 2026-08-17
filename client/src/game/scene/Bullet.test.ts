/**
 * Bullet view (design/03/07 per-element polish): a coloured dot + shadow, plus an
 * additive glow halo for elemental rounds only. Children are appended glow-then-core
 * in the constructor (glow.blendMode='add') — same index-by-construction-order
 * convention as Pickup.test.ts/TouchControlsView.test.ts, no public accessor for
 * either child.
 */
import { describe, it, expect } from 'vitest';
import type { Graphics } from 'pixi.js';
import { THEME } from '../theme';
import { Bullet } from './Bullet';

const enum Child { Glow, Core }
function glowOf(b: Bullet): Graphics {
  return b.children[Child.Glow] as Graphics;
}
function coreOf(b: Bullet): Graphics {
  return b.children[Child.Core] as Graphics;
}

describe('Bullet — construction', () => {
  it('builds exactly glow + core (2 children) plus a soft shadow', () => {
    const b = new Bullet(6);
    expect(b.children.length).toBe(2);
    expect(glowOf(b).blendMode).toBe('add');
    expect(b.shadow).not.toBeNull();
  });
});

describe('Bullet.color — element hue vs faction fallback', () => {
  it('defaults to the player bullet colour before any faction/element is set (physical, faction null)', () => {
    const b = new Bullet(6);
    expect(b.color).toBe(THEME.colors.bulletPlayer);
  });

  it('a physical bullet takes its faction colour', () => {
    const b = new Bullet(6);
    b.setFaction('player');
    expect(b.color).toBe(THEME.colors.bulletPlayer);
    b.setFaction('enemy');
    expect(b.color).toBe(THEME.colors.bulletEnemy);
  });

  it('an elemental bullet takes its element hue regardless of faction', () => {
    const b = new Bullet(6);
    b.setFaction('enemy');
    b.setElement('fire');
    expect(b.color).toBe(THEME.colors.statusBurn);
    // Faction still colours nothing once elemental — even flipping faction (melee
    // deflect) doesn't change the element-hue read.
    b.setFaction('player');
    expect(b.color).toBe(THEME.colors.statusBurn);
  });

  it.each([
    ['ice', 'statusChill'],
    ['lightning', 'statusShock'],
    ['poison', 'statusPoison'],
  ] as const)('%s bullets read as %s', (element, key) => {
    const b = new Bullet(6);
    b.setElement(element);
    expect(b.color).toBe(THEME.colors[key]);
  });
});

describe('Bullet redraw — glow-halo branch', () => {
  it('a physical round gets no glow geometry (clean dot, halo cleared)', () => {
    const b = new Bullet(6);
    b.setFaction('player');
    expect(glowOf(b).getLocalBounds().width).toBe(0);
    expect(coreOf(b).getLocalBounds().width).toBeGreaterThan(0);
  });

  it('an elemental round draws additive halo geometry around the core', () => {
    const b = new Bullet(6);
    b.setElement('fire');
    const glowBounds = glowOf(b).getLocalBounds();
    const coreBounds = coreOf(b).getLocalBounds();
    expect(glowBounds.width).toBeGreaterThan(0);
    // The halo is drawn as concentric rings OUTSIDE the core radius (i * 0.5 bigger).
    expect(glowBounds.width).toBeGreaterThan(coreBounds.width);
  });

  it('switching from elemental back to physical (faction flip via deflect) clears the halo again', () => {
    const b = new Bullet(6);
    b.setElement('fire');
    expect(glowOf(b).getLocalBounds().width).toBeGreaterThan(0);
    b.setElement('physical');
    expect(glowOf(b).getLocalBounds().width).toBe(0);
  });
});

// setMuzzleOrigin (2026-08-17) — the render-only correction that makes a shot leave the
// shooter's drawn barrel tip instead of the engine's ground-plane muzzle point. See the
// method's own doc for the geometry; Scene.test.ts covers the wiring, this covers the
// curve itself.
describe('Bullet.setMuzzleOrigin — easing from the barrel tip onto the sim line', () => {
  /** A bullet parked at a fixed sim position, so every drawn offset below is the ease. */
  function parked(x = 100, y = 200, z = 0): Bullet {
    const b = new Bullet(4);
    b.place(x, y, z);
    return b;
  }

  it('draws exactly at the sim position when no origin was ever set (every enemy)', () => {
    const b = parked();
    b.interpolate(1, 16);
    expect(b.x).toBe(100);
    expect(b.y).toBe(200);
  });

  it('starts fully at the muzzle and lands exactly on the sim position once spent', () => {
    const b = parked();
    b.setMuzzleOrigin(30, -18);

    b.interpolate(1, 0); // first drawn frame, nothing elapsed
    expect(b.x).toBeCloseTo(130, 6);
    expect(b.y).toBeCloseTo(182, 6);

    b.interpolate(1, 120); // the whole 120ms ease in one frame
    expect(b.x).toBeCloseTo(100, 6);
    expect(b.y).toBeCloseTo(200, 6);
  });

  it('decays monotonically, front-loaded (ease-out) rather than linearly', () => {
    const b = parked();
    b.setMuzzleOrigin(120, 0);
    const offsets: number[] = [];
    for (let i = 0; i < 4; i++) {
      b.interpolate(1, 30); // 4 x 30ms = the full 120ms
      offsets.push(b.x - 100);
    }
    // Strictly shrinking...
    for (let i = 1; i < offsets.length; i++) expect(offsets[i]!).toBeLessThan(offsets[i - 1]!);
    // ...and past halfway in time, well past halfway in distance (k² not k).
    expect(offsets[1]!).toBeLessThan(120 * 0.5);
    expect(offsets[offsets.length - 1]!).toBe(0);
  });

  it('never overshoots past the sim position, however long the frame', () => {
    const b = parked();
    b.setMuzzleOrigin(30, -18);
    b.interpolate(1, 5000); // a tab that was backgrounded, or a debugger pause
    expect(b.x).toBe(100);
    expect(b.y).toBe(200);
  });

  it('offsets only the sprite — the shadow stays on the bullet\'s real ground point', () => {
    const b = parked(100, 200, 40); // lifted, so shadow.y and b.y already differ
    b.setMuzzleOrigin(30, -18);
    b.interpolate(1, 0);
    expect(b.x).toBeCloseTo(130, 6); // sprite pulled to the muzzle
    expect(b.shadow!.x).toBe(100); // shadow marks where the bullet actually IS
    expect(b.shadow!.y).toBe(200);
  });

  it('keeps easing across the tick boundary, not just within one tick\'s interpolation', () => {
    // The correction outlives a single pushState: the offset is time-based, so a bullet
    // that gets a fresh sim position mid-ease keeps the remainder of its curve.
    const b = parked();
    b.setMuzzleOrigin(60, 0);
    b.interpolate(1, 30);
    const midEase = b.x - 100;
    expect(midEase).toBeGreaterThan(0);

    b.pushState(140, 200, 0, 0); // next sim tick — the bullet has flown on
    b.interpolate(1, 30);
    expect(b.x - 140).toBeGreaterThan(0); // still offset from the NEW sim position...
    expect(b.x - 140).toBeLessThan(midEase); // ...but by less than before
  });
});
