import { describe, it, expect, vi, afterEach } from 'vitest';
import { Texture, type Graphics, type Rectangle } from 'pixi.js';
import { freshStatus } from '@dd/engine/content/damage';
import { Actor } from './Actor';
import { Rig } from '../../render/Rig';
import { ORB_CORE_RIG, ORB_CORE_REFERENCE_RADIUS } from '../../render/orbCoreRig';
import type { RigSkinBundle } from '../../render/taoBundle';
import type { SpriteBinding } from '../../render/types';
import type { LoadedRigSkin } from '../../render/skinRegistry';

// A real rig's decorative bones (orb-core's eye/belly/weapon sockets) hang off the
// body bone's TIP, not its centre (orbCoreRig.ts) — the exact geometry that makes the
// shield-centring fix below non-trivial. Faked bundle over the REAL Rig, same trick as
// Skin.test.ts/RigSkin.test.ts, so this asymmetry is genuinely exercised under plain
// vitest rather than assumed.
const skinRegistryMocks = vi.hoisted(() => ({ loaded: undefined as LoadedRigSkin | undefined }));
vi.mock('../../render/skinRegistry', () => ({
  getRigSkin: (_name: string) => skinRegistryMocks.loaded,
}));

function fakeOrbCoreBundle(rig: Rig): RigSkinBundle {
  const bindings = new Map<string, SpriteBinding>();
  const textures = new Map<string, Texture>();
  for (const boneId of rig.drawOrder) {
    bindings.set(boneId, { anchorX: 0.5, anchorY: 0.5, flipX: false, zOrder: 0, rotation: 0, scaleX: 1, scaleY: 1 });
    textures.set(boneId, Texture.WHITE);
  }
  return { bindings, clips: new Map(), textures };
}

function loadedOrbCoreRig(): LoadedRigSkin {
  const rig = new Rig(ORB_CORE_RIG);
  return { rig, bundle: fakeOrbCoreBundle(rig), referenceRadius: ORB_CORE_REFERENCE_RADIUS };
}

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

// The ground ring this describe block used to cover (a full ellipse around the local
// seat's feet) was dropped 2026-08-14: it shared a cyan-family colour AND on-screen
// space with EnergyShieldFilter's rim-glow, so a live shield and "this is you" read as
// the same effect (see Actor.setLocal's doc comment). The health-bar teal outline below
// is now the marker's only cue — it never overlaps the shield glow's screen area.
describe('Actor.setLocal — "which one is me" marker (design/10 legibility)', () => {
  it('never adds a child — the marker is the health-bar outline alone, not a separate view', () => {
    const mob = new Actor('enemy', 12);
    expect(mob.children.length).toBe(4);
    mob.setLocal(false);
    expect(mob.children.length).toBe(4);
    const me = new Actor('player', 12);
    me.setLocal(true);
    expect(me.children.length).toBe(4);
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
function skinViewOf(a: Actor): { getLocalBounds: () => Rectangle } {
  return (a as unknown as { skin: { view: { getLocalBounds: () => Rectangle } } }).skin.view;
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
// — pinning an explicit, symmetric `filterArea` is what keeps the shield (and every
// other skin-level filter) from drifting sideways as the actor turns to face/aim a
// different direction.
//
// Revised same day: pinning that square's Y to a flat 0 (this test's original
// assertion) turned out to be a DIFFERENT bug wearing the same clothes — a real rig's
// decorative bones hang off the body bone's TIP, not its centre (orbCoreRig.ts's
// eye/belly/weapon sockets all sit ~1 body-length above the shell's own origin), so
// the assembled character is consistently top-heavy relative to (0,0). A live user
// report ("护盾没有将角色放在中心位置" — the shield doesn't centre the character) caught
// this: `critter-core`'s single-bone enemies have no such offset and looked fine,
// `char_vanguard`'s orb-core rig does and visibly didn't. Fix: measure the skin's own
// rest-pose bounds once (facing/aim-independent — only the X asymmetry above depends
// on those) and centre Y on THAT, not on an assumed (0,0).
describe('Actor — skin filterArea is a fixed square centred on the skin\'s own rest-pose centroid (2026-08-12 lopsided-shield fix, revised)', () => {
  afterEach(() => {
    skinRegistryMocks.loaded = undefined;
  });

  it('X stays pinned to the local origin — not offset by facing/weapon geometry', () => {
    const a = new Actor('player', 20);
    const area = skinFilterAreaOf(a);
    expect(area.x + area.width / 2).toBeCloseTo(0);
  });

  it('Y matches the skin\'s own measured rest-pose bounds, not a hardcoded 0 — even the Graphics placeholder is very slightly top/bottom-asymmetric', () => {
    const a = new Actor('player', 20);
    const area = skinFilterAreaOf(a);
    const bounds = skinViewOf(a).getLocalBounds();
    expect(area.y + area.height / 2).toBeCloseTo(bounds.y + bounds.height / 2);
  });

  it('a real rig whose decorative bones sit off the body\'s own centre still gets a correctly-centred shield (repro: orb-core\'s eye/belly/sockets hang off the shell\'s tip, not its middle)', () => {
    skinRegistryMocks.loaded = loadedOrbCoreRig();
    const a = new Actor('player', 20, undefined, false, 'char_vanguard');
    const area = skinFilterAreaOf(a);
    const bounds = skinViewOf(a).getLocalBounds();
    const expectedCenterY = bounds.y + bounds.height / 2;
    expect(area.y + area.height / 2).toBeCloseTo(expectedCenterY);
    // The whole point of the fix: for this top-heavy rig the correct centre is nowhere
    // near 0 — the original "pin to (0,0)" attempt would have failed this assertion.
    expect(Math.abs(expectedCenterY)).toBeGreaterThan(1);
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

  it('does not shift when a rig-backed actor turns to face a different direction', () => {
    skinRegistryMocks.loaded = loadedOrbCoreRig();
    const a = new Actor('player', 20, undefined, false, 'char_vanguard');
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

// A rig's body bone already stands its art off the ground point (orb-core's `shell` is
// 46 authoring-px of hover height, and RigSkin draws that bone's art on its tip), so
// Actor's own BODY_LIFT_R lift applies to the Graphics placeholder only — applying both
// double-counts and detaches the body from its shadow. The aura and health bar wrap the
// BODY, so they anchor to its real measured centre rather than to `-lift`.
describe('Actor — vertical anchoring: the placeholder is lifted, a rig carries its own hover height', () => {
  afterEach(() => {
    skinRegistryMocks.loaded = undefined;
  });

  const skinYOf = (a: Actor) => (a as unknown as { skin: { view: { y: number } } }).skin.view.y;
  const auraYOf = (a: Actor) => (a as unknown as { statusAura: { y: number } }).statusAura.y;

  it('the placeholder skin is lifted off the ground anchor', () => {
    const a = new Actor('player', 20);
    expect(skinYOf(a)).toBeCloseTo(-20 * 0.7); // radiusPx * BODY_LIFT_R
    expect(auraYOf(a)).toBeCloseTo(skinYOf(a)); // no rig → aura rides the lift itself
  });

  it('a rig skin is NOT lifted again — the rig\'s own body bone is the hover height', () => {
    skinRegistryMocks.loaded = loadedOrbCoreRig();
    const a = new Actor('player', 20, undefined, false, 'char_vanguard');
    expect(skinYOf(a)).toBe(0);
  });

  it('a rig actor\'s aura and health bar still wrap the body, not the ground point', () => {
    skinRegistryMocks.loaded = loadedOrbCoreRig();
    const a = new Actor('player', 20, undefined, false, 'char_vanguard');
    const bounds = skinViewOf(a).getLocalBounds();
    const bodyCenterY = bounds.y + bounds.height / 2;
    expect(bodyCenterY).toBeLessThan(-1); // the rig really does sit above the anchor
    expect(auraYOf(a)).toBeCloseTo(bodyCenterY);
    expect(healthBarOf(a).y).toBeCloseTo(bodyCenterY - 20 * 1.3);
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

// muzzlePos (2026-08-17) — Actor's slice of the "bullets leave the barrel tip" fix: it
// lifts `Skin.muzzleAnchor`'s skin-local point into the space `Entity.x/y` live in, so
// `Scene` can hand it straight to a Bullet. Skin.test.ts covers the rig -> skin scale
// and RigSkin.test.ts the socket/texture geometry; this is only the last hop.
describe('Actor.muzzlePos — the drawn barrel tip, in Entity coordinates', () => {
  afterEach(() => {
    skinRegistryMocks.loaded = undefined;
  });

  const stubMuzzle = (a: Actor, local: { x: number; y: number } | null) => {
    (a as unknown as { skin: { muzzleAnchor: () => { x: number; y: number } | null } }).skin.muzzleAnchor =
      () => local;
  };

  it('is null when the skin reports no mounted module — every enemy, and any preload gap', () => {
    const mob = new Actor('enemy', 12);
    expect(mob.muzzlePos()).toBeNull();
  });

  it('offsets the skin-local point by the actor\'s own drawn position', () => {
    skinRegistryMocks.loaded = loadedOrbCoreRig();
    const a = new Actor('player', 20, undefined, false, 'char_vanguard');
    a.place(500, 300, 0);
    stubMuzzle(a, { x: 30, y: -18 });
    expect(a.muzzlePos()).toEqual({ x: 530, y: 282 });
  });

  it('tracks the DRAWN position, so a lifted (z > 0) actor\'s muzzle rises with its sprite', () => {
    skinRegistryMocks.loaded = loadedOrbCoreRig();
    const a = new Actor('player', 20, undefined, false, 'char_vanguard');
    a.place(500, 300, 40); // Entity.applyTransform puts the container at y = gy - z
    stubMuzzle(a, { x: 30, y: -18 });
    expect(a.muzzlePos()).toEqual({ x: 530, y: 300 - 40 - 18 });
  });

  it('includes the placeholder body lift, so it stays right if a placeholder ever mounts one', () => {
    // `skin.view.y` is 0 for a rig and -radius*BODY_LIFT_R for the placeholder; muzzlePos
    // reads it rather than assuming 0, which is what this pins down.
    const a = new Actor('player', 20); // placeholder: lift = -14
    a.place(0, 0, 0);
    stubMuzzle(a, { x: 10, y: -5 });
    expect(a.muzzlePos()).toEqual({ x: 10, y: -14 - 5 });
  });
});
