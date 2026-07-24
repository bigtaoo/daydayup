/**
 * Frame library beyond `straight` (design/03/09 Frame axis, ROADMAP 1.1): spread
 * emission (WeaponFireSystem) and the homing/lob/beam/boomerang ballistics
 * (ProjectileStepSystem step 5 + HitResolveSystem step 7). Melee hammer/spear need
 * no new mechanic — MeleeSimSpec is already generic — so they are not re-tested
 * here beyond confirming the catalog resolves (weapons.test.ts-style coverage
 * would be redundant with the existing WEAPON_SIM_BY_ID shape).
 */
import { describe, it, expect } from 'vitest';
import { toFp } from '@dd/engine/math/fixed';
import type { Brad } from '@dd/engine/math/trig';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import type { EnemyActor, Faction, Projectile } from '@dd/engine/state/entities';
import { pxToFp } from '@dd/engine/content/convert';
import { freshStatus } from '@dd/engine/content/damage';
import { BASIC_ENEMY } from '@dd/engine/content/enemies';
import {
  makeWeapon,
  SCATTERGUN_SIM,
  SEEKER_SIM,
  MORTAR_SIM,
  LASERCUTTER_SIM,
  TOMAHAWK_SIM,
  BLASTER_SIM,
} from '@dd/engine/content/weapons';
import { HitResolveSystem, ProjectileStepSystem, WeaponFireSystem } from '@dd/engine/systems';
import { createGameEngine } from '@dd/engine/GameEngine';
import { Button } from '@dd/engine/state/commands';
import { makeCommand } from '@dd/engine/state/input';

const CFG = { seed: 11, worldW: 1600, worldH: 1200, waves: [] as const };
const state = (): GameState => createGameState(CFG);

function addEnemy(s: GameState, xpx: number, ypx: number): EnemyActor {
  const e: EnemyActor = {
    id: s.nextId(), faction: 'enemy',
    gx: pxToFp(xpx), gy: pxToFp(ypx), z: toFp(0), vx: toFp(0), vy: toFp(0),
    facing: 0 as Brad, hp: BASIC_ENEMY.maxHp, maxHp: BASIC_ENEMY.maxHp,
    shield: 0, maxShield: 0, ticksSinceHit: 0,
    radius: BASIC_ENEMY.radius, footprintRadius: BASIC_ENEMY.footprintRadius,
    alive: true, weapon: null, firing: false, status: freshStatus(),
  };
  s.enemies.push(e);
  return e;
}

function addBullet(
  s: GameState,
  xpx: number,
  ypx: number,
  overrides: Partial<Projectile>,
  faction: Faction = 'player',
): Projectile {
  const b: Projectile = {
    id: s.nextId(), faction, gx: pxToFp(xpx), gy: pxToFp(ypx), z: toFp(0),
    vx: toFp(0), vy: toFp(0), radius: pxToFp(5), damage: 2,
    damageType: 'physical', lifeTicks: 90, alive: true,
    ...overrides,
  };
  s.projectiles.push(b);
  return b;
}

describe('Emission — spread (WeaponFireSystem)', () => {
  it('a single-pellet weapon fires exactly one bullet with no jitter (unchanged baseline)', () => {
    const s = state();
    const p = s.players[0]!;
    p.weapon = makeWeapon(BLASTER_SIM);
    p.firing = true;
    p.facing = 0 as Brad;
    new WeaponFireSystem().tick(s);
    expect(s.projectiles).toHaveLength(1);
    expect(s.projectiles[0]!.vy).toBe(toFp(0)); // straight along facing — no vertical jitter
  });

  it('a spread weapon fires `bullets` pellets, each jittered within the cone', () => {
    const s = state();
    const p = s.players[0]!;
    p.weapon = makeWeapon(SCATTERGUN_SIM);
    p.firing = true;
    p.facing = 0 as Brad;
    new WeaponFireSystem().tick(s);
    expect(s.projectiles).toHaveLength(SCATTERGUN_SIM.bullets);
    // Every pellet's fire direction stays within ±spreadHalf of facing (0).
    for (const b of s.projectiles) {
      const dir = Math.atan2(b.vy as number, b.vx as number);
      expect(Math.abs(dir)).toBeLessThanOrEqual((SCATTERGUN_SIM.spreadHalf / 65536) * 2 * Math.PI + 0.05);
    }
  });

  it('spread jitter is deterministic for a given seed', () => {
    const fire = () => {
      const s = state();
      const p = s.players[0]!;
      p.weapon = makeWeapon(SCATTERGUN_SIM);
      p.firing = true;
      p.facing = 0 as Brad;
      new WeaponFireSystem().tick(s);
      return s.projectiles.map((b) => [b.vx, b.vy]);
    };
    expect(fire()).toEqual(fire());
  });
});

describe('Ballistic — homing', () => {
  it('turns toward the nearest enemy, clamped by turnRateBrad', () => {
    const s = state();
    addEnemy(s, 900, 700); // off to the side, not directly ahead
    const b = addBullet(s, 800, 600, {
      vx: toFp(11), vy: toFp(0), // currently flying +x
      ballistic: 'homing', turnRateBrad: SEEKER_SIM.turnRateBrad, speed: toFp(11),
    });
    const before = Math.atan2(b.vy as number, b.vx as number);
    new ProjectileStepSystem().tick(s);
    const after = Math.atan2(b.vy as number, b.vx as number);
    expect(after).not.toBe(before); // it turned
    // Speed (magnitude) is preserved while turning (± fp-trig table rounding).
    const mag = Math.round(Math.sqrt((b.vx as number) ** 2 + (b.vy as number) ** 2));
    expect(Math.abs(mag - 11000)).toBeLessThan(20);
  });

  it('fired via the weapon, a seeker bullet is tagged homing with a frozen speed', () => {
    const s = state();
    const p = s.players[0]!;
    p.weapon = makeWeapon(SEEKER_SIM);
    p.firing = true;
    new WeaponFireSystem().tick(s);
    const b = s.projectiles[0]!;
    expect(b.ballistic).toBe('homing');
    expect(b.speed).toBe(SEEKER_SIM.bulletSpeed);
  });
});

describe('Ballistic — lob', () => {
  it('flies straight, then on lifespan end is flagged landed instead of dying', () => {
    const s = state();
    const b = addBullet(s, 800, 600, {
      vx: toFp(1), vy: toFp(0), lifeTicks: 1,
      ballistic: 'lob', blastRadius: MORTAR_SIM.blastRadius,
    });
    new ProjectileStepSystem().tick(s);
    expect(b.alive).toBe(true); // still alive — HitResolve resolves the blast
    expect(b.landed).toBe(true);
  });

  it('a landed lob damages every opposite-faction actor within blastRadius, then dies', () => {
    const s = state();
    const close = addEnemy(s, 820, 600); // inside the blast
    const far = addEnemy(s, 1200, 600); // outside
    const b = addBullet(s, 800, 600, {
      vx: toFp(0), vy: toFp(0), landed: true, damage: 2,
      blastRadius: MORTAR_SIM.blastRadius,
    });
    new HitResolveSystem().tick(s);
    expect(close.hp).toBe(BASIC_ENEMY.maxHp - 2);
    expect(far.hp).toBe(BASIC_ENEMY.maxHp);
    expect(b.alive).toBe(false);
  });
});

describe('Ballistic — beam', () => {
  it('does not move; ProjectileStepSystem only counts down its own duration', () => {
    const s = state();
    const b = addBullet(s, 800, 600, {
      vx: toFp(0), vy: toFp(0), lifeTicks: 999,
      ballistic: 'beam', beamTicksLeft: 3, beamTickInterval: 2,
    });
    new ProjectileStepSystem().tick(s);
    expect(b.gx).toBe(pxToFp(800)); // frozen in place
    expect(b.beamTicksLeft).toBe(2);
    expect(b.alive).toBe(true);
    new ProjectileStepSystem().tick(s);
    new ProjectileStepSystem().tick(s);
    expect(b.alive).toBe(false); // beamTicksLeft hit 0
  });

  it('damages every opposite-faction actor along its line, on the beamTickInterval cadence', () => {
    const s = state();
    s.tick = 4; // multiple of beamTickInterval below
    const inLine = addEnemy(s, 850, 600); // ahead, in the frozen facing (0 brad = +x)
    const offLine = addEnemy(s, 800, 650); // same range, but perpendicular — outside the narrow line
    addBullet(s, 800, 600, {
      vx: toFp(0), vy: toFp(0), damage: 1,
      ballistic: 'beam', beamDir: 0 as Brad, beamRange: LASERCUTTER_SIM.beamRange,
      beamTicksLeft: 4, beamTickInterval: 2,
    });
    new HitResolveSystem().tick(s);
    expect(inLine.hp).toBe(BASIC_ENEMY.maxHp - 1);
    expect(offLine.hp).toBe(BASIC_ENEMY.maxHp);
  });

  it('deals no damage off the cadence tick', () => {
    const s = state();
    s.tick = 5; // NOT a multiple of interval 2
    const e = addEnemy(s, 850, 600);
    addBullet(s, 800, 600, {
      vx: toFp(0), vy: toFp(0), damage: 1,
      ballistic: 'beam', beamDir: 0 as Brad, beamRange: LASERCUTTER_SIM.beamRange,
      beamTicksLeft: 4, beamTickInterval: 2,
    });
    new HitResolveSystem().tick(s);
    expect(e.hp).toBe(BASIC_ENEMY.maxHp);
  });
});

describe('Ballistic — boomerang', () => {
  it('reverses velocity exactly at returnAfterTicks', () => {
    const s = state();
    const b = addBullet(s, 800, 600, {
      vx: toFp(10), vy: toFp(0),
      ballistic: 'boomerang', returnAfterTicks: 2, ticksAlive: 0,
    });
    new ProjectileStepSystem().tick(s); // ticksAlive → 1
    expect(b.vx).toBe(toFp(10));
    new ProjectileStepSystem().tick(s); // ticksAlive → 2 === returnAfterTicks
    expect(b.vx).toBe(toFp(-10));
  });

  it('fired via the weapon, a tomahawk bullet is tagged boomerang with ticksAlive 0', () => {
    const s = state();
    const p = s.players[0]!;
    p.weapon = makeWeapon(TOMAHAWK_SIM);
    p.firing = true;
    new WeaponFireSystem().tick(s);
    const b = s.projectiles[0]!;
    expect(b.ballistic).toBe('boomerang');
    expect(b.ticksAlive).toBe(0);
    expect(b.returnAfterTicks).toBe(TOMAHAWK_SIM.returnAfterTicks);
  });
});

describe('Integration — each new frame survives the full engine step() pipeline', () => {
  it.each([
    ['scattergun', SCATTERGUN_SIM],
    ['seeker', SEEKER_SIM],
    ['mortar', MORTAR_SIM],
    ['lasercutter', LASERCUTTER_SIM],
    ['tomahawk', TOMAHAWK_SIM],
  ] as const)('%s equips, fires, and damages an enemy over several ticks without throwing', (_name, sim) => {
    const eng = createGameEngine({ seed: 1, worldW: 1600, worldH: 1200, playerStart: [400, 400], waves: [] });
    const p = eng.state.players[0]!;
    p.weapon = makeWeapon(sim);
    p.weapons = [p.weapon];
    const e: EnemyActor = {
      id: eng.state.nextId(), faction: 'enemy',
      gx: pxToFp(450), gy: pxToFp(400), z: toFp(0), vx: toFp(0), vy: toFp(0),
      facing: 0 as Brad, hp: 30, maxHp: 30, shield: 0, maxShield: 0, ticksSinceHit: 0,
      radius: BASIC_ENEMY.radius, footprintRadius: BASIC_ENEMY.footprintRadius,
      alive: true, weapon: null, firing: false, status: freshStatus(),
    };
    eng.state.enemies.push(e);
    for (let t = 1; t <= 90; t++) {
      expect(() =>
        eng.step([makeCommand({ owner: 0, tick: t, moveBrad: 0 as Brad, moveMag: 0, aimBrad: 0 as Brad, buttons: Button.FIRE })]),
      ).not.toThrow();
    }
    expect(e.hp).toBeLessThan(30);
  });
});
