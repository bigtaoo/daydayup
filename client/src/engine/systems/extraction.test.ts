/**
 * Extraction rooms + materials carry-out (design/05, ROADMAP 1.4/1.5). ExtractionSystem
 * is a no-op unless EngineConfig.floors is set (additive, no ENGINE_VERSION bump —
 * see config.ts's note); these tests cover both the floors-enabled behavior and the
 * floors-disabled regression (old configs must be byte-identical to before).
 *
 * The checkpoint gesture (design/10 legibility pass, ENGINE_VERSION 31) resolves from
 * explicit one-shot `Button.CONFIRM_EXTRACT`/`CONFIRM_DESCEND` presses (a render-side
 * portal + popup), not the original hold-to-extract/tap-to-descend INTERACT timer.
 */
import { describe, it, expect } from 'vitest';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState, EngineConfig } from '@dd/engine/state/GameState';
import { Prng } from '@dd/engine/math/prng';
import { rollDrop } from '@dd/engine/content/drops';
import { createGameEngine } from '@dd/engine/GameEngine';
import { Button } from '@dd/engine/state/commands';
import { makeCommand } from '@dd/engine/state/input';
import type { Brad } from '@dd/engine/math/trig';
import { ExtractionSystem, PickupSystem, WinConditionSystem } from '@dd/engine/systems';

// Two floors total: floor 0 (config.waves) is NOT last (extraFloors.length === 1);
// floor 1 (extraFloors[0]) IS last (floorIndex 1 >= extraFloors.length 1).
const FLOORS_CFG: EngineConfig = {
  seed: 1,
  worldW: 800,
  worldH: 600,
  playerStart: [400, 300],
  waves: [[[600, 300]]],
  floors: [[[[600, 300]]]],
};

function atCheckpoint(s: GameState): void {
  s.wavesExhausted = true;
  s.enemies.length = 0;
}

describe('ExtractionSystem — no-op unless floorsEnabled', () => {
  it('does nothing for a config without `floors` (regression: old auto-win path stays live)', () => {
    const s = createGameState({ seed: 1, worldW: 800, worldH: 600, waves: [] });
    atCheckpoint(s);
    new ExtractionSystem().tick(s);
    expect(s.phase).not.toBe('gameover');
    new WinConditionSystem().tick(s); // the pre-1.4 win path must still fire
    expect(s.phase).toBe('gameover');
    expect(s.winner).toBe(0);
  });
});

describe('ExtractionSystem — DESCEND (explicit confirmDescend press)', () => {
  it('banks the floor buffer, advances the floor, and reloads its waves', () => {
    const s = createGameState(FLOORS_CFG);
    s.floorMaterials.mat_fire = 3;
    atCheckpoint(s);
    const p = s.players[0]!;

    p.confirmDescend = true;
    new ExtractionSystem().tick(s);

    expect(s.floorIndex).toBe(1);
    expect(s.waves).toEqual(FLOORS_CFG.floors![0]);
    expect(s.waveIndex).toBe(-1);
    expect(s.wavesExhausted).toBe(false);
    expect(s.bankedMaterials.mat_fire).toBe(3);
    expect(s.floorMaterials).toEqual({});
    expect(s.events.some((e) => e.type === 'descend' && e.floorIndex === 1)).toBe(true);
    expect(s.phase).not.toBe('gameover');
  });

  it('does not resolve while confirmDescend is unset', () => {
    const s = createGameState(FLOORS_CFG);
    atCheckpoint(s);
    new ExtractionSystem().tick(s); // no popup choice pressed at all
    expect(s.floorIndex).toBe(0);
    expect(s.phase).not.toBe('gameover');
  });

  it('clears leftover pickups on descend', () => {
    const s = createGameState(FLOORS_CFG);
    atCheckpoint(s);
    s.pickups.push({ id: s.nextId(), kind: 'heal', gx: s.worldW, gy: s.worldH, spawnTick: 0, alive: true });
    const p = s.players[0]!;
    p.confirmDescend = true;
    new ExtractionSystem().tick(s);
    expect(s.pickups).toHaveLength(0);
  });
});

describe('ExtractionSystem — EXTRACT (explicit confirmExtract press)', () => {
  it('banks the floor buffer and ends the run as a win, without advancing the floor', () => {
    const s = createGameState(FLOORS_CFG);
    s.floorMaterials.mat_ice = 2;
    atCheckpoint(s);
    const p = s.players[0]!;
    p.confirmExtract = true;
    new ExtractionSystem().tick(s);

    expect(s.phase).toBe('gameover');
    expect(s.winner).toBe(0);
    expect(s.floorIndex).toBe(0); // never descended
    expect(s.bankedMaterials.mat_ice).toBe(2);
    expect(s.events.some((e) => e.type === 'win' && e.winner === 0)).toBe(true);
  });

  it('confirmExtract wins out over a simultaneous confirmDescend on the same tick', () => {
    const s = createGameState(FLOORS_CFG);
    atCheckpoint(s);
    const p = s.players[0]!;
    p.confirmExtract = true;
    p.confirmDescend = true;
    new ExtractionSystem().tick(s);
    expect(s.phase).toBe('gameover');
  });
});

describe('ExtractionSystem — the last floor auto-resolves as EXTRACT (no gesture needed)', () => {
  it('reaching the checkpoint on the last floor ends the run immediately', () => {
    const s = createGameState(FLOORS_CFG);
    s.floorIndex = 1; // the last floor (extraFloors.length === 1)
    s.floorMaterials.mat_poison = 4;
    atCheckpoint(s);
    new ExtractionSystem().tick(s); // no popup choice needed at all
    expect(s.phase).toBe('gameover');
    expect(s.winner).toBe(0);
    expect(s.bankedMaterials.mat_poison).toBe(4);
  });
});

describe('Death forfeits only the current floor\'s un-banked buffer', () => {
  it('a run-ending death never merges floorMaterials into bankedMaterials', () => {
    const s = createGameState(FLOORS_CFG);
    s.floorMaterials.mat_fire = 5;
    s.players[0]!.alive = false; // simulate DeathDropsSystem having downed the player
    new WinConditionSystem().tick(s); // death check runs BEFORE the floorsEnabled guard
    expect(s.winner).toBe('enemies');
    expect(s.bankedMaterials.mat_fire).toBeUndefined();
    expect(s.floorMaterials.mat_fire).toBe(5); // still there — simply never banked
  });
});

describe('PickupSystem — materials accumulate into the floor buffer', () => {
  it('sums quantities across multiple pickups of the same material id', () => {
    const s = createGameState(FLOORS_CFG);
    s.tick = 5;
    const p = s.players[0]!;
    s.pickups.push(
      { id: s.nextId(), kind: 'material', gx: p.gx, gy: p.gy, spawnTick: 0, alive: true, materialId: 'mat_fire', qty: 1 },
    );
    new PickupSystem().tick(s);
    s.pickups.push(
      { id: s.nextId(), kind: 'material', gx: p.gx, gy: p.gy, spawnTick: 0, alive: true, materialId: 'mat_fire', qty: 1 },
    );
    new PickupSystem().tick(s);
    s.pickups.push(
      { id: s.nextId(), kind: 'material', gx: p.gx, gy: p.gy, spawnTick: 0, alive: true, materialId: 'mat_ice', qty: 1 },
    );
    new PickupSystem().tick(s);
    expect(s.floorMaterials.mat_fire).toBe(2);
    expect(s.floorMaterials.mat_ice).toBe(1);
  });
});

describe('Materials tier by depth (ROADMAP 1.5)', () => {
  it('rollDrop tags a material drop with the passed tier; default is 0 (old callers unaffected)', () => {
    const p = new Prng(3);
    for (let i = 0; i < 200; i++) {
      const d = rollDrop(p, 4);
      if (d.kind === 'material') expect(d.tier).toBe(4);
    }
    const p2 = new Prng(3);
    for (let i = 0; i < 200; i++) {
      const d = rollDrop(p2);
      if (d.kind === 'material') expect(d.tier).toBe(0);
    }
  });
});

describe('Integration — full engine step() drives the extraction gesture via real input', () => {
  it('pressing CONFIRM_EXTRACT at a checkpoint through createGameEngine resolves EXTRACT', () => {
    const eng = createGameEngine(FLOORS_CFG);
    atCheckpoint(eng.state); // shortcut past clearing the actual wave
    eng.step([makeCommand({ owner: 0, tick: 1, moveBrad: 0 as Brad, moveMag: 0, aimBrad: 0 as Brad, buttons: Button.CONFIRM_EXTRACT })]);
    expect(eng.state.phase).toBe('gameover');
    expect(eng.state.winner).toBe(0);
  });

  it('pressing CONFIRM_DESCEND at a checkpoint resolves DESCEND', () => {
    const eng = createGameEngine(FLOORS_CFG);
    atCheckpoint(eng.state);
    eng.step([makeCommand({ owner: 0, tick: 1, moveBrad: 0 as Brad, moveMag: 0, aimBrad: 0 as Brad, buttons: Button.CONFIRM_DESCEND })]);
    expect(eng.state.floorIndex).toBe(1);
    expect(eng.state.phase).not.toBe('gameover');
  });

  it('a single-tick press only resolves once — the next idle tick does nothing further', () => {
    const eng = createGameEngine(FLOORS_CFG);
    atCheckpoint(eng.state);
    eng.step([makeCommand({ owner: 0, tick: 1, moveBrad: 0 as Brad, moveMag: 0, aimBrad: 0 as Brad, buttons: Button.CONFIRM_DESCEND })]);
    expect(eng.state.floorIndex).toBe(1);
    eng.step([]); // idle — no repeated descend
    expect(eng.state.floorIndex).toBe(1);
  });
});
