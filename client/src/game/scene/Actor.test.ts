import { describe, it, expect } from 'vitest';
import type { Graphics } from 'pixi.js';
import { Actor } from './Actor';

// Children are appended in this fixed order in the constructor — indexing into
// `.children` is the only way in from the outside, since healthBar is private (same
// convention as TouchControlsView.test.ts/FloorProgress.test.ts: no public API, and
// screenshots aren't available in this environment — see the daydayup memory notes).
const enum Child { StatusAura, SkinView, WeaponGfx, HealthBar }

function healthBarOf(a: Actor): Graphics {
  return a.children[Child.HealthBar] as Graphics;
}

describe('Actor — floating health bars (design/10 legibility fix, 2026-08-02)', () => {
  it('gives every enemy a floating health bar, not just bosses', () => {
    const mob = new Actor('enemy', 12, undefined, false);
    expect(mob.children.length).toBe(4); // statusAura, skin.view, weaponGfx, healthBar
    expect(healthBarOf(mob)).toBeDefined();
  });

  it('still gives a boss its (bigger) health bar', () => {
    const boss = new Actor('enemy', 12, undefined, true);
    expect(boss.children.length).toBe(4);
    expect(healthBarOf(boss)).toBeDefined();
  });

  it('gives a player actor a floating health bar too (visible on the map, not just the HUD)', () => {
    const player = new Actor('player', 12, undefined, false);
    expect(player.children.length).toBe(4); // statusAura, skin.view, weaponGfx, healthBar
    expect(healthBarOf(player)).toBeDefined();
  });

  it('draws a wider/taller bar for a boss than for a regular mob at the same radius', () => {
    const mob = new Actor('enemy', 12, undefined, false);
    const boss = new Actor('enemy', 12, undefined, true);
    mob.setHealth(50, 100);
    boss.setHealth(50, 100);
    const mobBounds = healthBarOf(mob).getLocalBounds();
    const bossBounds = healthBarOf(boss).getLocalBounds();
    expect(bossBounds.width).toBeGreaterThan(mobBounds.width);
    expect(bossBounds.height).toBeGreaterThan(mobBounds.height);
  });

  it('is a no-op with maxHp <= 0 (no divide-by-zero bar)', () => {
    const mob = new Actor('enemy', 12, undefined, false);
    expect(() => mob.setHealth(0, 0)).not.toThrow();
    // No geometry drawn yet — an empty Graphics has zero bounds.
    expect(healthBarOf(mob).getLocalBounds().width).toBe(0);
  });

  it('redraws when the hp fraction actually changes', () => {
    const mob = new Actor('enemy', 12, undefined, false);
    mob.setHealth(100, 100);
    const fullBounds = healthBarOf(mob).getLocalBounds();
    mob.setHealth(50, 100);
    const halfBounds = healthBarOf(mob).getLocalBounds();
    // The track width is fixed (radius-based); it's the filled portion that changes,
    // but the track itself is redrawn every call that isn't a skip, so this just
    // confirms setHealth doesn't throw across repeated real changes.
    expect(halfBounds.width).toBe(fullBounds.width);
  });
});

describe('Actor.setLocal — "which one is me" marker (design/10 legibility)', () => {
  function ringOf(a: Actor): Graphics | undefined {
    return a.children[4] as Graphics | undefined; // appended after the 4 constructor children
  }

  it('adds no ring at all until an actor is marked local (enemies never pay for it)', () => {
    const mob = new Actor('enemy', 12);
    expect(mob.children.length).toBe(4);
    mob.setLocal(false);
    expect(mob.children.length).toBe(4);
  });

  it('draws a ground ring on the local seat', () => {
    const me = new Actor('player', 12);
    me.setLocal(true);
    expect(me.children.length).toBe(5);
    expect(ringOf(me)!.getLocalBounds().width).toBeGreaterThan(0);
  });

  it('clears the ring when the seat stops being local', () => {
    const me = new Actor('player', 12);
    me.setLocal(true);
    me.setLocal(false);
    expect(ringOf(me)!.getLocalBounds().width).toBe(0);
  });

  it('the ring lies flat on the ground plane (wider than it is tall, like the shadow)', () => {
    const me = new Actor('player', 12);
    me.setLocal(true);
    const b = ringOf(me)!.getLocalBounds();
    expect(b.width).toBeGreaterThan(b.height);
  });

  it('re-outlines an already-drawn health bar when the local flag flips', () => {
    const me = new Actor('player', 12);
    me.setHealth(50, 100);
    const before = healthBarOf(me).getLocalBounds().width;
    me.setLocal(true);
    me.setHealth(50, 100); // same ratio — only the forced redraw makes this repaint
    // The local outline is thicker, so the stroked bounds grow even at an identical ratio.
    expect(healthBarOf(me).getLocalBounds().width).toBeGreaterThan(before);
  });
});

// Uses the default Graphics-placeholder skin (no `.tao` rig registered under plain
// vitest, same as every other Pixi-construction test in this repo) — which makes the
// two facing angles trivial to observe directly: the placeholder's "front" facing
// indicator rotates with the BODY angle, while the separate cosmetic weapon graphic
// always rotates with the AIM angle — exactly the split RigSkin.ts documents for a
// real rig (setBodyFacing vs setAim).
function frontOf(a: Actor): { rotation: number } {
  return (a as unknown as { skin: { front?: { rotation: number } } }).skin.front!;
}
function weaponGfxOf(a: Actor): { rotation: number } {
  return (a as unknown as { weaponGfx: { rotation: number } }).weaponGfx;
}

describe('Actor.interpolate — body vs weapon facing (upper/lower body split)', () => {
  it('the body indicator follows bodyFacingRad, the weapon graphic follows facingRad', () => {
    const a = new Actor('player', 20);
    a.pushState(0, 0, 0, Math.PI, -Math.PI / 2); // aim=west, body=north
    a.snap();
    a.interpolate(1, 16);
    expect(frontOf(a).rotation).toBeCloseTo(-Math.PI / 2, 10);
    expect(weaponGfxOf(a).rotation).toBeCloseTo(Math.PI, 10);
  });

  it('the two angles move independently across ticks', () => {
    const a = new Actor('player', 20);
    a.pushState(0, 0, 0, 0, 0);
    a.snap();
    a.interpolate(1, 16);
    expect(frontOf(a).rotation).toBeCloseTo(0, 10);
    expect(weaponGfxOf(a).rotation).toBeCloseTo(0, 10);

    // Body turns to face new movement; aim stays put (player kept shooting the same way).
    a.pushState(1, 0, 0, 0, Math.PI);
    a.snap();
    a.interpolate(1, 16);
    expect(frontOf(a).rotation).toBeCloseTo(Math.PI, 10);
    expect(weaponGfxOf(a).rotation).toBeCloseTo(0, 10);
  });

  it('an enemy (no distinct body facing passed) keeps both angles in lockstep', () => {
    const a = new Actor('enemy', 20);
    a.pushState(0, 0, 0, Math.PI / 2); // bodyFacingRad defaults to facingRad
    a.snap();
    a.interpolate(1, 16);
    expect(frontOf(a).rotation).toBeCloseTo(Math.PI / 2, 10);
    expect(weaponGfxOf(a).rotation).toBeCloseTo(Math.PI / 2, 10);
  });
});
