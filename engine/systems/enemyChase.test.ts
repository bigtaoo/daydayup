/**
 * Enemy chase integration (ENGINE_VERSION 37) — AIDecideSystem's `chase()` driven
 * together with the REAL MovementSystem across many ticks, not just AIDecideSystem
 * in isolation (AIDecideSystem.test.ts already covers the single-tick decision
 * logic). Confirms the two systems compose correctly end to end: convergence into
 * engage range, stability once there, that a slower mob never catches a fleeing
 * player, and that a chasing mob still respects wall solids instead of clipping
 * through them.
 */
import { describe, it, expect } from 'vitest';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import { buildEnemyActor } from '@dd/engine/content/enemies';
import { PLAYER_BASE } from '@dd/engine/content/players';
import type { EnemyActor, RangedSimSpec } from '@dd/engine/state/entities';
import { AIDecideSystem, MovementSystem, WeaponFireSystem } from '@dd/engine/systems';
import { pxToFp } from '@dd/engine/content/convert';
import type { Fp } from '@dd/engine/math/fixed';

const CFG = { seed: 11, worldW: 3200, worldH: 2400, waves: [] as const };

function run(state: GameState, ticks: number): void {
  const ai = new AIDecideSystem();
  const mv = new MovementSystem();
  for (let i = 0; i < ticks; i++) {
    ai.tick(state);
    mv.tick(state);
  }
}

function dist(a: { gx: number; gy: number }, b: { gx: number; gy: number }): number {
  return Math.hypot(a.gx - b.gx, a.gy - b.gy);
}

describe('enemy chase integration (AIDecideSystem + MovementSystem, ENGINE_VERSION 37)', () => {
  it('a basic mob converges from a room-scale distance into its engage range and stays there', () => {
    const s = createGameState({ ...CFG, players: [{ start: [400, 300] }] });
    const target = s.players[0]!;
    const e = buildEnemyActor(s, pxToFp(400 + 500), pxToFp(300 + 300), 'basic'); // ~580px away
    s.enemies.push(e);

    run(s, 200);
    expect(dist(e, target)).toBeLessThanOrEqual(e.engageRangeFp! + 1); // +1fp truncation slack

    // Stable once there: further ticks don't drift back out (no oscillation).
    run(s, 50);
    expect(dist(e, target)).toBeLessThanOrEqual(e.engageRangeFp! + 1);
  });

  it('a boss converges the same way as a basic mob (no distinct kiting behavior yet)', () => {
    const s = createGameState({ ...CFG, players: [{ start: [400, 300] }] });
    const target = s.players[0]!;
    const boss = buildEnemyActor(s, pxToFp(400 + 500), pxToFp(300 + 300), 'blightlord');
    s.enemies.push(boss);

    run(s, 200);
    expect(dist(boss, target)).toBeLessThanOrEqual(boss.engageRangeFp! + 1);
  });

  it('only fires once within engage range, not while still closing the distance (ENGINE_VERSION 40)', () => {
    const s = createGameState({ ...CFG, players: [{ start: [400, 300] }] });
    const target = s.players[0]!;
    const e = buildEnemyActor(s, pxToFp(400 + 500), pxToFp(300), 'basic');
    s.enemies.push(e);

    const ai = new AIDecideSystem();
    const mv = new MovementSystem();
    let everFiredWhileOutOfRange = false;
    let firedOnceInRange = false;
    for (let i = 0; i < 150; i++) {
      ai.tick(s);
      const inRange = dist(e, target) <= e.engageRangeFp! + 1;
      if (e.firing && !inRange) everFiredWhileOutOfRange = true;
      if (e.firing && inRange) firedOnceInRange = true;
      mv.tick(s);
    }
    expect(everFiredWhileOutOfRange).toBe(false); // no more room-wide alpha strike
    expect(firedOnceInRange).toBe(true); // but it does actually engage once close enough
  });

  it('a player that keeps outrunning it is never caught (enemy is slower by design)', () => {
    // A wide world + plenty of westward runway (unlike the other tests here) so the
    // fleeing player never hits the world-bounds clamp mid-test, which would pin it
    // in place and let the enemy catch up for a reason that has nothing to do with
    // the chase logic itself.
    const s = createGameState({ ...CFG, worldW: 6000, players: [{ start: [3000, 300] }] });
    const target = s.players[0]!;
    const e = buildEnemyActor(s, pxToFp(3000 + 500), pxToFp(300), 'basic');
    s.enemies.push(e);
    const startDist = dist(e, target);

    const ai = new AIDecideSystem();
    const mv = new MovementSystem();
    for (let i = 0; i < 100; i++) {
      ai.tick(s);
      // Player commits to running directly away (enemy sits at +x, so fleeing is
      // -x) at its real top speed — always faster than DEFAULT_ENEMY_MOVE_SPEED_PER_TICK
      // by design, so the enemy can never close the gap.
      target.vx = -PLAYER_BASE.speedPerTick as Fp;
      mv.tick(s);
    }
    expect(dist(e, target)).toBeGreaterThanOrEqual(startDist); // the gap never closes
  });

  it('stops against a wall between it and the target instead of clipping through', () => {
    const s = createGameState({
      ...CFG,
      players: [{ start: [400, 300] }],
      walls: [[600, 200, 40, 200]] as const, // a thin wall directly between enemy (east) and target (west)
    });
    const target = s.players[0]!;
    const e: EnemyActor = buildEnemyActor(s, pxToFp(900), pxToFp(300), 'basic'); // far outside engage range, beyond the wall
    s.enemies.push(e);

    run(s, 200);

    const wall = s.walls[0]!;
    // Approaching from +x, MovementSystem.resolveWalls pushes it back out to the
    // wall's east face — it must never cross INTO or THROUGH the wall onto the
    // target's (west) side, no matter how many ticks it keeps trying to close in.
    expect(e.gx).toBeGreaterThanOrEqual(wall.x);
    expect(e.gx).toBeGreaterThan(target.gx);
    // The wall pins it ~240px from the target — outside engageRangeFp (~180px) — so
    // it never gets to fire either (ENGINE_VERSION 40): a mob stalled by geometry is
    // "aware" but harmless, not a bullet source through the wall it's stuck against.
    expect(dist(e, target)).toBeGreaterThan(e.engageRangeFp!);
    expect(e.firing).toBe(false);
  });

  it('an approaching enemy already has a spent cooldown by the time it enters range, so it fires the SAME tick it arrives (ENGINE_VERSION 40 — WeaponFireSystem composition)', () => {
    // WeaponFireSystem.actor() decrements cooldownTicks every tick a weapon exists,
    // regardless of `firing` — before this fix that never mattered (firing was
    // ~always true), but now an enemy spends most of its approach with firing=false
    // while its gun's cooldown quietly counts down anyway. Confirms it composes as
    // intended: no extra "re-arm" wait is paid on arrival on top of the travel time.
    const s = createGameState({ ...CFG, players: [{ start: [400, 300] }] });
    const e = buildEnemyActor(s, pxToFp(400 + 500), pxToFp(300 + 300), 'basic'); // ~580px away
    const fireRateTicks = (e.weapon!.spec as RangedSimSpec).fireRateTicks;
    e.weapon!.cooldownTicks = fireRateTicks; // start on a full cooldown, worst case
    s.enemies.push(e);

    const ai = new AIDecideSystem();
    const wf = new WeaponFireSystem();
    const mv = new MovementSystem();
    let enteredRangeTick = -1;
    let firedTick = -1;
    for (let i = 0; i < 200 && firedTick === -1; i++) {
      ai.tick(s);
      if (e.firing && enteredRangeTick === -1) enteredRangeTick = i;
      wf.tick(s);
      if (s.projectiles.length > 0 && firedTick === -1) firedTick = i;
      mv.tick(s);
    }
    // Closing ~400px of the ~580px gap at ~4px/tick takes well over fireRateTicks
    // (45 ticks at the enemygun's 1.5s cooldown) — so cooldown is already spent
    // before arrival, and the two ticks must coincide exactly.
    expect(enteredRangeTick).toBeGreaterThan(fireRateTicks);
    expect(firedTick).toBe(enteredRangeTick);
  });
});
