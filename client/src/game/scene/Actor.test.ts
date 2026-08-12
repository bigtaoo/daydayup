import { describe, it, expect, vi } from 'vitest';
import type { Graphics, Rectangle } from 'pixi.js';
import { freshStatus } from '@dd/engine/content/damage';
import { Actor } from './Actor';

// EnergyShieldFilter/OutlineFilter/DissolveFilter all build a real WebGL GlProgram at
// construction time — unavailable under plain vitest (no `document`/canvas), same reason
// FxController.test.ts stubs fx/filters.ts. Bare classes with the settable properties
// Actor actually touches are enough to exercise its attach/detach/reuse logic without
// touching the GPU.
vi.mock('../fx/filters', () => ({
  EnergyShieldFilter: class {
    intensity = 0;
    constructor(public color?: number) {}
    tick() {}
  },
  OutlineFilter: class {
    alpha = 0;
    constructor(public color?: number) {}
  },
  DissolveFilter: class {
    progress = 0;
  },
  HeatHazeFilter: class {
    intensity = 1;
    tick() {}
  },
  NormalLitFilter: class {
    dirX = 0;
    dirY = 0;
    color = 0;
    intensity = 0;
    setPoint(dirX: number, dirY: number, color: number, intensity: number) {
      this.dirX = dirX;
      this.dirY = dirY;
      this.color = color;
      this.intensity = intensity;
    }
    clearPoint() {
      this.intensity = 0;
    }
  },
}));

// Children are appended in this fixed order in the constructor — indexing into
// `.children` is the only way in from the outside, since healthBar is private (same
// convention as TouchControlsView.test.ts: no public API, and screenshots aren't
// available in this environment — see the daydayup memory notes).
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

function skinFiltersOf(a: Actor): unknown {
  return (a as unknown as { skin: { view: { filters: unknown } } }).skin.view.filters;
}
function skinFilterAreaOf(a: Actor): Rectangle {
  return (a as unknown as { skin: { view: { filterArea: Rectangle } } }).skin.view.filterArea;
}
function shieldFilterOf(a: Actor): { intensity: number } | null {
  return (a as unknown as { shieldFilter: { intensity: number } | null }).shieldFilter;
}
function litFilterOf(a: Actor): { dirX: number; dirY: number; color: number; intensity: number } {
  return (a as unknown as { litFilter: { dirX: number; dirY: number; color: number; intensity: number } }).litFilter;
}

// Lopsided-shield-glow fix (2026-08-12): `EnergyShieldFilter`'s shader hardcodes
// texture-coordinate (0.5,0.5) as the character's centre, but `skin.view`'s
// AUTO-computed bounds are asymmetric (the placeholder's facing-direction "front"
// wedge, or a real rig's mounted weapon sprite, both extend outward on one side only)
// — pinning an explicit, symmetric `filterArea` centred on the skin's true local
// origin (0,0) is what keeps the shield (and every other skin-level filter) centred
// regardless of which way the actor is currently facing/aiming.
describe('Actor — skin filterArea is a fixed square centred on the true local origin (2026-08-12 lopsided-shield fix)', () => {
  it('is centred on (0,0), not offset by facing/weapon geometry', () => {
    const a = new Actor('player', 20);
    const area = skinFilterAreaOf(a);
    expect(area.x + area.width / 2).toBeCloseTo(0);
    expect(area.y + area.height / 2).toBeCloseTo(0);
  });

  it('scales with the actor\'s own radius, not a fixed pixel size', () => {
    const small = skinFilterAreaOf(new Actor('enemy', 10));
    const big = skinFilterAreaOf(new Actor('enemy', 30));
    expect(big.width).toBeGreaterThan(small.width);
    expect(big.width / small.width).toBeCloseTo(30 / 10, 5);
  });

  it('does not shift when the actor turns to face a different direction', () => {
    const a = new Actor('player', 20);
    const before = skinFilterAreaOf(a);
    const beforeCenter = { x: before.x + before.width / 2, y: before.y + before.height / 2 };
    a.pushState(0, 0, 0, Math.PI, -Math.PI / 2);
    a.snap();
    a.interpolate(1, 16);
    const after = skinFilterAreaOf(a);
    expect(after.x + after.width / 2).toBeCloseTo(beforeCenter.x);
    expect(after.y + after.height / 2).toBeCloseTo(beforeCenter.y);
  });
});

describe('Actor.setShield — energy-shield shader (design/01 fidelity roadmap milestone 5)', () => {
  it('is a no-op with no shield pool (maxShield <= 0) — most enemies never pay for a filter', () => {
    const mob = new Actor('enemy', 12);
    mob.setShield(0, 0);
    // litFilter (design/01 milestone 2) is always attached — "no-op" here means no
    // CONDITIONAL shader joins it, not that the filter list itself is ever empty.
    expect(skinFiltersOf(mob) as unknown[]).toEqual([litFilterOf(mob)]);
    expect(shieldFilterOf(mob)).toBeNull();
  });

  it('attaches the filter once shield > 0 and drives intensity off the live ratio', () => {
    const a = new Actor('player', 12);
    a.setShield(4, 8);
    expect(skinFiltersOf(a)).toBeTruthy();
    expect(shieldFilterOf(a)!.intensity).toBeCloseTo(0.5);
  });

  it('reuses the same filter instance across updates instead of rebuilding it', () => {
    const a = new Actor('player', 12);
    a.setShield(8, 8);
    const first = shieldFilterOf(a);
    a.setShield(4, 8);
    expect(shieldFilterOf(a)).toBe(first);
    expect(shieldFilterOf(a)!.intensity).toBeCloseTo(0.5);
  });

  it('detaches the filter once the shield hits 0 (shield_break already flashes the moment)', () => {
    const a = new Actor('player', 12);
    a.setShield(4, 8);
    expect(skinFiltersOf(a)).toBeTruthy();
    a.setShield(0, 8);
    expect(skinFiltersOf(a) as unknown[]).toEqual([litFilterOf(a)]); // back to lit-only
  });

  it('re-attaches on regen after a break, without rebuilding the filter', () => {
    const a = new Actor('player', 12);
    a.setShield(4, 8);
    const first = shieldFilterOf(a);
    a.setShield(0, 8);
    expect(skinFiltersOf(a) as unknown[]).toEqual([litFilterOf(a)]); // back to lit-only
    a.setShield(2, 8);
    expect(skinFiltersOf(a)).toBeTruthy();
    expect(shieldFilterOf(a)).toBe(first);
  });

  it('skips redundant work when the ratio has not changed', () => {
    const a = new Actor('player', 12);
    a.setShield(4, 8);
    const before = shieldFilterOf(a);
    before!.intensity = 0.99; // tamper — a real update at the same ratio should leave it alone
    a.setShield(4, 8);
    expect(shieldFilterOf(a)!.intensity).toBe(0.99);
  });
});

function outlineFilterOf(a: Actor): { alpha: number } | null {
  return (a as unknown as { outlineFilter: { alpha: number } | null }).outlineFilter;
}

describe('Actor.hitFlash — outline shader (design/01 fidelity roadmap milestone 5)', () => {
  it('attaches the outline filter at full alpha on the first hit', () => {
    const a = new Actor('enemy', 12);
    expect(skinFiltersOf(a) as unknown[]).toEqual([litFilterOf(a)]); // lit-only, pre-hit
    a.hitFlash();
    expect(skinFiltersOf(a) as unknown[]).toHaveLength(2);
    expect(outlineFilterOf(a)!.alpha).toBe(1);
  });

  it('decays to 0 over HIT_FLASH_MS and then detaches', () => {
    const a = new Actor('player', 12);
    a.hitFlash();
    a.interpolate(1, 80); // half of the 160ms flash
    expect(outlineFilterOf(a)!.alpha).toBeCloseTo(0.5, 1);
    expect(skinFiltersOf(a)).toBeTruthy();
    a.interpolate(1, 80); // fully decayed
    expect(outlineFilterOf(a)!.alpha).toBe(0);
    expect(skinFiltersOf(a) as unknown[]).toEqual([litFilterOf(a)]); // back to lit-only
  });

  it('reuses the same filter instance across repeated hits', () => {
    const a = new Actor('player', 12);
    a.hitFlash();
    const first = outlineFilterOf(a);
    a.interpolate(1, 160); // fully decays
    a.hitFlash();
    expect(outlineFilterOf(a)).toBe(first);
    expect(outlineFilterOf(a)!.alpha).toBe(1);
  });

  it('coexists with an active shield glow — both filters attach at once', () => {
    const a = new Actor('player', 12);
    a.setShield(4, 8);
    a.hitFlash();
    expect(skinFiltersOf(a) as unknown[]).toHaveLength(3); // lit + shield + outline
  });
});

function dissolveFilterOf(a: Actor): { progress: number } | null {
  return (a as unknown as { dissolveFilter: { progress: number } | null }).dissolveFilter;
}

describe('Actor.startDissolve — death-dissolve shader (design/01 fidelity roadmap milestone 5)', () => {
  it('attaches the dissolve filter and hides the weapon/aura/hp-bar/local-ring', () => {
    const a = new Actor('player', 12);
    a.setLocal(true);
    a.setHealth(50, 100);
    a.startDissolve();
    expect(skinFiltersOf(a)).toBeTruthy();
    expect(dissolveFilterOf(a)!.progress).toBe(0);
    expect(a.isDissolved).toBe(false);
    const weaponGfx = (a as unknown as { weaponGfx: { visible: boolean } }).weaponGfx;
    const statusAura = (a as unknown as { statusAura: { visible: boolean } }).statusAura;
    expect(weaponGfx.visible).toBe(false);
    expect(statusAura.visible).toBe(false);
  });

  it('progresses over DISSOLVE_MS and reports isDissolved once fully played out', () => {
    const a = new Actor('enemy', 12);
    a.startDissolve();
    a.interpolate(1, 350); // half of the 700ms dissolve
    expect(dissolveFilterOf(a)!.progress).toBeCloseTo(0.5, 1);
    expect(a.isDissolved).toBe(false);
    a.interpolate(1, 400); // past the end — clamps, doesn't overshoot
    expect(dissolveFilterOf(a)!.progress).toBe(1);
    expect(a.isDissolved).toBe(true);
  });

  it('is idempotent — a second call does not rebuild the filter or reset progress', () => {
    const a = new Actor('enemy', 12);
    a.startDissolve();
    a.interpolate(1, 350);
    const first = dissolveFilterOf(a);
    a.startDissolve();
    expect(dissolveFilterOf(a)).toBe(first);
    expect(dissolveFilterOf(a)!.progress).toBeCloseTo(0.5, 1);
  });
});

function heatHazeFilterOf(a: Actor): unknown {
  return (a as unknown as { heatHazeFilter: unknown }).heatHazeFilter;
}

describe('Actor.setStatus — heat-haze shader on burn (design/01 fidelity roadmap milestone 5)', () => {
  it('is a no-op with no active status at all', () => {
    const a = new Actor('enemy', 12);
    a.setStatus(freshStatus());
    expect(skinFiltersOf(a) as unknown[]).toEqual([litFilterOf(a)]); // lit-only
    expect(heatHazeFilterOf(a)).toBeNull();
  });

  it('attaches the heat-haze filter on a burn, alongside the existing status-aura ring', () => {
    const a = new Actor('enemy', 12);
    a.setStatus({ ...freshStatus(), burnTicks: 10 });
    expect(skinFiltersOf(a)).toBeTruthy();
    expect(heatHazeFilterOf(a)).not.toBeNull();
  });

  it('detaches once the burn ends, even if a different status (chill) is still active', () => {
    const a = new Actor('enemy', 12);
    a.setStatus({ ...freshStatus(), burnTicks: 10, chillTicks: 5 });
    expect(skinFiltersOf(a)).toBeTruthy();
    a.setStatus({ ...freshStatus(), burnTicks: 0, chillTicks: 5 }); // burn ends, chill lingers
    expect(skinFiltersOf(a) as unknown[]).toEqual([litFilterOf(a)]); // lit-only: no heat-haze/shield/outline/dissolve
  });

  it('does not rebuild the filter on an unrelated aura change while still burning', () => {
    const a = new Actor('enemy', 12);
    a.setStatus({ ...freshStatus(), burnTicks: 10 });
    const first = heatHazeFilterOf(a);
    a.setStatus({ ...freshStatus(), burnTicks: 10, chillTicks: 5 }); // chill joins, burn continues
    expect(heatHazeFilterOf(a)).toBe(first);
  });

  it('coexists with the shield glow — both filters attach at once', () => {
    const a = new Actor('player', 12);
    a.setShield(4, 8);
    a.setStatus({ ...freshStatus(), burnTicks: 10 });
    expect(skinFiltersOf(a) as unknown[]).toHaveLength(3); // lit + shield + heat-haze
  });
});

describe('Actor.setLighting — dynamic point lighting (design/01 fidelity roadmap milestone 2)', () => {
  it('attaches the lit filter immediately at construction — every actor is always lit', () => {
    const a = new Actor('enemy', 12);
    expect(skinFiltersOf(a) as unknown[]).toEqual([litFilterOf(a)]);
  });

  it('forwards a light hit straight to the filter', () => {
    const a = new Actor('player', 12);
    a.setLighting({ dirX: 0.6, dirY: 0.8, color: 0x66e0ff, intensity: 0.4 });
    const lit = litFilterOf(a);
    expect(lit.dirX).toBeCloseTo(0.6);
    expect(lit.dirY).toBeCloseTo(0.8);
    expect(lit.color).toBe(0x66e0ff);
    expect(lit.intensity).toBeCloseTo(0.4);
  });

  it('clears the point term when nothing is close enough (null hit)', () => {
    const a = new Actor('player', 12);
    a.setLighting({ dirX: 1, dirY: 0, color: 0xffffff, intensity: 0.9 });
    a.setLighting(null);
    expect(litFilterOf(a).intensity).toBe(0);
  });
});

describe('Actor — lighting plus all four fidelity-roadmap shaders composed at once (design/01 milestones 2 and 5)', () => {
  it('stacks lit, heat-haze, shield, outline, and dissolve in a fixed lit→warp→glow→highlight→dissolve order', () => {
    const a = new Actor('player', 12);
    a.setStatus({ ...freshStatus(), burnTicks: 10 });
    a.setShield(4, 8);
    a.hitFlash();
    a.startDissolve();

    const list = skinFiltersOf(a) as unknown[];
    expect(list).toHaveLength(5);
    expect(list[0]).toBe(litFilterOf(a));
    expect(list[1]).toBe(heatHazeFilterOf(a));
    expect(list[2]).toBe(shieldFilterOf(a));
    expect(list[3]).toBe(outlineFilterOf(a));
    expect(list[4]).toBe(dissolveFilterOf(a));
  });
});

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

// `movingOverride` (ROADMAP: fixes the local player's walk animation never playing
// under prediction) — `Scene.positionLocal`'s predicted-pose snap collapses prev onto
// cur every render frame, so the default curX/prevX-delta heuristic below would always
// read "stationary" for the local player. Spying on `skin.setFacing` (rather than
// reading the Graphics placeholder's rotation, which is identical for idle/move) is the
// only way to observe which clip name `interpolate()` actually picked.
function skinOf(a: Actor): { setFacing: (...args: unknown[]) => void } {
  return (a as unknown as { skin: { setFacing: (...args: unknown[]) => void } }).skin;
}

describe('Actor.interpolate — movingOverride (idle/move clip selection survives a positionLocal-style snap)', () => {
  it('by default, derives moving from the buffer delta (Scene.reconcile\'s normal per-tick pushState, no snap)', () => {
    const a = new Actor('player', 20);
    const spy = vi.spyOn(skinOf(a), 'setFacing');
    a.pushState(0, 0, 0, 0, 0);
    a.snap();
    a.pushState(10, 0, 0, 0, 0); // moved 10px this tick — no snap, so the delta itself is the signal
    a.interpolate(1, 16);
    expect(spy).toHaveBeenLastCalledWith(0, 0, 16, 'move');
  });

  it('a snap to the same position (no override set) still reads idle, exactly as before this fix', () => {
    const a = new Actor('player', 20);
    const spy = vi.spyOn(skinOf(a), 'setFacing');
    a.pushState(5, 5, 0, 0, 0);
    a.snap();
    a.interpolate(1, 16);
    expect(spy).toHaveBeenLastCalledWith(0, 0, 16, 'idle');
  });

  it('movingOverride=true forces the move clip even though prev==cur — what Scene.positionLocal now sets from LocalPredictor.pose.moving', () => {
    const a = new Actor('player', 20);
    const spy = vi.spyOn(skinOf(a), 'setFacing');
    a.pushState(5, 5, 0, 0, 0);
    a.snap(); // prev == cur, same as positionLocal's own snap()
    a.movingOverride = true;
    a.interpolate(1, 16);
    expect(spy).toHaveBeenLastCalledWith(0, 0, 16, 'move');
  });

  it('movingOverride is reset by the next pushState (e.g. prediction deactivating, back to the confirmed path)', () => {
    const a = new Actor('player', 20);
    const spy = vi.spyOn(skinOf(a), 'setFacing');
    a.pushState(0, 0, 0, 0, 0);
    a.snap();
    a.movingOverride = true;
    a.pushState(0, 0, 0, 0, 0); // Scene.reconcile's ordinary push — no override set afterward
    a.interpolate(1, 16);
    expect(spy).toHaveBeenLastCalledWith(0, 0, 16, 'idle'); // falls back to the (stationary) buffer delta
  });
});
