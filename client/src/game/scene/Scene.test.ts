/**
 * Scene.reconcile — the render-side mirror of engine state. Covers the upper/lower
 * body split it now computes for the player view: `bodyFacingRad` (legs/body) tracks
 * the player's own velocity, held at its last value while idle (same "no snap-to-zero"
 * convention CommandBuilder already used for the aim stick), while `facingRad` (the
 * weapon) stays exactly the engine's aim-derived `PlayerActor.facing`, unaffected by
 * movement. Enemies/bullets are unaffected — they keep a single facing.
 */
import { describe, it, expect, vi } from 'vitest';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import { pxToFp } from '@dd/engine/content/convert';
import { freshStatus } from '@dd/engine/content/damage';
import { BASIC_ENEMY } from '@dd/engine/content/enemies';
import { toFp } from '@dd/engine/math/fixed';
import type { Brad } from '@dd/engine/math/trig';
import { ENEMY_TEAM_ID, type EnemyActor, type Projectile, type PickupItem } from '@dd/engine/state/entities';
import { Scene } from './Scene';
import { Layers } from './layers';
import { bradToRad } from '../coords';
import { LightRegistry } from '../fx/lighting';
import type { Actor } from './Actor';

function litFilterOf(a: Actor): { dirX: number; dirY: number; intensity: number } {
  return (a as unknown as { litFilter: { dirX: number; dirY: number; intensity: number } }).litFilter;
}

// EnergyShieldFilter/OutlineFilter/DissolveFilter (Actor's setShield/hitFlash/
// startDissolve) all build a real WebGL GlProgram at construction time — unavailable
// under plain vitest, same reason Actor.test.ts/FxController.test.ts stub fx/filters.ts.
vi.mock('../fx/filters', () => ({
  EnergyShieldFilter: class {
    intensity = 0;
    tick() {}
  },
  OutlineFilter: class {
    alpha = 0;
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

const CFG = { seed: 1, worldW: 800, worldH: 600, waves: [] as const };

function addEnemy(s: GameState, xpx: number, ypx: number, facing: Brad): EnemyActor {
  const e: EnemyActor = {
    id: s.nextId(), faction: 'enemy', teamId: ENEMY_TEAM_ID,
    gx: pxToFp(xpx), gy: pxToFp(ypx), z: toFp(0), vx: toFp(0), vy: toFp(0),
    knockVx: toFp(0), knockVy: toFp(0),
    facing, hp: BASIC_ENEMY.maxHp, maxHp: BASIC_ENEMY.maxHp,
    shield: 0, maxShield: 0, ticksSinceHit: 0,
    radius: BASIC_ENEMY.radius, footprintRadius: BASIC_ENEMY.footprintRadius,
    alive: true, weapon: null, firing: false, status: freshStatus(), enraged: false,
  };
  s.enemies.push(e);
  return e;
}

function addBullet(s: GameState, xpx: number, ypx: number): Projectile {
  const b: Projectile = {
    id: s.nextId(), faction: 'enemy', teamId: ENEMY_TEAM_ID,
    gx: pxToFp(xpx), gy: pxToFp(ypx), z: toFp(0), vx: toFp(1), vy: toFp(0),
    radius: toFp(4), damage: 1, damageType: 'physical', lifeTicks: 60, alive: true,
  };
  s.projectiles.push(b);
  return b;
}

function addPickup(s: GameState, xpx: number, ypx: number): PickupItem {
  const it: PickupItem = {
    id: s.nextId(), kind: 'material', gx: pxToFp(xpx), gy: pxToFp(ypx),
    spawnTick: 0, alive: true, materialId: 'fire', qty: 1,
  };
  s.pickups.push(it);
  return it;
}

describe('Scene.reconcile — player body/aim facing split', () => {
  it('body faces the movement direction while moving; aim stays the manual facing', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const p = s.players[0]!;
    p.facing = 0 as Brad; // aim east
    p.vx = toFp(0);
    p.vy = toFp(-1); // moving north (up-screen, negative y)
    const scene = new Scene(new Layers());
    scene.reconcile(s, p.id);
    const view = scene.player!;
    expect(view.facingRad).toBeCloseTo(0, 5);
    expect(view.bodyFacingRad).toBeCloseTo(Math.atan2(p.vy, p.vx), 5);
  });

  it('holds the last body facing while idle instead of resetting (no snap-to-zero)', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const p = s.players[0]!;
    const scene = new Scene(new Layers());

    p.facing = 0 as Brad; // aim east
    p.vx = toFp(1);
    p.vy = toFp(0); // moving east
    scene.reconcile(s, p.id);
    const bodyWhileMoving = scene.player!.bodyFacingRad;

    p.facing = 32768 as Brad; // aim flips to west, but movement stops
    p.vx = toFp(0);
    p.vy = toFp(0);
    scene.reconcile(s, p.id);
    expect(scene.player!.facingRad).toBeCloseTo(Math.PI, 5); // aim followed the flip
    expect(scene.player!.bodyFacingRad).toBeCloseTo(bodyWhileMoving, 5); // body held its last direction
  });

  it('a fresh spawn with no movement yet starts body-facing its aim direction', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const p = s.players[0]!;
    p.facing = 16384 as Brad; // aim north, never moved
    const scene = new Scene(new Layers());
    scene.reconcile(s, p.id);
    expect(scene.player!.bodyFacingRad).toBeCloseTo(bradToRad(16384), 5);
  });
});

describe('Scene.reconcile — local-seat marker (design/10 legibility)', () => {
  function ringWidth(view: unknown): number {
    return ((view as { children: Array<{ getLocalBounds(): { width: number } }> }).children[4]?.getLocalBounds()
      .width) ?? 0;
  }

  it('marks only the named local seat, not the other players', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }, { start: [200, 100] }] });
    const [me, other] = s.players;
    const scene = new Scene(new Layers());

    scene.reconcile(s, me!.id);

    const views = (scene as unknown as { views: Map<number, unknown> }).views;
    expect(ringWidth(views.get(me!.id))).toBeGreaterThan(0);
    expect(ringWidth(views.get(other!.id))).toBe(0);
  });

  it('keeps the single-player default (no localPlayerId) marked across later reconciles', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const scene = new Scene(new Layers());

    scene.reconcile(s);
    scene.reconcile(s); // the sticky-choice path: playerView is already set by now

    const views = (scene as unknown as { views: Map<number, unknown> }).views;
    expect(ringWidth(views.get(s.players[0]!.id))).toBeGreaterThan(0);
    expect(scene.player).toBe(views.get(s.players[0]!.id));
  });
});

describe('Scene.reconcile — enemies keep a single facing (no body/aim split)', () => {
  it("an enemy's view bodyFacingRad always equals its facingRad", () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const enemy = addEnemy(s, 300, 300, 16384 as Brad);
    const scene = new Scene(new Layers());
    scene.reconcile(s);
    const views = (scene as unknown as { views: Map<number, { facingRad: number; bodyFacingRad: number }> }).views;
    const view = views.get(enemy.id);
    expect(view).toBeDefined();
    expect(view!.bodyFacingRad).toBe(view!.facingRad);
    expect(view!.facingRad).toBeCloseTo(bradToRad(16384), 5);
  });
});

describe('Scene.actorAt — actor-lookup by id (EventReactor hit-flash, design/01 milestone 5)', () => {
  it('resolves a live enemy/player id to its Actor view', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const enemy = addEnemy(s, 300, 300, 0 as Brad);
    const scene = new Scene(new Layers());
    scene.reconcile(s);
    expect(scene.actorAt(enemy.id)).toBeDefined();
    expect(scene.actorAt(s.players[0]!.id)).toBeDefined();
  });

  it('is undefined for an id with no view (bullet/pickup ids, or one never spawned)', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const scene = new Scene(new Layers());
    scene.reconcile(s);
    expect(scene.actorAt(999999)).toBeUndefined();
  });
});

describe('Scene.reconcile — death-dissolve lingering view (design/01 fidelity roadmap milestone 5)', () => {
  it('keeps a dead enemy\'s view around (dissolving) instead of destroying it the same tick', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const enemy = addEnemy(s, 300, 300, 0 as Brad);
    const scene = new Scene(new Layers());
    scene.reconcile(s);
    const views = (scene as unknown as { views: Map<number, unknown> }).views;
    expect(views.has(enemy.id)).toBe(true);

    enemy.alive = false;
    scene.reconcile(s);
    // Gone from the live-views map (a fresh reconcile shouldn't try to push new state
    // into it), but not actually torn down yet — it's dissolving.
    expect(views.has(enemy.id)).toBe(false);
    const dying = (scene as unknown as { dying: Array<{ isDissolved: boolean }> }).dying;
    expect(dying.length).toBe(1);
    expect(dying[0].isDissolved).toBe(false);
  });

  it('destroys the dying view once its dissolve finishes interpolating', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const enemy = addEnemy(s, 300, 300, 0 as Brad);
    const scene = new Scene(new Layers());
    scene.reconcile(s);
    enemy.alive = false;
    scene.reconcile(s);

    scene.interpolate(1, 700); // the full 700ms dissolve duration in one step
    const dying = (scene as unknown as { dying: unknown[] }).dying;
    expect(dying.length).toBe(0);
  });

  it('clear() tears down any still-dissolving views along with the live ones', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const enemy = addEnemy(s, 300, 300, 0 as Brad);
    const scene = new Scene(new Layers());
    scene.reconcile(s);
    enemy.alive = false;
    scene.reconcile(s);

    expect(() => scene.clear()).not.toThrow();
    const dying = (scene as unknown as { dying: unknown[] }).dying;
    expect(dying.length).toBe(0);
  });

  it("a dead LOCAL player also dissolves, and playerView clears immediately (not after the dissolve)", () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const p = s.players[0]!;
    const scene = new Scene(new Layers());
    scene.reconcile(s, p.id);
    expect(scene.player).not.toBeNull();

    p.alive = false;
    scene.reconcile(s, p.id);
    // The camera should stop following a dead player right away — it shouldn't wait
    // for the lingering dissolve view to finish playing out.
    expect(scene.player).toBeNull();
    const dying = (scene as unknown as { dying: Array<{ isDissolved: boolean }> }).dying;
    expect(dying.length).toBe(1);
    expect(dying[0].isDissolved).toBe(false);
  });

  it('a removed bullet is destroyed immediately — no dissolve for non-Actor views', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const bullet = addBullet(s, 300, 300);
    const scene = new Scene(new Layers());
    scene.reconcile(s);
    const views = (scene as unknown as { views: Map<number, unknown> }).views;
    expect(views.has(bullet.id)).toBe(true);

    bullet.alive = false;
    scene.reconcile(s);
    expect(views.has(bullet.id)).toBe(false);
    const dying = (scene as unknown as { dying: unknown[] }).dying;
    expect(dying.length).toBe(0); // gone outright, not queued to dissolve
  });

  it('a collected pickup is destroyed immediately — no dissolve for non-Actor views', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const pickup = addPickup(s, 300, 300);
    const scene = new Scene(new Layers());
    scene.reconcile(s);

    pickup.alive = false;
    scene.reconcile(s);
    const dying = (scene as unknown as { dying: unknown[] }).dying;
    expect(dying.length).toBe(0);
  });

  it('two enemies dying the same tick both dissolve independently — no array-splice off-by-one', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const a = addEnemy(s, 300, 300, 0 as Brad);
    const b = addEnemy(s, 400, 300, 0 as Brad);
    const scene = new Scene(new Layers());
    scene.reconcile(s);

    a.alive = false;
    b.alive = false;
    scene.reconcile(s);
    const dying = (scene as unknown as { dying: Array<{ isDissolved: boolean }> }).dying;
    expect(dying.length).toBe(2);

    // Finish only enough of the dissolve for both to complete, one interpolate() call —
    // exercises the reverse-iterating splice loop with more than one entry at once.
    scene.interpolate(1, 700);
    expect(dying.length).toBe(0);
  });
});

describe('Scene.applyLighting — dynamic point lighting (design/01 fidelity roadmap milestone 2)', () => {
  it('shades a live Actor (player) against the strongest nearby light', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const scene = new Scene(new Layers());
    scene.reconcile(s);

    const lights = new LightRegistry();
    lights.addPersistent('a', { x: 150, y: 100, color: 0x66e0ff, radius: 200, intensity: 1 });
    scene.applyLighting(lights);

    expect(litFilterOf(scene.player!).intensity).toBeGreaterThan(0);
  });

  it('shades enemies too, not just the player (Enemy extends Actor)', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const enemy = addEnemy(s, 300, 300, 0 as Brad);
    const scene = new Scene(new Layers());
    scene.reconcile(s);

    const lights = new LightRegistry();
    lights.addPersistent('a', { x: 310, y: 300, color: 0xff8844, radius: 200, intensity: 1 });
    scene.applyLighting(lights);

    const view = scene.actorAt(enemy.id)!;
    expect(litFilterOf(view).intensity).toBeGreaterThan(0);
  });

  it('clears the point term when nothing is close enough to matter', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const scene = new Scene(new Layers());
    scene.reconcile(s);

    const lights = new LightRegistry();
    lights.addPersistent('far', { x: 100000, y: 100000, color: 0xffffff, radius: 50, intensity: 1 });
    scene.applyLighting(lights);

    expect(litFilterOf(scene.player!).intensity).toBe(0);
  });

  it('leaves bullets/pickups alone — only Actor views (player/enemy) get shaded', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    addBullet(s, 300, 300);
    addPickup(s, 300, 300);
    const scene = new Scene(new Layers());
    scene.reconcile(s);

    const lights = new LightRegistry();
    lights.addPersistent('a', { x: 300, y: 300, color: 0xffffff, radius: 200, intensity: 1 });
    // Would throw if it ever tried to read `.litFilter` off a Bullet/Pickup view.
    expect(() => scene.applyLighting(lights)).not.toThrow();
  });
});
