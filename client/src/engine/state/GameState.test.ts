import { describe, it, expect } from 'vitest';
import { createGameState } from '@dd/engine/state/GameState';
import { toFp } from '@dd/engine/math/fixed';

const CONFIG = {
  seed: 12345,
  worldW: 1600,
  worldH: 1200,
  waves: [[[300, 300] as const, [1300, 300] as const]],
};

describe('GameState (plain data, design/08 schema)', () => {
  it('constructs idle at tick 0 with a single player at the world centre', () => {
    const s = createGameState(CONFIG);
    expect(s.phase).toBe('idle');
    expect(s.tick).toBe(0);
    expect(s.players).toHaveLength(1);
    expect(s.players[0]!.gx).toBe(toFp(800));
    expect(s.players[0]!.gy).toBe(toFp(600));
    expect(s.players[0]!.weapon?.spec.kind).toBe('ranged');
    expect(s.enemies).toHaveLength(0);
  });

  it('nextId() is state-local and monotonic (no module global)', () => {
    const a = createGameState(CONFIG);
    const b = createGameState(CONFIG);
    // player took id 1 in each; both counters are independent and reproducible.
    expect(a.nextId()).toBe(2);
    expect(a.nextId()).toBe(3);
    expect(b.nextId()).toBe(2); // b's counter is not perturbed by a
  });

  it('injects distinct-seed PRNGs so streams do not alias', () => {
    const s = createGameState(CONFIG);
    const ai = s.aiPrng.nextInt(1_000_000);
    const combat = s.combatPrng.nextInt(1_000_000);
    const drop = s.dropPrng.nextInt(1_000_000);
    expect(new Set([ai, combat, drop]).size).toBe(3);
  });

  it('same seed → identical PRNG draws (replay foundation)', () => {
    const a = createGameState(CONFIG);
    const b = createGameState(CONFIG);
    expect(a.dropPrng.nextInt(1000)).toBe(b.dropPrng.nextInt(1000));
  });
});
