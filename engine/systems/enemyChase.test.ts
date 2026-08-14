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
import type { EnemyActor } from '@dd/engine/state/entities';
import { AIDecideSystem, MovementSystem } from '@dd/engine/systems';
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

  it('keeps firing throughout the approach, not just once it stops', () => {
    const s = createGameState({ ...CFG, players: [{ start: [400, 300] }] });
    const e = buildEnemyActor(s, pxToFp(400 + 500), pxToFp(300), 'basic');
    s.enemies.push(e);

    const ai = new AIDecideSystem();
    const mv = new MovementSystem();
    for (let i = 0; i < 150; i++) {
      ai.tick(s);
      expect(e.firing).toBe(true); // every tick, whether still closing or already stopped
      mv.tick(s);
    }
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
  });
});
