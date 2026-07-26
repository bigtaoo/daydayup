/**
 * PvpBotController — the PvP practice bot (design/15 follow-up). Mirrors ally.test.ts's
 * structure: verifies it engages the nearest LIVING opponent on a different team (aim +
 * fire in range, hold spacing), ignores teammates and downed/dead seats, idles with no
 * opponents left, and — the point of it — that a real multi-seat engine SIMULATES the
 * bot's commands (a bot-controlled seat actually moves under its own control through
 * step(), exactly like AllyController's co-op counterpart).
 */
import { describe, it, expect } from 'vitest';
import { createGameEngine } from '@dd/engine/GameEngine';
import { createGameState } from '@dd/engine/state/GameState';
import { Button } from '@dd/engine/state/commands';
import { makeCommand } from '@dd/engine/state/input';
import { BRAD_FULL, type Brad } from '@dd/engine/math/trig';
import { PvpBotController } from './PvpBotController';

const bot = new PvpBotController();
const CFG = { seed: 3, worldW: 1600, worldH: 1200, waves: [] as const };

describe('PvpBotController — command generation', () => {
  it('aims at and fires on the nearest opposing-team seat, advancing while outside spacing', () => {
    const s = createGameState({
      ...CFG,
      players: [{ start: [400, 400], teamId: 0 }, { start: [620, 400], teamId: 1 }],
    });
    const cmd = bot.build(s, 0, 5); // ~6 grid east — in fire range, outside keep-dist
    expect(cmd.buttons & Button.FIRE).toBeTruthy();
    expect(cmd.aimBrad).toBe(0); // due east (dx>0, dy=0 → brad 0)
    expect(cmd.moveMag).toBeGreaterThan(0);
  });

  it('holds position (stops advancing) once inside spacing but keeps firing', () => {
    const s = createGameState({
      ...CFG,
      players: [{ start: [400, 400], teamId: 0 }, { start: [500, 400], teamId: 1 }],
    });
    const cmd = bot.build(s, 0, 5); // ~2.5 grid east — inside keep-dist
    expect(cmd.buttons & Button.FIRE).toBeTruthy();
    expect(cmd.moveMag).toBe(0);
  });

  it('ignores a same-team seat and holds fire when no opponent remains', () => {
    const s = createGameState({
      ...CFG,
      players: [{ start: [400, 400], teamId: 0 }, { start: [420, 400], teamId: 0 }],
    });
    const cmd = bot.build(s, 0, 5);
    expect(cmd.buttons).toBe(0);
    expect(cmd.moveMag).toBe(0); // idle, not regroup — PvP has no leader concept
  });

  it('skips a downed/dead opponent and targets the next-nearest live one instead', () => {
    const s = createGameState({
      ...CFG,
      players: [
        { start: [400, 400], teamId: 0 },
        { start: [420, 400], teamId: 1 }, // nearest, but downed — must be ignored
        { start: [200, 400], teamId: 2 }, // farther but alive — the real target (due west)
      ],
    });
    s.players[1]!.downed = true;
    const cmd = bot.build(s, 0, 5);
    expect(cmd.aimBrad).toBe(BRAD_FULL / 2); // due west toward seat 2, not east toward seat 1
  });

  it('a downed bot issues an idle command (it cannot act)', () => {
    const s = createGameState({
      ...CFG,
      players: [{ start: [400, 400], teamId: 0 }, { start: [420, 400], teamId: 1 }],
    });
    s.players[0]!.downed = true;
    const cmd = bot.build(s, 0, 5);
    expect(cmd.moveMag).toBe(0);
    expect(cmd.buttons).toBe(0);
  });
});

describe('two-seat run: the bot actually drives its seat through step()', () => {
  it('closes the gap on the opposing seat under bot control (real engine simulation)', () => {
    const eng = createGameEngine({
      ...CFG,
      players: [{ start: [400, 400], teamId: 0 }, { start: [900, 400], teamId: 1 }],
    });

    const gapTo = () => Math.abs(eng.state.players[0]!.gx - eng.state.players[1]!.gx);
    const startGap = gapTo();
    for (let t = 1; t <= 40; t++) {
      const s = eng.state;
      const cmds = [bot.build(s, 0, t), bot.build(s, 1, t)];
      eng.step(cmds);
    }
    expect(gapTo()).toBeLessThan(startGap); // both bots closed toward each other
  });

  it('a bot with no live opponent left holds position (idle, not wandering)', () => {
    const eng = createGameEngine({
      ...CFG,
      players: [{ start: [400, 400], teamId: 0 }, { start: [900, 400], teamId: 1 }],
    });
    eng.state.players[1]!.alive = false; // last seat standing

    const startX = eng.state.players[0]!.gx;
    for (let t = 1; t <= 10; t++) {
      eng.step([bot.build(eng.state, 0, t), makeCommand({ owner: 1, tick: t, moveBrad: 0 as Brad, moveMag: 0, aimBrad: 0 as Brad, buttons: 0 })]);
    }
    expect(eng.state.players[0]!.gx).toBe(startX); // held position — no opponent to chase
  });
});
