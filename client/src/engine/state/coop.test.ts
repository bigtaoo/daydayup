/**
 * Co-op seats — the real SECOND player (design/05/06, ROADMAP 3.1). Until now the
 * engine built exactly one PlayerActor, so 3.2's revive/downed/team-wipe machinery
 * could only be exercised against a hand-synthesised second player pushed into
 * state.players (see systems/revive.test.ts's apology). `EngineConfig.players` builds
 * N seats at construction; because every system has always iterated state.players by
 * `owner`, this file drives a genuine two-seat match through the real GameEngine.step()
 * — command routing, downed-run-continues, revive, and team-wipe, all end-to-end.
 */
import { describe, it, expect } from 'vitest';
import { createGameEngine } from '@dd/engine/GameEngine';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import { makeCommand } from '@dd/engine/state/input';
import { Button } from '@dd/engine/state/commands';
import { pxToFp } from '@dd/engine/content/convert';
import { BRAD_FULL, type Brad } from '@dd/engine/math/trig';
import { REVIVE_CHANNEL_TICKS, REVIVE_HP } from '@dd/engine/config';

const EAST = 0 as Brad; //           moveBrad 0   → +x
const WEST = (BRAD_FULL / 2) as Brad; // half turn → -x

/** A command for one seat this tick (idle unless overridden). */
function cmd(owner: number, tick: number, o: { moveBrad?: Brad; moveMag?: number; buttons?: number } = {}) {
  return makeCommand({
    owner, tick,
    moveBrad: o.moveBrad ?? (0 as Brad), moveMag: o.moveMag ?? 0,
    aimBrad: 0 as Brad, buttons: o.buttons ?? 0,
  });
}

/**
 * A two-seat engine with a single, distant enemy that we immediately disarm — its
 * only job is to keep `wavesExhausted` false so the run stays `playing` (an
 * empty-wave run auto-wins on tick 1). Returns the engine after the spawning tick.
 */
function coopEngine(seed: number, starts: [number, number][]) {
  const eng = createGameEngine({
    seed, worldW: 1600, worldH: 1200,
    waves: [[[1500, 1100]]], // one enemy, far from both seats
    players: starts.map((start) => ({ start })),
  });
  // Tick 1 spawns the enemy (SpawnSystem); disarm it so it can never deal damage,
  // making the rest of the scenario deterministic regardless of enemy AI movement.
  eng.step(starts.map((_, i) => cmd(i, 1)));
  for (const e of eng.state.enemies) e.weapon = null;
  return eng;
}

describe('EngineConfig.players — N seats built at construction', () => {
  it('builds one PlayerActor per entry, owner index == array index, distinct identity', () => {
    const s = createGameState({
      seed: 1, worldW: 1600, worldH: 1200, waves: [],
      players: [
        { skinId: 'juggernaut', start: [100, 200] }, // 9 HP / 0 shield
        { skinId: 'skirmisher', start: [300, 400] }, // 3 HP / 8 shield
      ],
    });
    expect(s.players).toHaveLength(2);
    // Ids allocated in seat order → owner 0 is players[0] (id 1), owner 1 is players[1] (id 2).
    expect([s.players[0]!.id, s.players[1]!.id]).toEqual([1, 2]);
    // Each seat carries its own SkinDef defensive identity + its own spawn.
    expect([s.players[0]!.maxHp, s.players[0]!.maxShield]).toEqual([9, 0]);
    expect([s.players[1]!.maxHp, s.players[1]!.maxShield]).toEqual([3, 8]);
    expect(s.players[0]!.gx).toBe(pxToFp(100));
    expect(s.players[1]!.gx).toBe(pxToFp(300));
  });

  it('a one-entry players list is byte-identical to the single-player top-level form', () => {
    const fields = (p: GameState['players'][number]) =>
      [p.id, p.gx, p.gy, p.maxHp, p.maxShield, p.shield, p.hp, p.weapons.map((w) => w.spec.name)];
    const single = createGameState({ seed: 5, worldW: 800, worldH: 600, waves: [], skinId: 'skirmisher', playerStart: [400, 300] });
    const listed = createGameState({ seed: 5, worldW: 800, worldH: 600, waves: [], players: [{ skinId: 'skirmisher', start: [400, 300] }] });
    expect(listed.players).toHaveLength(1);
    expect(JSON.stringify(fields(listed.players[0]!))).toBe(JSON.stringify(fields(single.players[0]!)));
  });
});

describe('two seats through GameEngine.step() — owner routing', () => {
  it('each seat obeys only its own owner command (opposite moves, independent)', () => {
    const eng = coopEngine(9, [[400, 400], [500, 400]]);
    const x0 = eng.state.players[0]!.gx;
    const x1 = eng.state.players[1]!.gx;
    for (let t = 2; t <= 8; t++) {
      eng.step([
        cmd(0, t, { moveBrad: EAST, moveMag: 255 }), // seat 0 drives east
        cmd(1, t, { moveBrad: WEST, moveMag: 255 }), // seat 1 drives west
      ]);
    }
    expect(eng.state.players[0]!.gx).toBeGreaterThan(x0); // seat 0 moved +x
    expect(eng.state.players[1]!.gx).toBeLessThan(x1); //    seat 1 moved -x
    expect(eng.state.winner).toBeNull(); // both up, enemy alive → run continues
  });
});

describe('co-op down / revive / team-wipe through the real engine', () => {
  it('one seat downed → the run CONTINUES (a standing teammate keeps it alive), then a revive lands', () => {
    const eng = coopEngine(11, [[400, 400], [420, 400]]); // seats 20px apart (in revive range)
    const s = eng.state;
    // A lethal hit on seat 0 (modelled by zeroing its pools, then stepping): DeathDropsSystem
    // downs it — alive stays true — and WinCondition sees seat 1 still up, so no wipe.
    s.players[0]!.hp = 0;
    s.players[0]!.shield = 0;
    eng.step([cmd(0, 2), cmd(1, 2)]);
    expect(s.players[0]!.downed).toBe(true);
    expect(s.players[0]!.alive).toBe(true);
    expect(s.winner).toBeNull();

    // Seat 1 holds INTERACT in range for the full channel → seat 0 is revived.
    for (let t = 3; t < 3 + REVIVE_CHANNEL_TICKS; t++) {
      eng.step([cmd(0, t), cmd(1, t, { buttons: Button.INTERACT })]);
    }
    expect(s.players[0]!.downed).toBe(false);
    expect(s.players[0]!.alive).toBe(true);
    expect(s.players[0]!.hp).toBe(REVIVE_HP);
    expect(s.winner).toBeNull();
  });

  it('BOTH seats downed the same tick → team wipe (enemies win)', () => {
    const eng = coopEngine(13, [[400, 400], [420, 400]]);
    const s = eng.state;
    for (const p of s.players) { p.hp = 0; p.shield = 0; }
    eng.step([cmd(0, 2), cmd(1, 2)]);
    expect(s.players.every((p) => p.downed)).toBe(true);
    expect(s.winner).toBe('enemies');
    expect(s.phase).toBe('gameover');
  });
});
