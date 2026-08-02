/**
 * Scene.reconcile — the render-side mirror of engine state. Covers the upper/lower
 * body split it now computes for the player view: `bodyFacingRad` (legs/body) tracks
 * the player's own velocity, held at its last value while idle (same "no snap-to-zero"
 * convention CommandBuilder already used for the aim stick), while `facingRad` (the
 * weapon) stays exactly the engine's aim-derived `PlayerActor.facing`, unaffected by
 * movement. Enemies/bullets are unaffected — they keep a single facing.
 */
import { describe, it, expect } from 'vitest';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import { pxToFp } from '@dd/engine/content/convert';
import { freshStatus } from '@dd/engine/content/damage';
import { BASIC_ENEMY } from '@dd/engine/content/enemies';
import { toFp } from '@dd/engine/math/fixed';
import type { Brad } from '@dd/engine/math/trig';
import { ENEMY_TEAM_ID, type EnemyActor } from '@dd/engine/state/entities';
import { Scene } from './Scene';
import { Layers } from './layers';
import { bradToRad } from './coords';

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
