import { describe, it, expect } from 'vitest';
import { toFp, addFp, isqrt } from '@dd/engine/math/fixed';
import type { Fp } from '@dd/engine/math/fixed';
import type { Brad } from '@dd/engine/math/trig';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import { ENEMY_TEAM_ID, type EnemyActor, type Faction, type Projectile } from '@dd/engine/state/entities';
import { makeWeapon, SABER_SIM } from '@dd/engine/content/weapons';
import { freshStatus } from '@dd/engine/content/damage';
import { PLAYER_BASE } from '@dd/engine/content/players';
import { resolveSkin } from '@dd/engine/content/skins';
import { BASIC_ENEMY } from '@dd/engine/content/enemies';

// The default character's defensive stats (systems tests spawn the default player).
const DEFAULT_SKIN = resolveSkin();
import { pxToFp } from '@dd/engine/content/convert';
import {
  DeathDropsSystem,
  DeflectSystem,
  HitResolveSystem,
  MovementSystem,
  PickupSystem,
  ProjectileStepSystem,
} from '@dd/engine/systems';

const CFG = { seed: 7, worldW: 1600, worldH: 1200, waves: [] as const };

function state(): GameState {
  return createGameState(CFG);
}

function addEnemy(s: GameState, xpx: number, ypx: number, hp: number = BASIC_ENEMY.maxHp): EnemyActor {
  const e: EnemyActor = {
    id: s.nextId(), faction: 'enemy', teamId: ENEMY_TEAM_ID,
    gx: pxToFp(xpx), gy: pxToFp(ypx), z: toFp(0), vx: toFp(0), vy: toFp(0),
    facing: 0 as Brad, hp, maxHp: BASIC_ENEMY.maxHp, shield: 0, maxShield: 0,
    ticksSinceHit: 0, radius: BASIC_ENEMY.radius,
    footprintRadius: BASIC_ENEMY.footprintRadius,
    alive: true, weapon: null, firing: false, status: freshStatus(),
  };
  s.enemies.push(e);
  return e;
}

// vx is a per-tick grid-fp displacement; magnitudes here are exaggerated so the
// direction/advance is obvious — realism (≈330 fp/tick) is covered end-to-end.
function addBullet(s: GameState, xpx: number, ypx: number, vx: Fp, faction: Faction): Projectile {
  const b: Projectile = {
    id: s.nextId(), faction, teamId: faction === 'enemy' ? ENEMY_TEAM_ID : 0,
    gx: pxToFp(xpx), gy: pxToFp(ypx), z: pxToFp(12),
    vx, vy: toFp(0), radius: pxToFp(5), damage: faction === 'player' ? 2 : 1,
    damageType: 'physical', lifeTicks: 90, alive: true,
  };
  s.projectiles.push(b);
  return b;
}

describe('MovementSystem (step 4)', () => {
  it('integrates velocity and clamps the player inside the world', () => {
    const s = state();
    s.players[0]!.vx = toFp(10000); // absurd → must clamp, not escape
    new MovementSystem().tick(s);
    expect(s.players[0]!.gx).toBe((pxToFp(1600) - PLAYER_BASE.margin) as Fp); // worldW - margin
  });

  it('pushes an actor out of a round solid it overlaps', () => {
    // Solid just left of the player's spawn (world centre 800,600) → they overlap.
    const s = createGameState({ ...CFG, obstacles: [[790, 600, 30]] as const });
    const p = s.players[0]!;
    new MovementSystem().tick(s);
    const dx = p.gx - pxToFp(790);
    const dy = p.gy - pxToFp(600);
    const minDist = (p.footprintRadius + pxToFp(30)) as number; // feet, not body radius
    // Pushed out along +x (away from the solid centre) to just-touching (±rounding).
    expect(dx).toBeGreaterThan(0);
    expect(Math.abs(dy)).toBeLessThan(2);
    expect(Math.abs(isqrt(dx * dx + dy * dy) - minDist)).toBeLessThanOrEqual(2);
  });

  it('resolves a concentric overlap deterministically (+x nudge)', () => {
    const s = createGameState({ ...CFG, obstacles: [[800, 600, 30]] as const });
    const p = s.players[0]!; // spawns exactly on the solid centre
    new MovementSystem().tick(s);
    expect(p.gx).toBe(addFp(pxToFp(800), (p.footprintRadius + pxToFp(30)) as Fp));
    expect(p.gy).toBe(pxToFp(600));
  });
});

describe('ProjectileStepSystem (step 5)', () => {
  it('advances a bullet by its per-tick velocity', () => {
    const s = state();
    const b = addBullet(s, 100, 100, toFp(11), 'enemy');
    new ProjectileStepSystem().tick(s);
    expect(b.gx).toBe(addFp(pxToFp(100), toFp(11))); // start + per-tick velocity
    expect(b.lifeTicks).toBe(89);
  });

  it('expires a bullet that leaves the world margin', () => {
    const s = state();
    const b = addBullet(s, 1700, 100, toFp(11), 'enemy'); // past worldW + oobMargin
    new ProjectileStepSystem().tick(s);
    expect(b.alive).toBe(false);
  });

  it('expires a bullet when its lifespan runs out', () => {
    const s = state();
    const b = addBullet(s, 100, 100, toFp(0), 'enemy');
    b.lifeTicks = 1;
    new ProjectileStepSystem().tick(s);
    expect(b.alive).toBe(false);
  });

  it('expires a bullet that flies into a solid (pillar)', () => {
    const s = createGameState({ ...CFG, obstacles: [[816, 100, 14]] as const });
    const b = addBullet(s, 800, 100, toFp(0.5), 'enemy'); // ~16px step lands in the pillar
    new ProjectileStepSystem().tick(s);
    expect(b.alive).toBe(false);
  });

  it('lets a bullet pass where there is no solid', () => {
    const s = createGameState({ ...CFG, obstacles: [[816, 400, 14]] as const });
    const b = addBullet(s, 800, 100, toFp(0.5), 'enemy'); // pillar is far away on y
    new ProjectileStepSystem().tick(s);
    expect(b.alive).toBe(true);
  });
});

describe('DeflectSystem (step 6) — parry is the melee swing arc', () => {
  it('a swing flips an enemy bullet in its arc to player faction and redirects it at a target', () => {
    const s = state();
    const p = s.players[0]!;
    p.weapon = makeWeapon(SABER_SIM);
    p.weapon.justSwung = true; // swung THIS tick — the swing IS the parry (no block key)
    p.facing = 0 as Brad; // facing +x
    addEnemy(s, 900, 600); // redirect target to the +x side
    const b = addBullet(s, 830, 600, toFp(-11), 'enemy'); // 30px in front, incoming, in-arc
    new DeflectSystem().tick(s);
    expect(b.faction).toBe('player');
    expect(b.vx).toBeGreaterThan(0); // redirected back toward the enemy
    expect(s.events.some((e) => e.type === 'deflect')).toBe(true);
  });

  it('does not deflect while not swinging (no passive block)', () => {
    const s = state();
    const p = s.players[0]!;
    p.weapon = makeWeapon(SABER_SIM);
    p.weapon.justSwung = false; // holding still — no swing, no parry
    p.facing = 0 as Brad;
    const b = addBullet(s, 830, 600, toFp(-11), 'enemy'); // in-arc but the saber isn't swinging
    new DeflectSystem().tick(s);
    expect(b.faction).toBe('enemy');
  });

  it('ignores a bullet outside the swing arc', () => {
    const s = state();
    const p = s.players[0]!;
    p.weapon = makeWeapon(SABER_SIM);
    p.weapon.justSwung = true;
    p.facing = 0 as Brad; // facing +x
    const b = addBullet(s, 800, 700, toFp(0), 'enemy'); // 100px below → out of range + arc
    new DeflectSystem().tick(s);
    expect(b.faction).toBe('enemy');
  });
});

describe('HitResolveSystem (step 7)', () => {
  it('a player bullet overlapping an enemy deals damage and is consumed', () => {
    const s = state();
    const e = addEnemy(s, 830, 600);
    addBullet(s, 830, 600, toFp(11), 'player');
    new HitResolveSystem().tick(s);
    expect(e.hp).toBe(1); // 3 - 2
    expect(s.projectiles).toHaveLength(0); // consumed + compacted
  });

  it('an enemy bullet overlapping the player is absorbed by the shield first (two-pool)', () => {
    const s = state();
    const p = s.players[0]!;
    addBullet(s, 800, 600, toFp(0), 'enemy'); // on top of the player
    new HitResolveSystem().tick(s);
    expect(p.hp).toBe(DEFAULT_SKIN.maxHp); // hp untouched while shield remains
    expect(p.shield).toBe(DEFAULT_SKIN.maxShield - 1); // shield soaked the hit
    expect(p.ticksSinceHit).toBe(0); // taking damage reset the regen timer
  });

  it('damage overflows to hp once the shield is gone, and fires shield_break on depletion', () => {
    const s = state();
    const p = s.players[0]!;
    p.shield = 1; // one point of shield left
    addBullet(s, 800, 600, toFp(0), 'enemy'); // dmg 1 → empties the shield exactly
    new HitResolveSystem().tick(s);
    expect(p.shield).toBe(0);
    expect(p.hp).toBe(DEFAULT_SKIN.maxHp); // exactly absorbed, no overflow
    expect(s.events.some((e) => e.type === 'shield_break' && e.id === p.id)).toBe(true);
  });

  it('opposing-faction bullets that overlap cancel each other out', () => {
    const s = state();
    const pb = addBullet(s, 800, 600, toFp(0), 'player');
    const eb = addBullet(s, 800, 600, toFp(0), 'enemy'); // same spot → overlap
    new HitResolveSystem().tick(s);
    expect(pb.alive).toBe(false);
    expect(eb.alive).toBe(false);
    expect(s.projectiles).toHaveLength(0); // both consumed + compacted
    expect(s.events.some((e) => e.type === 'clash')).toBe(true);
  });

  it('same-faction bullets pass through each other (no self-clash)', () => {
    const s = state();
    addBullet(s, 200, 200, toFp(0), 'enemy'); // empty space (no actor to hit)
    addBullet(s, 200, 200, toFp(0), 'enemy'); // overlapping, same faction
    new HitResolveSystem().tick(s);
    expect(s.projectiles).toHaveLength(2); // untouched
    expect(s.events.some((e) => e.type === 'clash')).toBe(false);
  });

  it('a clashing bullet is spent before it can also hit an actor', () => {
    const s = state();
    const p = s.players[0]!;
    const before = p.hp;
    addBullet(s, 800, 600, toFp(0), 'enemy'); // on top of the player…
    addBullet(s, 800, 600, toFp(0), 'player'); // …but cancelled by a player bullet first
    new HitResolveSystem().tick(s);
    expect(p.hp).toBe(before); // clash consumed the enemy bullet before the hit loop
    expect(s.projectiles).toHaveLength(0);
  });

  it('a melee swing hits every enemy inside its arc, once', () => {
    const s = state();
    const p = s.players[0]!;
    p.weapon = makeWeapon(SABER_SIM);
    p.weapon.justSwung = true;
    p.facing = 0 as Brad;
    const inArc = addEnemy(s, 830, 600); // 30px ahead, in the arc
    const behind = addEnemy(s, 770, 600); // behind → outside the forward arc
    new HitResolveSystem().tick(s);
    expect(inArc.hp).toBe(1); // 3 - 2
    expect(behind.hp).toBe(BASIC_ENEMY.maxHp); // untouched
  });
});

describe('DeathDropsSystem (step 8)', () => {
  it('removes a dead enemy, emits death, and rolls a pickup via dropPrng', () => {
    const s = state();
    s.tick = 5;
    const e = addEnemy(s, 830, 600, 0); // already at 0 hp
    new DeathDropsSystem().tick(s);
    expect(s.enemies).toHaveLength(0);
    expect(s.events.some((ev) => ev.type === 'death' && ev.id === e.id)).toBe(true);
    expect(s.pickups).toHaveLength(1);
    expect(s.pickups[0]!.spawnTick).toBe(5); // tagged this tick → not collectable yet
  });

  it('drop kind is deterministic for a given seed', () => {
    const kindFor = () => {
      const s = state();
      addEnemy(s, 830, 600, 0);
      new DeathDropsSystem().tick(s);
      return s.pickups[0]!.kind;
    };
    expect(kindFor()).toBe(kindFor());
  });
});

describe('PickupSystem (step 9)', () => {
  it('heals the player on overlap and consumes the pickup', () => {
    const s = state();
    s.tick = 10;
    const p = s.players[0]!;
    p.hp = 3;
    s.pickups.push({ id: s.nextId(), kind: 'heal', gx: p.gx, gy: p.gy, spawnTick: 0, alive: true });
    new PickupSystem().tick(s);
    expect(p.hp).toBe(4);
    expect(s.pickups).toHaveLength(0);
  });

  it('does not collect a pickup dropped on the same tick (design/08 8→9 ordering)', () => {
    const s = state();
    s.tick = 10;
    const p = s.players[0]!;
    s.pickups.push({ id: s.nextId(), kind: 'material', gx: p.gx, gy: p.gy, spawnTick: 10, alive: true });
    new PickupSystem().tick(s);
    expect(s.pickups).toHaveLength(1); // still there
  });
});
