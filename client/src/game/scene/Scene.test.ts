/**
 * Scene.reconcile — the render-side mirror of engine state. Covers the two facing angles
 * it computes for the player view: `facingRad` (the weapon) is exactly the engine's
 * aim-derived `PlayerActor.facing`, and `bodyFacingRad` (the body/eye) TURNS TOWARD that
 * same aim at a bounded rate (`render/facing.ts`'s `turnToward`). It used to track the
 * player's velocity instead — a humanoid upper/lower-body split, replaced 2026-08-18
 * because the orb-core has no lower body. Enemies/bullets are unaffected — they keep a
 * single facing.
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
import { BODY_TURN_PER_TICK } from '../../render/facing';
import { LightRegistry } from '../fx/lighting';
import type { Actor } from './Actor';
import type { Entity } from './Entity';

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
      expect(view.children.length).toBe(3); // glow + real icon sprite + empty chevron Graphics
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
