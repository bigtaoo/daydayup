import { describe, it, expect } from 'vitest';
import { toFp, addFp } from '@dd/engine/math/fixed';
import type { Fp } from '@dd/engine/math/fixed';
import type { Brad } from '@dd/engine/math/trig';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import type { EnemyActor, Faction, Projectile } from '@dd/engine/state/entities';
import { makeWeapon, SABER_SIM } from '@dd/engine/content/weapons';
import { PLAYER } from '@dd/engine/content/players';
import { BASIC_ENEMY } from '@dd/engine/content/enemies';
import { pxToFp } from '@dd/engine/content/convert';
import {
  BlockDeflectSystem,
  DeathDropsSystem,
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
    id: s.nextId(), faction: 'enemy',
    gx: pxToFp(xpx), gy: pxToFp(ypx), z: toFp(0), vx: toFp(0), vy: toFp(0), vz: toFp(0),
    facing: 0 as Brad, hp, maxHp: BASIC_ENEMY.maxHp, radius: BASIC_ENEMY.radius,
    alive: true, weapon: null, firing: false,
  };
  s.enemies.push(e);
  return e;
}

// vx is a per-tick grid-fp displacement; magnitudes here are exaggerated so the
// direction/advance is obvious — realism (≈330 fp/tick) is covered end-to-end.
function addBullet(s: GameState, xpx: number, ypx: number, vx: Fp, faction: Faction): Projectile {
  const b: Projectile = {
    id: s.nextId(), faction, gx: pxToFp(xpx), gy: pxToFp(ypx), z: pxToFp(12),
    vx, vy: toFp(0), radius: pxToFp(5), damage: faction === 'player' ? 2 : 1,
    lifeTicks: 90, alive: true,
  };
  s.projectiles.push(b);
  return b;
}

describe('MovementSystem (step 4)', () => {
  it('integrates velocity and clamps the player inside the world', () => {
    const s = state();
    s.players[0]!.vx = toFp(10000); // absurd → must clamp, not escape
    new MovementSystem().tick(s);
    expect(s.players[0]!.gx).toBe((pxToFp(1600) - PLAYER.margin) as Fp); // worldW - margin
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
});

describe('BlockDeflectSystem (step 6)', () => {
  it('flips an enemy bullet in the block arc to player faction and redirects it at a target', () => {
    const s = state();
    const p = s.players[0]!;
    p.weapon = makeWeapon(SABER_SIM);
    p.weapon.blocking = true;
    p.facing = 0 as Brad; // facing +x
    addEnemy(s, 900, 600); // redirect target to the +x side
    const b = addBullet(s, 830, 600, toFp(-11), 'enemy'); // 30px in front, incoming
    new BlockDeflectSystem().tick(s);
    expect(b.faction).toBe('player');
    expect(b.vx).toBeGreaterThan(0); // redirected back toward the enemy
    expect(s.events.some((e) => e.type === 'deflect')).toBe(true);
  });

  it('ignores a bullet outside the block arc', () => {
    const s = state();
    const p = s.players[0]!;
    p.weapon = makeWeapon(SABER_SIM);
    p.weapon.blocking = true;
    p.facing = 0 as Brad; // facing +x
    const b = addBullet(s, 800, 700, toFp(0), 'enemy'); // behind/below, out of the forward arc
    new BlockDeflectSystem().tick(s);
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

  it('an enemy bullet overlapping the player deals damage', () => {
    const s = state();
    const p = s.players[0]!;
    addBullet(s, 800, 600, toFp(0), 'enemy'); // on top of the player
    new HitResolveSystem().tick(s);
    expect(p.hp).toBe(PLAYER.maxHp - 1);
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
    s.pickups.push({ id: s.nextId(), kind: 'health', gx: p.gx, gy: p.gy, spawnTick: 0, alive: true });
    new PickupSystem().tick(s);
    expect(p.hp).toBe(4);
    expect(s.pickups).toHaveLength(0);
  });

  it('does not collect a pickup dropped on the same tick (design/08 8→9 ordering)', () => {
    const s = state();
    s.tick = 10;
    const p = s.players[0]!;
    s.pickups.push({ id: s.nextId(), kind: 'coin', gx: p.gx, gy: p.gy, spawnTick: 10, alive: true });
    new PickupSystem().tick(s);
    expect(s.pickups).toHaveLength(1); // still there
  });
});
