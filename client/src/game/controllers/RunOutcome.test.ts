/**
 * RunOutcome (design/10 result-screen content, ROADMAP 2026-07-29) — pure reaction
 * logic driven off a real `GameState` fixture (via the engine's own `createGameState`,
 * same convention as `engine/systems/placement.test.ts`'s `pvpState`
 * helper) and a mock `RunOutcomeHost` that records every call instead of touching
 * Pixi/Game.ts (which this file, by design, never imports).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { setLocale, resetLocaleForTests } from '../../i18n';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import type { ArenaMap } from '@dd/engine/content/arenas';
import { EMBER_DUNGEON, TICK_RATE } from '@dd/engine';
import { RunOutcome, type RunOutcomeHost } from './RunOutcome';
import { SCORE } from '../score';

const MINI_MAP: ArenaMap = {
  id: 'mini',
  sizeGrid: { w: 10, h: 10 },
  rooms: [{ id: 'A', rectGrid: { x: 0, y: 0, w: 10, h: 10 }, solids: [] }],
  doors: [],
  spawns: [{ x: 5, y: 5 }],
  eyeCandidates: [{ roomId: 'A' }],
};

function pveState(): GameState {
  return createGameState({ seed: 1, worldW: 0, worldH: 0, waves: [] });
}

function pvpState(seatCount: number): GameState {
  const players = Array.from({ length: seatCount }, (_, i) => ({ teamId: i }));
  return createGameState({ seed: 1, worldW: 0, worldH: 0, waves: [], arena: MINI_MAP, players });
}

interface RecordedHost extends RunOutcomeHost {
  readonly phaseSet: ('victory' | 'defeat')[];
  readonly hudHidden: boolean;
  readonly banked: GameState[];
  readonly shown: { won: boolean; title: string; lines: readonly string[] } | undefined;
}

function mockHost(localOwner = 0): RecordedHost {
  let score = 0;
  const phaseSet: ('victory' | 'defeat')[] = [];
  const banked: GameState[] = [];
  let hudHidden = false;
  let shown: { won: boolean; title: string; lines: readonly string[] } | undefined;
  return {
    localOwner,
    addScore: (delta) => { score += delta; },
    currentScore: () => score,
    setPhase: (p) => { phaseSet.push(p); },
    hideHud: () => { hudHidden = true; },
    bankRunMaterials: (s) => { banked.push(s); },
    showOutcomeScreen: (won, title, lines) => { shown = { won, title, lines }; },
    get phaseSet() { return phaseSet; },
    get hudHidden() { return hudHidden; },
    get banked() { return banked; },
    get shown() { return shown; },
  };
}

afterEach(() => resetLocaleForTests());

describe('RunOutcome — PvE extraction/death', () => {
  it('win (extract): banks materials, victory phase, shows floor/materials/time/score', () => {
    const s = pveState();
    s.floorIndex = 2; // floor 3
    s.bankedMaterials = { fire: 3, ice: 2 };
    s.tick = TICK_RATE * 97 + 15; // 1:37, ticks past the minute boundary ignored

    const host = mockHost();
    new RunOutcome(host).handle(s);

    expect(host.phaseSet).toEqual(['victory']);
    expect(host.hudHidden).toBe(true);
    expect(host.banked).toEqual([s]);
    expect(host.currentScore()).toBe(SCORE.victory);
    expect(host.shown).toEqual({
      won: true,
      title: 'EXTRACTED',
      lines: [
        `Floor 3/${EMBER_DUNGEON.floorCount}`,
        'Materials banked: 5',
        'Time 1:37',
        `Score ${SCORE.victory}`,
      ],
    });
  });

  it('lose (death): no banking, no score, shows floor/loss/time/score', () => {
    const s = pveState();
    s.floorIndex = 0; // floor 1
    s.bankedMaterials = { fire: 9 }; // forfeited — never reaches bankRunMaterials
    s.winner = 'enemies';
    s.tick = 0;

    const host = mockHost();
    new RunOutcome(host).handle(s);

    expect(host.phaseSet).toEqual(['defeat']);
    expect(host.hudHidden).toBe(true);
    expect(host.banked).toEqual([]);
    expect(host.currentScore()).toBe(0);
    expect(host.shown).toEqual({
      won: false,
      title: 'DEFEAT',
      lines: [
        `Fell on floor 1/${EMBER_DUNGEON.floorCount}`,
        "The floor's materials were lost",
        'Time 0:00',
        'Score 0',
      ],
    });
  });

  it('a zero-material extraction still shows "Materials banked: 0", not blank', () => {
    const s = pveState();
    const host = mockHost();
    new RunOutcome(host).handle(s);
    expect(host.shown?.lines).toContain('Materials banked: 0');
  });
});

describe('RunOutcome — PvP arena victory/elimination', () => {
  it('winArena: local seat is the recorded winner — victory phase, placement text, no banking', () => {
    const s = pvpState(4);
    s.winner = 0; // localOwner's seat
    s.tick = TICK_RATE * 65; // 1:05

    const host = mockHost(0);
    new RunOutcome(host).handle(s);

    expect(host.phaseSet).toEqual(['victory']);
    expect(host.banked).toEqual([]); // no materials/floor concept in arena mode
    expect(host.currentScore()).toBe(SCORE.victory);
    expect(host.shown).toEqual({
      won: true,
      title: 'VICTORY ROYALE',
      lines: ['1st place of 4', 'Time 1:05', `Score ${SCORE.victory}`],
    });
  });

  it('loseArena: placement computed from worst-to-best `placements`, winner never in it', () => {
    const s = pvpState(4);
    s.winner = 3; // seat 3 won, not the local seat
    s.placements.push(1, 2, 0); // worst-first: seat 1 eliminated first, local seat (0) last of the losers
    s.tick = 0;

    const host = mockHost(0);
    new RunOutcome(host).handle(s);

    expect(host.phaseSet).toEqual(['defeat']);
    // placements.indexOf(0) === 2 (third listed) → place = players.length(4) - 2 = 2nd
    expect(host.shown?.lines[0]).toBe('Placed 2/4');
  });

  it('loseArena: a seat missing from `placements` (should not happen, but defends the read) falls back to last place', () => {
    const s = pvpState(3);
    s.winner = 1;
    s.placements.push(2); // local seat (0) absent
    const host = mockHost(0);
    new RunOutcome(host).handle(s);
    expect(host.shown?.lines[0]).toBe('Placed 3/3');
  });
});

describe('RunOutcome — i18n (design/17-i18n.md)', () => {
  it('win (extract) under zh: translated title/lines, `won` stays a real boolean, not display text', () => {
    setLocale('zh');
    const s = pveState();
    s.floorIndex = 2;
    s.bankedMaterials = { fire: 3, ice: 2 };
    s.tick = TICK_RATE * 97 + 15;

    const host = mockHost();
    new RunOutcome(host).handle(s);

    expect(host.shown?.won).toBe(true);
    expect(host.shown?.title).toBe('撤离成功');
    expect(host.shown?.lines).toEqual([
      `楼层 3/${EMBER_DUNGEON.floorCount}`,
      '已存入材料：5',
      '用时 1:37',
      `分数 ${SCORE.victory}`,
    ]);
  });

  it('lose (death) under zh: translated title/lines, `won` is false', () => {
    setLocale('zh');
    const s = pveState();
    s.floorIndex = 0;
    s.winner = 'enemies';
    s.tick = 0;

    const host = mockHost();
    new RunOutcome(host).handle(s);

    expect(host.shown?.won).toBe(false);
    expect(host.shown?.title).toBe('战败');
    expect(host.shown?.lines).toContain('本层材料已全部丢失');
  });

  it('switching back to English produces the original English copy again', () => {
    const s = pveState();
    setLocale('zh');
    new RunOutcome(mockHost()).handle(s);
    setLocale('en');
    const host = mockHost();
    new RunOutcome(host).handle(s);
    expect(host.shown?.title).toBe('EXTRACTED');
  });
});

// design/10 screen-flow gap: win()/lose() used to hardcode EMBER_DUNGEON.floorCount for
// the "Floor N/M" line regardless of the run's actual config — wrong for a flat
// (non-dungeon) floors config like the tutorial level (ROADMAP totalFloorCount fix).
describe('RunOutcome — a flat (non-dungeon) floors config reports its own floor count', () => {
  function flatFloorsState(): GameState {
    return createGameState({ seed: 1, worldW: 0, worldH: 0, waves: [], floors: [[[[100, 100]]]] }); // 1 extra floor → 2 total
  }

  it('win (extract): "Floor N/2", not the ember-dungeon default', () => {
    const s = flatFloorsState();
    s.floorIndex = 0; // floor 1 of 2
    expect(s.dungeonEnabled).toBe(false);

    const host = mockHost();
    new RunOutcome(host).handle(s);

    expect(host.shown?.lines[0]).toBe('Floor 1/2');
  });

  it('lose (death): "Fell on floor N/2", not the ember-dungeon default', () => {
    const s = flatFloorsState();
    s.floorIndex = 1; // floor 2 of 2 (the last floor)
    s.winner = 'enemies';

    const host = mockHost();
    new RunOutcome(host).handle(s);

    expect(host.shown?.lines[0]).toBe('Fell on floor 2/2');
  });
});
