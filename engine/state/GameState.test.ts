import { describe, it, expect } from 'vitest';
import { createGameState } from '@dd/engine/state/GameState';
import { pxToFp } from '@dd/engine/content/convert';
import { PVP_SCALE_FACTOR } from '@dd/engine/balance/build';
import { BLASTER_SIM } from '@dd/engine/content/weapons';
import { SKIN_DEFS, DEFAULT_SKIN_ID } from '@dd/engine/content/skins';
import type { ArenaMap } from '@dd/engine/content/arenas';

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
    expect(s.players[0]!.gx).toBe(pxToFp(800)); // world centre, px → grid-fp
    expect(s.players[0]!.gy).toBe(pxToFp(600));
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

describe('GameState.buildSeat — buildArenaSpecs wiring (design/15, ROADMAP 4.2c)', () => {
  const MINI_MAP: ArenaMap = {
    id: 'mini',
    sizeGrid: { w: 10, h: 10 },
    rooms: [{ id: 'A', rectGrid: { x: 0, y: 0, w: 10, h: 10 }, solids: [] }],
    doors: [],
    spawns: [{ x: 5, y: 5 }],
    eyeCandidates: [{ roomId: 'A' }],
  };

  it('an arena seat gets buildArenaSpecs\' scaled HP/shield and landing-kit weapon, ignoring loadout', () => {
    const s = createGameState({
      seed: 1, worldW: 0, worldH: 0, waves: [], arena: MINI_MAP,
      players: [{ teamId: 0, loadout: ['saber'] }], // a PvE weapon id — must be ignored in arena mode
    });
    const p = s.players[0]!;
    const defaultSkin = SKIN_DEFS[DEFAULT_SKIN_ID]!;
    expect(p.maxHp).toBe(Math.round(defaultSkin.maxHp * PVP_SCALE_FACTOR));
    expect(p.maxShield).toBe(Math.round(defaultSkin.maxShield * PVP_SCALE_FACTOR));
    expect(p.hp).toBe(p.maxHp); // spawns full
    expect(p.shield).toBe(p.maxShield);
    expect(p.weapon?.spec.damage).toBe(Math.round(BLASTER_SIM.damage * PVP_SCALE_FACTOR)); // landing kit, not 'saber'
  });

  it('an arena seat scales the RIGHT character\'s stats by skinId', () => {
    const s = createGameState({
      seed: 1, worldW: 0, worldH: 0, waves: [], arena: MINI_MAP,
      players: [{ teamId: 0, skinId: 'juggernaut' }],
    });
    const juggernaut = SKIN_DEFS['juggernaut']!;
    expect(s.players[0]!.maxHp).toBe(Math.round(juggernaut.maxHp * PVP_SCALE_FACTOR));
  });

  it('a non-arena config is completely unaffected — plain unscaled SkinDef stats + real loadout', () => {
    const s = createGameState({
      seed: 1, worldW: 800, worldH: 600, waves: [],
      players: [{ teamId: 0 }],
    });
    const defaultSkin = SKIN_DEFS[DEFAULT_SKIN_ID]!;
    expect(s.players[0]!.maxHp).toBe(defaultSkin.maxHp); // unscaled
    expect(s.players[0]!.weapon?.spec.damage).toBe(BLASTER_SIM.damage); // unscaled default weapon
  });
});
