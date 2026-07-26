/**
 * WinConditionSystem's PvP branch (design/15, ROADMAP 4.2e) — battle-royale
 * elimination placement, distinct from the PvE "enemies win"/wave-clear model.
 * Doesn't touch the zone/geometry at all, so a single trivial room is enough —
 * only `state.players[].alive`/`teamId` matter here.
 */
import { describe, it, expect } from 'vitest';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import { WinConditionSystem } from '@dd/engine/systems';
import type { ArenaMap } from '@dd/engine/content/arenas';

const MINI_MAP: ArenaMap = {
  id: 'mini',
  sizeGrid: { w: 10, h: 10 },
  rooms: [{ id: 'A', rectGrid: { x: 0, y: 0, w: 10, h: 10 }, solids: [] }],
  doors: [],
  spawns: [{ x: 5, y: 5 }],
  eyeCandidates: [{ roomId: 'A' }],
};

function pvpState(seatCount: number): GameState {
  const players = Array.from({ length: seatCount }, (_, i) => ({ teamId: i }));
  return createGameState({ seed: 1, worldW: 0, worldH: 0, waves: [], arena: MINI_MAP, players });
}

describe('WinConditionSystem — PvP placement', () => {
  it('the match continues while more than one seat is alive', () => {
    const s = pvpState(4);
    new WinConditionSystem().tick(s);
    expect(s.winner).toBeNull();
    expect(s.phase).not.toBe('gameover');
    expect(s.placements).toEqual([]);
  });

  it('records each elimination in order and declares the last survivor the winner', () => {
    const s = pvpState(4);
    const sys = new WinConditionSystem();

    s.players[2]!.alive = false; // 3rd seat eliminated first
    sys.tick(s);
    expect(s.placements).toEqual([2]);
    expect(s.winner).toBeNull();

    s.players[0]!.alive = false; // 1st seat eliminated next
    sys.tick(s);
    expect(s.placements).toEqual([2, 0]);
    expect(s.winner).toBeNull();

    s.players[3]!.alive = false; // only seat 1 left standing
    sys.tick(s);
    expect(s.winner).toBe(1);
    expect(s.phase).toBe('gameover');
    expect(s.placements).toEqual([2, 0, 3]); // worst-to-best; the winner (1) never appears here
    const winEvent = s.events.find((e) => e.type === 'win');
    expect(winEvent).toMatchObject({ type: 'win', winner: 1 });
  });

  it('never re-decides once a winner is set (idempotent after gameover)', () => {
    const s = pvpState(2);
    s.players[1]!.alive = false;
    new WinConditionSystem().tick(s);
    expect(s.winner).toBe(0);
    s.players[0]!.alive = false; // both now dead — should NOT retrigger tiebreak logic
    new WinConditionSystem().tick(s);
    expect(s.winner).toBe(0); // unchanged
  });

  it('same-tick double elimination breaks the tie by ascending teamId, never a coin flip', () => {
    const s = pvpState(4);
    const sys = new WinConditionSystem();
    s.players[1]!.alive = false; // down to {0, 2, 3}
    sys.tick(s);
    expect(s.placements).toEqual([1]);

    // Seats 0 and 2 both die on the SAME tick — only seat 3 would naturally survive,
    // but to specifically exercise the zero-survivors tiebreak we kill every
    // remaining seat simultaneously instead of leaving one standing.
    s.players[0]!.alive = false;
    s.players[2]!.alive = false;
    s.players[3]!.alive = false;
    sys.tick(s);

    // teamId === seat index here, so the lowest surviving-until-now teamId (0) wins.
    expect(s.winner).toBe(0);
    expect(s.phase).toBe('gameover');
    // The winner must never also appear in placements (it's 1st, not a loser).
    expect(s.placements).not.toContain(0);
    expect(s.placements.sort()).toEqual([1, 2, 3]);
  });
});
