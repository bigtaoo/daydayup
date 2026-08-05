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
