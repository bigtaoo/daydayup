/**
 * Scene.reconcile — the render-side mirror of engine state. Covers the two facing angles
 * it computes for the player view: `facingRad` (the weapon) is exactly the engine's
 * aim-derived `PlayerActor.facing`, and `bodyFacingRad` (the body/eye) TURNS TOWARD that
 * same aim at a bounded rate (`render/facing.ts`'s `turnToward`). It used to track the
 * player's velocity instead — a humanoid upper/lower-body split, replaced 2026-08-18
 * because the orb-core has no lower body. Enemies/bullets are unaffected — they keep a
 * single facing.
 */
import type { Graphics } from 'pixi.js';
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
import { BODY_TURN_PER_TICK } from '../../render/facing';
import type { Actor } from './Actor';
import type { Entity } from './Entity';

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
}));

const CFG = { seed: 1, worldW: 800, worldH: 600, waves: [] as const };

function addEnemy(s: GameState, xpx: number, ypx: number, facing: Brad): EnemyActor {
  const e: EnemyActor = {
    id: s.nextId(), faction: 'enemy', teamId: ENEMY_TEAM_ID,
    gx: pxToFp(xpx), gy: pxToFp(ypx), z: toFp(0), vx: toFp(0), vy: toFp(0),
    knockVx: toFp(0), knockVy: toFp(0),
    facing, hp: BASIC_ENEMY.maxHp, maxHp: BASIC_ENEMY.maxHp,
    shield: 0, maxShield: 0, ticksSinceHit: 0,
    radius: BASIC_ENEMY.radius, footprintRadius: BASIC_ENEMY.footprintRadius, solidRadius: BASIC_ENEMY.footprintRadius,
    alive: true, weapon: null, firing: false, status: freshStatus(), enraged: false, aggroed: false,
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

// The body used to face the MOVEMENT vector (a humanoid upper/lower split). Since
// 2026-08-18 it turns toward the AIM, rate-limited — the orb-core is an eye, and an eye
// looks at what it shoots (design/12/13, render/facing.ts's header).
describe('Scene.reconcile — body turns toward the aim', () => {
  it('faces the aim, not the movement direction', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const p = s.players[0]!;
    p.facing = 0 as Brad; // aim east
    p.vx = toFp(0);
    p.vy = toFp(-1); // moving north (up-screen, negative y)
    const scene = new Scene(new Layers());
    scene.reconcile(s, p.id);
    const view = scene.player!;
    expect(view.facingRad).toBeCloseTo(0, 5);
    expect(view.bodyFacingRad).toBeCloseTo(0, 5); // the aim, NOT atan2(vy, vx) = -PI/2
  });

  it('a fresh spawn starts already facing its aim (nothing to turn from)', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const p = s.players[0]!;
    p.facing = 16384 as Brad; // aim north
    const scene = new Scene(new Layers());
    scene.reconcile(s, p.id);
    expect(scene.player!.bodyFacingRad).toBeCloseTo(bradToRad(16384), 5);
  });

  it('turns by at most BODY_TURN_PER_TICK per tick, and arrives after enough of them', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const p = s.players[0]!;
    p.facing = 0 as Brad; // spawn aiming east
    const scene = new Scene(new Layers());
    scene.reconcile(s, p.id);
    expect(scene.player!.bodyFacingRad).toBeCloseTo(0, 5);

    p.facing = 16384 as Brad; // aim snaps 90° north (auto-aim switching target)
    scene.reconcile(s, p.id);
    // One tick moves exactly one step — NOT the whole 90°, which is the twitch this fixes.
    expect(Math.abs(scene.player!.bodyFacingRad)).toBeCloseTo(BODY_TURN_PER_TICK, 5);
    expect(scene.player!.facingRad).toBeCloseTo(bradToRad(16384), 5); // the weapon aim did snap

    // PI/2 / 0.27 ≈ 5.8 steps; 6 more ticks is comfortably enough to land exactly.
    for (let i = 0; i < 6; i++) scene.reconcile(s, p.id);
    expect(scene.player!.bodyFacingRad).toBeCloseTo(bradToRad(16384), 5);
  });
});

// ROADMAP: fixes the local player's walk animation never playing under online
// prediction — `positionLocal`'s snap() collapses prev onto cur every render frame, so
// Actor.interpolate's default curX/prevX-delta heuristic would always read "stationary"
// for the predicted local view. `moving` is threaded straight to `Entity.movingOverride`.
describe('Scene.positionLocal — moving flag survives the predicted-pose snap', () => {
  it('sets movingOverride from its `moving` argument (default false)', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const scene = new Scene(new Layers());
    scene.reconcile(s, s.players[0]!.id);

    scene.positionLocal(10, 10, 0, 0, true);
    expect(scene.player!.movingOverride).toBe(true);

    scene.positionLocal(10, 10, 0, 0, false);
    expect(scene.player!.movingOverride).toBe(false);

    scene.positionLocal(10, 10, 0, 0);
    expect(scene.player!.movingOverride).toBe(false); // omitted → defaults to idle, not "derive from buffer"
  });

  it('the very next reconcile() (a normal confirmed pushState) resets movingOverride to null again', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const scene = new Scene(new Layers());
    scene.reconcile(s, s.players[0]!.id);
    scene.positionLocal(10, 10, 0, 0, true);
    expect(scene.player!.movingOverride).toBe(true);

    scene.reconcile(s, s.players[0]!.id); // e.g. prediction deactivated — back to the confirmed path
    expect(scene.player!.movingOverride).toBeNull();
  });

  // The predicted-pose path runs at RENDER rate, so it must not re-derive body facing —
  // that would turn the body twice as fast as `reconcile`'s per-tick step (and, before
  // 2026-08-18, is where the predictor's movement direction leaked back in).
  it('carries the body facing reconcile() already set, instead of resetting it to the aim', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const p = s.players[0]!;
    p.facing = 0 as Brad;
    const scene = new Scene(new Layers());
    scene.reconcile(s, p.id); // spawns body-facing east
    p.facing = 16384 as Brad; // aim jumps north
    scene.reconcile(s, p.id); // one step of turn
    const afterOneStep = scene.player!.bodyFacingRad;

    scene.positionLocal(10, 10, 0, bradToRad(16384), true);
    expect(scene.player!.bodyFacingRad).toBeCloseTo(afterOneStep, 5); // NOT the aim
  });

  it('is a no-op before the local view exists (no crash)', () => {
    const scene = new Scene(new Layers());
    expect(() => scene.positionLocal(0, 0, 0, 0, true)).not.toThrow();
  });
});

describe('Scene.reconcile — local-seat marker (design/10 legibility)', () => {
  // The marker is now the health-bar teal outline alone (Actor.setLocal dropped the
  // separate ground ring 2026-08-14 — see design/10/ROADMAP), driven by Actor's private
  // `isLocal` flag; reach into it the same way Actor.test.ts does for other private state.
  function isLocal(view: unknown): boolean {
    return (view as { isLocal: boolean }).isLocal;
  }

  it('marks only the named local seat, not the other players', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }, { start: [200, 100] }] });
    const [me, other] = s.players;
    const scene = new Scene(new Layers());

    scene.reconcile(s, me!.id);

    const views = (scene as unknown as { views: Map<number, unknown> }).views;
    expect(isLocal(views.get(me!.id))).toBe(true);
    expect(isLocal(views.get(other!.id))).toBe(false);
  });

  it('keeps the single-player default (no localPlayerId) marked across later reconciles', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const scene = new Scene(new Layers());

    scene.reconcile(s);
    scene.reconcile(s); // the sticky-choice path: playerView is already set by now

    const views = (scene as unknown as { views: Map<number, unknown> }).views;
    expect(isLocal(views.get(s.players[0]!.id))).toBe(true);
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

describe('Scene.enemies — every live enemy view (occlusion x-ray, GameLoop.updateFx)', () => {
  it('returns every live enemy, and excludes the player', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const e1 = addEnemy(s, 300, 300, 0 as Brad);
    const e2 = addEnemy(s, 400, 400, 0 as Brad);
    const scene = new Scene(new Layers());
    scene.reconcile(s);

    expect(scene.enemies.length).toBe(2);
    expect(scene.enemies).not.toContain(scene.player);
    // Order isn't meaningful, so compare against the actual views rather than array identity.
    expect(scene.enemies).toContain(scene.actorAt(e1.id));
    expect(scene.enemies).toContain(scene.actorAt(e2.id));
  });

  it('is empty when the room has no enemies', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const scene = new Scene(new Layers());
    scene.reconcile(s);
    expect(scene.enemies).toEqual([]);
  });

  it('excludes bullets and pickups — only Actor (player/enemy) views count', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    addEnemy(s, 300, 300, 0 as Brad);
    addBullet(s, 50, 50);
    addPickup(s, 60, 60);
    const scene = new Scene(new Layers());
    scene.reconcile(s);
    expect(scene.enemies.length).toBe(1);
  });

  it('drops an enemy the tick it dies — a dissolving view is not a live one to protect', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const enemy = addEnemy(s, 300, 300, 0 as Brad);
    const scene = new Scene(new Layers());
    scene.reconcile(s);
    expect(scene.enemies.length).toBe(1);

    enemy.alive = false;
    scene.reconcile(s);
    expect(scene.enemies).toEqual([]);
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

  it('a new bullet is DRAWN leaving the shooter\'s muzzle, easing onto the engine position', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const p = s.players[0]!;
    const scene = new Scene(new Layers());
    scene.reconcile(s, p.id); // the shooter's view has to exist before its bullet does
    // The placeholder skin these tests build has no rig-mounted module, so stub the
    // muzzle the way a preloaded weapon texture would report it: 30px right of and 8px
    // above where the engine spawns the round.
    scene.actorAt(p.id)!.muzzlePos = () => ({ x: 330, y: 292 });

    const bullet = addBullet(s, 300, 300); // z 0, so the drawn sim position is (300, 300)
    bullet.ownerId = p.id;
    scene.reconcile(s, p.id);
    const view = (scene as unknown as { views: Map<number, Entity> }).views.get(bullet.id)!;

    // The engine's own position is untouched — only the drawn one is corrected.
    expect(view.curX).toBe(300);
    expect(view.curY).toBe(300);

    scene.interpolate(1, 0); // first drawn frame: fully at the muzzle
    expect(view.x).toBeCloseTo(330, 5);
    expect(view.y).toBeCloseTo(292, 5);

    scene.interpolate(1, 60); // halfway through the 120ms ease: 0.5^2 of the offset left
    expect(view.x).toBeCloseTo(300 + 30 * 0.25, 5);
    expect(view.y).toBeCloseTo(300 - 8 * 0.25, 5);

    scene.interpolate(1, 120); // past it: exactly the engine position from here on
    expect(view.x).toBeCloseTo(300, 5);
    expect(view.y).toBeCloseTo(300, 5);
  });

  it('a bullet whose shooter reports no muzzle is drawn at the engine position from frame one (every enemy)', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const enemy = addEnemy(s, 200, 200, 0 as Brad);
    const scene = new Scene(new Layers());
    scene.reconcile(s);
    const bullet = addBullet(s, 300, 300);
    bullet.ownerId = enemy.id; // a critter-core enemy: muzzlePos() is null for it
    scene.reconcile(s);

    const view = (scene as unknown as { views: Map<number, Entity> }).views.get(bullet.id)!;
    scene.interpolate(1, 0);
    expect(view.x).toBe(300);
    expect(view.y).toBe(300);
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

/**
 * Health bars ride `layers.hud`, not the Actor's own container (2026-08-21, live report
 * *"血条被墙挡住了"* — `scene/occlusion.ts`'s cap-only fade keeps a near-white BODY legible but
 * washes the bar's own dark contour/track into the same luma band as the wall behind it).
 * `Actor.ts` owns the position sync (`applyTransform`) and teardown (`destroy`); this covers
 * the half only `Scene` can see — that `spawn()` actually mounts it there for both factions,
 * keeps tracking it, and cleans it up on every removal path (immediate and dissolve-delayed).
 */
describe('Scene.spawn — the health bar rides layers.hud, never the actor\'s own container', () => {
  it('mounts a player\'s health bar on layers.hud, not as a child of the actor view', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const p = s.players[0]!;
    const layers = new Layers();
    const scene = new Scene(layers);
    scene.reconcile(s, p.id);
    const view = scene.player!;
    expect(layers.hud.children).toContain(view.healthBar);
    expect(view.children).not.toContain(view.healthBar);
  });

  it('mounts an enemy\'s health bar on layers.hud too', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    addEnemy(s, 300, 300, 0 as Brad);
    const layers = new Layers();
    const scene = new Scene(layers);
    scene.reconcile(s);
    const view = (scene as unknown as { views: Map<number, Actor> }).views.get(s.enemies[0]!.id)!;
    expect(layers.hud.children).toContain(view.healthBar);
  });

  it('keeps the bar tracking the actor across ticks, offset from its own screen position', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const p = s.players[0]!;
    const scene = new Scene(new Layers());
    scene.reconcile(s, p.id);
    const view = scene.player!;
    scene.interpolate(1, 0);
    const offset = view.healthBar!.y - view.y;

    p.gx = pxToFp(250);
    p.gy = pxToFp(180);
    scene.reconcile(s, p.id);
    scene.interpolate(1, 0);
    expect(view.healthBar!.x).toBeCloseTo(view.x, 5);
    expect(view.healthBar!.y - view.y).toBeCloseTo(offset, 5); // same offset, new position
  });

  it('destroys and detaches the health bar when a bar-less view is torn down outright (bullet)', () => {
    // Not an Actor at all — confirms `spawn()`'s `instanceof Actor` guard doesn't choke on a
    // view with no `healthBar`.
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const bullet = addBullet(s, 300, 300);
    const layers = new Layers();
    const scene = new Scene(layers);
    expect(() => scene.reconcile(s)).not.toThrow();
    bullet.alive = false;
    expect(() => scene.reconcile(s)).not.toThrow();
  });

  it('detaches the health bar from layers.hud once a dissolving enemy actually finishes destroying', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const enemy = addEnemy(s, 300, 300, 0 as Brad);
    const layers = new Layers();
    const scene = new Scene(layers);
    scene.reconcile(s);
    const view = (scene as unknown as { views: Map<number, Actor> }).views.get(enemy.id)!;
    const bar = view.healthBar!;
    expect(layers.hud.children).toContain(bar);

    enemy.alive = false;
    scene.reconcile(s); // queued to dissolve, not destroyed yet — bar stays mounted
    expect(layers.hud.children).toContain(bar);

    scene.interpolate(1, 700); // finishes the dissolve → Actor.destroy()
    expect(layers.hud.children).not.toContain(bar);
  });

  it('clear() also detaches every still-mounted health bar (live views and dissolving ones)', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const live = addEnemy(s, 300, 300, 0 as Brad);
    const dying = addEnemy(s, 400, 300, 0 as Brad);
    const layers = new Layers();
    const scene = new Scene(layers);
    scene.reconcile(s);
    dying.alive = false;
    scene.reconcile(s);
    expect(layers.hud.children.length).toBe(3); // the fixture's own player + both enemies

    scene.clear();
    expect(layers.hud.children.length).toBe(0);
    void live; // only needed to keep the fixture's second enemy alive through the reconcile above
  });
});

// `Scene.applyLighting` is gone (2026-08-24). Shading a scene is no longer something the
// scene graph does per Actor — it is one screen-space pass over `Layers.lit`, driven from
// `FxController.updateCamera`, and its coverage lives in FxController.test.ts. What remains
// worth pinning HERE is the consequence for an Actor's own filter list: a plain actor now
// carries no filter at all, where it used to always carry the lit one.
function skinFiltersOf(a: Actor): unknown[] {
  return ((a as unknown as { skin: { view: { filters: unknown[] | null } } }).skin.view.filters ?? []);
}

/**
 * The batching half of the same "does it batch with its neighbours" question the filter tests below
 * ask (2026-08-24 draw-call pass). `RoomBuilder.test.ts` sweeps `layers.shadow` after a room build,
 * which covers the wall/pillar/prop shadows — but a player's, an enemy's and a bullet's shadow are
 * all mounted by `Scene.spawn`, so nothing over there can see them. On the measured start room those
 * were 22 of 165 draw calls, one per shadow, purely because a nested-ellipse penumbra is past Pixi's
 * 400-float auto-batch cutoff.
 */
describe('Scene.spawn — every shadow it mounts is batched', () => {
  it('batches the shadow of a player, an enemy and a bullet alike', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    addEnemy(s, 300, 300, 0 as Brad);
    addBullet(s, 200, 200);
    const layers = new Layers();
    new Scene(layers).reconcile(s, s.players[0]!.id);
    const shadows = layers.shadow.children.filter(
      (c): c is Graphics => (c as Graphics).context !== undefined,
    );
    // Three distinct spawn paths, so a fix applied to only one of them fails here.
    expect(shadows.length).toBeGreaterThanOrEqual(3);
    for (const g of shadows) expect(g.context.batchMode).toBe('batch');
  });

  it('keeps batching them as the cast changes, not just on the first reconcile', () => {
    // A later spawn goes through the same `spawn()` call, but a future refactor that built the
    // first frame's views differently (a warm-up path, a pool) could easily miss it.
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const layers = new Layers();
    const scene = new Scene(layers);
    scene.reconcile(s, s.players[0]!.id);
    const before = layers.shadow.children.length;
    addEnemy(s, 400, 400, 0 as Brad);
    scene.reconcile(s, s.players[0]!.id);
    expect(layers.shadow.children.length).toBeGreaterThan(before);
    for (const c of layers.shadow.children) {
      const g = c as Graphics;
      if (g.context) expect(g.context.batchMode).toBe('batch');
    }
  });
});

describe('Scene — actors carry no lighting filter of their own any more', () => {
  it('leaves a player carrying only its own shield glow — no lighting filter underneath it', () => {
    // The launch characters all have a shield pool, so the ONE filter here is the shield's.
    // Before this change there were two, and the lit one was on every actor unconditionally.
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const scene = new Scene(new Layers());
    scene.reconcile(s);
    expect(skinFiltersOf(scene.player!).map((f) => (f as object).constructor.name)).toEqual(['EnergyShieldFilter']);
  });

  it('spawns a shieldless enemy with NO filters at all, so it batches with its neighbours', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const enemy = addEnemy(s, 300, 300, 0 as Brad);
    const scene = new Scene(new Layers());
    scene.reconcile(s);
    expect(skinFiltersOf(scene.actorAt(enemy.id)!)).toEqual([]);
  });
});

// `render/weaponSkins` is mocked here so the "texture exists" branch is reachable
// under vitest (no art preloaded in a plain-node run) — same convention as
// Pickup.test.ts's own mock of the same module.
const weaponSkinMocks = vi.hoisted(() => ({ texture: undefined as unknown }));
vi.mock('../../render/weaponSkins', () => ({
  getWeaponTexture: (name: string | undefined) => (name === 'blaster' ? weaponSkinMocks.texture : undefined),
}));

describe('Scene.reconcile — weapon pickup id passthrough (design/03)', () => {
  it('passes the PickupItem.weaponId through to the Pickup view (real icon, not the chevron fallback)', async () => {
    const { Texture, TextureSource } = await import('pixi.js');
    weaponSkinMocks.texture = new Texture({ source: new TextureSource({ width: 8, height: 8 }) });
    try {
      const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
      const it: PickupItem = {
        id: s.nextId(), kind: 'weapon', gx: pxToFp(300), gy: pxToFp(300),
        spawnTick: 0, alive: true, weaponId: 'blaster',
      };
      s.pickups.push(it);
      const scene = new Scene(new Layers());
      scene.reconcile(s);

      const views = (scene as unknown as { views: Map<number, { children: unknown[] }> }).views;
      const view = views.get(it.id)!;
      // The claim is "the id reached the view and resolved a real texture", so assert THAT —
      // the drop's child count also moves whenever the drop gains a layer (it gained the
      // rarity/element overlays in 2026-08-25), and a count would fail for the wrong reason.
      const { Sprite } = await import('pixi.js');
      const icon = view.children.find((c): c is InstanceType<typeof Sprite> => c instanceof Sprite);
      expect(icon).toBeDefined();
      expect(icon!.texture).toBe(weaponSkinMocks.texture);
    } finally {
      weaponSkinMocks.texture = undefined;
    }
  });

  it('falls back to the chevron shape when the pickup has no weaponId', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const it: PickupItem = {
      id: s.nextId(), kind: 'weapon', gx: pxToFp(300), gy: pxToFp(300),
      spawnTick: 0, alive: true,
    };
    s.pickups.push(it);
    const scene = new Scene(new Layers());
    scene.reconcile(s);

    const views = (scene as unknown as { views: Map<number, { children: unknown[] }> }).views;
    expect(views.get(it.id)!.children.length).toBe(2); // glow + chevron, no icon sprite
  });
});

describe('Scene.reconcile — pickup hover phase passthrough (strobe fix, 2026-08-15)', () => {
  // Pickup derives its hover's start phase from the engine id it is handed, so a pile of
  // drops doesn't rise and fall in lockstep (which is what made a whole floor of loot read
  // as one flicker). That only works if reconcile actually passes the id down — forgetting
  // it silently defaults every view to phase 0, i.e. right back to lockstep.
  it('gives drops reconciled from the same state different hover phases', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }] });
    const items = [addPickup(s, 300, 300), addPickup(s, 340, 300), addPickup(s, 380, 300)];
    const scene = new Scene(new Layers());
    scene.reconcile(s);

    const views = (scene as unknown as { views: Map<number, Entity> }).views;
    const heights = items.map((it) => {
      const v = views.get(it.id)!;
      v.interpolate(1, 16);
      return Math.round((v.curY - v.y) * 100) / 100; // hover height (Entity writes y = groundY - z)
    });
    expect(new Set(heights).size).toBe(heights.length);
  });
});
