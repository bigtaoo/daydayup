/**
 * TutorialHintController (design/10 screen-flow gap — the tutorial level's teaching
 * beats). Driven with a fake HudView-shaped host (only `.toast` is called) and a real
 * `GameState` fixture (same `createGameState` convention as RunOutcome.test.ts), so this
 * stays a pure state+events reaction test with no Pixi/engine dependency beyond the
 * state shape itself.
 */
import { describe, it, expect, vi } from 'vitest';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import type { GameEvent } from '@dd/engine/state/events';
import { TutorialHintController } from './TutorialHintController';

function fakeHud() {
  return { toast: vi.fn() };
}

function baseState(): GameState {
  return createGameState({ seed: 1, worldW: 900, worldH: 900, waves: [] });
}

const NO_EVENTS: readonly GameEvent[] = [];

describe('TutorialHintController — move step', () => {
  it('shows the move hint once on the first tick', () => {
    const hud = fakeHud();
    const c = new TutorialHintController(hud as never, { localOwner: 0 });
    const s = baseState();
    c.consume(s, NO_EVENTS);
    expect(hud.toast).toHaveBeenCalledTimes(1);
    expect(hud.toast).toHaveBeenCalledWith('Move: left stick / WASD.  Aim & fire: right stick / mouse.', expect.anything());
  });

  it('does not re-show the same hint every tick', () => {
    const hud = fakeHud();
    const c = new TutorialHintController(hud as never, { localOwner: 0 });
    const s = baseState();
    for (let i = 0; i < 10; i++) {
      c.consume(s, NO_EVENTS);
      s.tick++;
    }
    expect(hud.toast).toHaveBeenCalledTimes(1);
  });
});

describe('TutorialHintController — swap step', () => {
  it('advances to the swap hint once the move window elapses', () => {
    const hud = fakeHud();
    const c = new TutorialHintController(hud as never, { localOwner: 0 });
    const s = baseState();
    for (let i = 0; i < 91; i++) {
      c.consume(s, NO_EVENTS);
      s.tick++;
    }
    expect(hud.toast).toHaveBeenLastCalledWith('Tap the weapon-swap button to switch loadout slots.', expect.anything());
  });

  it('advances to the deflect hint once activeSlot changes from its swap-step baseline', () => {
    const hud = fakeHud();
    const c = new TutorialHintController(hud as never, { localOwner: 0 });
    const s = baseState();
    for (let i = 0; i < 91; i++) {
      c.consume(s, NO_EVENTS);
      s.tick++;
    }
    s.players[0]!.activeSlot = 1; // the player swapped weapons
    c.consume(s, NO_EVENTS);
    expect(hud.toast).toHaveBeenLastCalledWith('Swing your melee weapon into incoming bullets to deflect them.', expect.anything());
  });
});

describe('TutorialHintController — deflect step', () => {
  function reachDeflectStep(c: TutorialHintController, s: GameState) {
    for (let i = 0; i < 91; i++) {
      c.consume(s, NO_EVENTS);
      s.tick++;
    }
    s.players[0]!.activeSlot = 1;
    c.consume(s, NO_EVENTS);
  }

  it('advances to done once a deflect event fires', () => {
    const hud = fakeHud();
    const c = new TutorialHintController(hud as never, { localOwner: 0 });
    const s = baseState();
    reachDeflectStep(c, s);
    hud.toast.mockClear();
    c.consume(s, [{ type: 'deflect', gx: 0, gy: 0 } as GameEvent]);
    expect(hud.toast).toHaveBeenCalledWith('Nicely done — head to the portal.', expect.anything());
  });

  it('stays done and shows nothing further on later ticks', () => {
    const hud = fakeHud();
    const c = new TutorialHintController(hud as never, { localOwner: 0 });
    const s = baseState();
    reachDeflectStep(c, s);
    c.consume(s, [{ type: 'deflect', gx: 0, gy: 0 } as GameEvent]);
    hud.toast.mockClear();
    s.tick++;
    c.consume(s, NO_EVENTS);
    expect(hud.toast).not.toHaveBeenCalled();
  });
});
