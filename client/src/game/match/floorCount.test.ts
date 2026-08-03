/**
 * totalFloorCount (design/10 screen-flow gap fix) — three render-side call sites
 * (Game.ts's checkpoint gate, HudView's floor chip, RunOutcome's result line) used to
 * hardcode `EMBER_DUNGEON.floorCount` instead of reading the real config; this pins the
 * mode-generic replacement against real `createGameState` fixtures for every mode.
 */
import { describe, it, expect } from 'vitest';
import { createGameState, EMBER_DUNGEON, EMBER_ROOMS, type DungeonConfig } from '@dd/engine';
import { totalFloorCount } from './floorCount';

const TINY_DUNGEON: DungeonConfig = {
  ...EMBER_DUNGEON,
  floorCount: 5,
};

describe('totalFloorCount', () => {
  it('reads dungeonConfig.floorCount when dungeonEnabled', () => {
    const s = createGameState({
      seed: 1, worldW: 800, worldH: 800, waves: [],
      dungeon: { config: TINY_DUNGEON, library: EMBER_ROOMS },
    });
    expect(s.dungeonEnabled).toBe(true);
    expect(totalFloorCount(s)).toBe(5);
  });

  it('is extraFloors.length + 1 when floorsEnabled (flat, non-dungeon mode)', () => {
    const s = createGameState({
      seed: 1, worldW: 800, worldH: 800, waves: [],
      floors: [[[[100, 100]]], [[[200, 200]]], [[[300, 300]]]], // 3 extra floors → 4 total
    });
    expect(s.dungeonEnabled).toBe(false);
    expect(s.floorsEnabled).toBe(true);
    expect(totalFloorCount(s)).toBe(4);
  });

  it('is 1 + extraFloors.length even for a single-extra-floor (2-floor) flat config, like the tutorial', () => {
    const s = createGameState({
      seed: 1, worldW: 800, worldH: 800, waves: [],
      floors: [[[[100, 100]]]], // 1 extra floor → 2 total
    });
    expect(totalFloorCount(s)).toBe(2);
  });

  it('falls back to EMBER_DUNGEON.floorCount for a bare state with no floors/dungeon concept at all', () => {
    const s = createGameState({ seed: 1, worldW: 800, worldH: 800, waves: [] });
    expect(s.dungeonEnabled).toBe(false);
    expect(s.floorsEnabled).toBe(false);
    expect(totalFloorCount(s)).toBe(EMBER_DUNGEON.floorCount);
  });
});
