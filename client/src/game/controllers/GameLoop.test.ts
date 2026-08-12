/**
 * GameLoop (extracted from Game.ts 2026-08-12, CLAUDE.md "500-line file convention")
 * — the fixed-step sim + interpolated render main loop. Rendering/Pixi collaborators
 * (scene/fx/hud/touchControlsView/portalPrompt/roomBuilder/partyScreen/events/
 * runOutcome/tutorialHints) are faked (same "avoid a real renderer" convention
 * EventReactor.test.ts already uses for FxController) so this file tests GameLoop's
 * own orchestration logic — what it calls, with what arguments, in which branch —
 * against a REAL `createGameEngine` for the offline sim-stepping tests (same
 * convention as controllers/ally.test.ts), never against Game.ts, which this file,
 * by design, never imports.
 */
import { describe, it, expect, vi } from 'vitest';
import { createGameEngine, createGameState, buildEnemyActor, toFp, EMBER_DUNGEON, EMBER_ROOMS, type DungeonConfig } from '@dd/engine';
import type { CoopSession } from '../../net/CoopSession';
import type { InputSource, InputState, TouchVisual } from '../../platform/types';
import { CommandBuilder } from './CommandBuilder';
import { AllyController } from './AllyController';
import { GameLoop, type GameLoopDeps, type GameLoopHost } from './GameLoop';

const CFG = { seed: 3, worldW: 1600, worldH: 1200, waves: [] as const };
// A single sim tick's worth of render dt (matches GameLoop's own internal SIM_DT_MS,
// duplicated here as a plain literal since the constant itself is module-private).
const SIM_DT_MS_FOR_TESTS = 1000 / 30 + 1; // +1 to clear any floating-point rounding short

function fakeInput(initial: Partial<InputState> = {}): InputSource & { state: InputState } {
  const state: InputState = { moveX: 0, moveY: 0, firing: false, interacting: false, ...initial };
  const touchVisual: TouchVisual = {
    active: false, stickRadius: 40, move: null,
    fire: { cx: 0, cy: 0, r: 0, pressed: false },
    weapon1: { cx: 0, cy: 0, r: 0 }, weapon2: { cx: 0, cy: 0, r: 0 },
    interact: { cx: 0, cy: 0, r: 0, pressed: false },
  };
  return {
    state,
    onSwitchWeapon: null,
    attach: vi.fn(),
    read: () => state,
    getTouchVisual: () => touchVisual,
  };
}

function fakeScene() {
  return {
    player: undefined as { curX: number; curY: number } | undefined,
    interpolate: vi.fn(),
    reconcile: vi.fn(),
    positionLocal: vi.fn(),
    applyLighting: vi.fn(),
  };
}

function fakeFx() {
  return {
    consumeHitStop: vi.fn().mockReturnValue(false),
    updateFx: vi.fn(),
    updateCamera: vi.fn(),
    trailDot: vi.fn(),
    lights: { addPersistent: vi.fn(), removePersistent: vi.fn() },
  };
}

function fakeHud() {
  return { update: vi.fn(), weaponPickupPrompt: { isOpen: false } };
}

function fakeRoomBuilder() {
  return { setPortalOpen: vi.fn(), portalPx: null as { x: number; y: number } | null };
}

function fakePortalPrompt() {
  return { update: vi.fn(), isOpen: false };
}

function buildDeps() {
  const scene = fakeScene();
  const fx = fakeFx();
  const hud = fakeHud();
  const roomBuilder = fakeRoomBuilder();
  const portalPrompt = fakePortalPrompt();
  const touchControlsView = { update: vi.fn() };
  const partyScreen = { update: vi.fn() };
  const input = fakeInput();
  const builder = new CommandBuilder(input);
  const ally = new AllyController();
  const events = { consume: vi.fn() };
  const runOutcome = { handle: vi.fn() };
  const tutorialHints = { consume: vi.fn(), reset: vi.fn() };

  const deps: GameLoopDeps = {
    scene, fx, hud, touchControlsView, portalPrompt, roomBuilder, partyScreen,
    builder, ally, input, events, runOutcome, tutorialHints,
  } as unknown as GameLoopDeps;

  return { deps, scene, fx, hud, roomBuilder, portalPrompt, touchControlsView, partyScreen, input, builder, ally, events, runOutcome, tutorialHints };
}

function buildHost(overrides: Partial<GameLoopHost> = {}): GameLoopHost & { localOwner: number } {
  return {
    getPhase: () => 'playing',
    isOnline: () => false,
    isCoop: () => false,
    isArenaDemo: () => false,
    isTutorialActive: () => false,
    localOwner: 0,
    getEngine: () => null,
    getSession: () => null,
    activeState: () => null,
    currentScore: () => 0,
    selectedSkinId: () => 'vanguard',
    allySkinId: () => 'skirmisher',
    screenSize: () => ({ w: 800, h: 600 }),
    markTutorialSeen: vi.fn(),
    confirm: vi.fn(),
    ...overrides,
  };
}

describe('GameLoop.update — top-level phase dispatch', () => {
  it('paused: freezes the sim (no engine.submit) but keeps fx/interpolate animating', () => {
    const { deps, scene, fx } = buildDeps();
    const engine = createGameEngine(CFG);
    const submitSpy = vi.spyOn(engine, 'submit');
    const host = buildHost({ getPhase: () => 'paused', getEngine: () => engine });
    const loop = new GameLoop(deps, host);

    loop.update(16);

    expect(fx.updateFx).toHaveBeenCalled();
    expect(scene.interpolate).toHaveBeenCalledWith(1, 16);
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it('idle (menu): keeps fx fading and polls confirm, but menu never accepts a fire-edge confirm', () => {
    const { deps, input, partyScreen } = buildDeps();
    const host = buildHost({ getPhase: () => 'menu' });
    const loop = new GameLoop(deps, host);

    input.state.firing = true;
    loop.update(16);

    expect(partyScreen.update).toHaveBeenCalledWith(16);
    expect(host.confirm).not.toHaveBeenCalled(); // 'menu' doesn't accept fire-confirm (confirmEdge.ts)
  });

  it('idle (victory): a rising fire edge confirms exactly once, not on the held frame after', () => {
    const { deps, input } = buildDeps();
    const host = buildHost({ getPhase: () => 'victory' });
    const loop = new GameLoop(deps, host);

    input.state.firing = true;
    loop.update(16); // rising edge: false -> true
    loop.update(16); // still held: true -> true, no new edge

    expect(host.confirm).toHaveBeenCalledTimes(1);
  });

  it('playing + online routes to the online path (session-driven), never touching engine.submit', () => {
    const { deps } = buildDeps();
    const engine = createGameEngine(CFG);
    const submitSpy = vi.spyOn(engine, 'submit');
    const session = { started: false } as unknown as CoopSession;
    const host = buildHost({ isOnline: () => true, getEngine: () => engine, getSession: () => session });
    const loop = new GameLoop(deps, host);

    loop.update(16);

    expect(submitSpy).not.toHaveBeenCalled(); // offline stepSim never ran
  });
});

describe('GameLoop — offline sim stepping (advanceSim/stepSim)', () => {
  it('steps the engine at the fixed 30Hz cadence, not once per render frame', () => {
    const { deps } = buildDeps();
    const engine = createGameEngine(CFG);
    const advanceSpy = vi.spyOn(engine, 'advance');
    const host = buildHost({ getEngine: () => engine });
    const loop = new GameLoop(deps, host);

    loop.update(16); // < 1 sim tick (33.3ms) accumulated — no step yet
    expect(advanceSpy).not.toHaveBeenCalled();

    loop.update(20); // 36ms total accumulated — one tick's worth
    expect(advanceSpy).toHaveBeenCalledTimes(1);
  });

  it('caps catch-up at MAX_STEPS and drops the backlog after a long stall', () => {
    const { deps } = buildDeps();
    const engine = createGameEngine(CFG);
    const advanceSpy = vi.spyOn(engine, 'advance');
    const host = buildHost({ getEngine: () => engine });
    const loop = new GameLoop(deps, host);

    loop.update(10_000); // a huge stall (e.g. tab backgrounded) — must not spiral-of-death
    expect(advanceSpy.mock.calls.length).toBeLessThanOrEqual(5); // MAX_STEPS

    advanceSpy.mockClear();
    loop.update(16); // backlog was dropped, not carried — a normal frame steps at most once
    expect(advanceSpy.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('stepSim submits the local seat\'s command and advances the engine one frame', () => {
    const { deps, scene } = buildDeps();
    const engine = createGameEngine(CFG);
    const submitSpy = vi.spyOn(engine, 'submit');
    const host = buildHost({ getEngine: () => engine });
    const loop = new GameLoop(deps, host);

    loop.update(SIM_DT_MS_FOR_TESTS);

    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(submitSpy.mock.calls[0]![0].tick).toBe(1);
    expect(scene.reconcile).toHaveBeenCalledTimes(1);
  });

  it('coop: also submits the bot ally\'s command for every non-local seat', () => {
    const { deps } = buildDeps();
    const engine = createGameEngine({ ...CFG, players: [{ start: [400, 400] }, { start: [420, 400] }] });
    const submitSpy = vi.spyOn(engine, 'submit');
    const host = buildHost({ getEngine: () => engine, isCoop: () => true });
    const loop = new GameLoop(deps, host);

    loop.update(SIM_DT_MS_FOR_TESTS);

    expect(submitSpy).toHaveBeenCalledTimes(2); // local seat + one bot-driven seat
  });

  it('non-coop, non-arenaDemo: never drives the second seat, even if one exists', () => {
    const { deps } = buildDeps();
    const engine = createGameEngine({ ...CFG, players: [{ start: [400, 400] }, { start: [420, 400] }] });
    const submitSpy = vi.spyOn(engine, 'submit');
    const host = buildHost({ getEngine: () => engine }); // isCoop/isArenaDemo both default false
    const loop = new GameLoop(deps, host);

    loop.update(SIM_DT_MS_FOR_TESTS);

    expect(submitSpy).toHaveBeenCalledTimes(1);
  });

  it('feeds this tick\'s events to EventReactor and (while tutorialActive) TutorialHintController', () => {
    const { deps, events, tutorialHints } = buildDeps();
    const engine = createGameEngine(CFG);
    const host = buildHost({ getEngine: () => engine, isTutorialActive: () => true });
    const loop = new GameLoop(deps, host);

    loop.update(SIM_DT_MS_FOR_TESTS);

    expect(events.consume).toHaveBeenCalledTimes(1);
    expect(tutorialHints.consume).toHaveBeenCalledTimes(1);
  });

  it('does not feed TutorialHintController when the tutorial is not active', () => {
    const { deps, tutorialHints } = buildDeps();
    const engine = createGameEngine(CFG);
    const host = buildHost({ getEngine: () => engine, isTutorialActive: () => false });
    const loop = new GameLoop(deps, host);

    loop.update(SIM_DT_MS_FOR_TESTS);

    expect(tutorialHints.consume).not.toHaveBeenCalled();
  });
});

describe('GameLoop — hit-stop', () => {
  it('a consumed hit-stop freezes stepSim for that frame but still renders', () => {
    const { deps, fx, scene } = buildDeps();
    const engine = createGameEngine(CFG);
    const advanceSpy = vi.spyOn(engine, 'advance');
    fx.consumeHitStop.mockReturnValue(true);
    const host = buildHost({ getEngine: () => engine });
    const loop = new GameLoop(deps, host);

    loop.update(SIM_DT_MS_FOR_TESTS);

    expect(advanceSpy).not.toHaveBeenCalled();
    expect(scene.interpolate).toHaveBeenCalled(); // render still animates through the freeze
  });
});

describe('GameLoop — online path (advanceOnline)', () => {
  function fakeSession(overrides: Partial<CoopSession> = {}): CoopSession {
    return {
      started: true,
      frame: 5,
      state: createGameEngine(CFG).state,
      submit: vi.fn(),
      drive: vi.fn().mockReturnValue([]),
      reportResult: vi.fn(),
      ...overrides,
    } as unknown as CoopSession;
  }

  it('not yet started: holds the scene and keeps fx fading, without touching the session', () => {
    const { deps, scene, fx } = buildDeps();
    const session = fakeSession({ started: false });
    const host = buildHost({ isOnline: () => true, getSession: () => session });
    const loop = new GameLoop(deps, host);

    loop.update(16);

    expect(scene.interpolate).toHaveBeenCalledWith(1, 16);
    expect(fx.updateFx).toHaveBeenCalled();
    expect(session.submit).not.toHaveBeenCalled();
  });

  it('started: relays the local command, drives the session, and reconciles the scene', () => {
    const { deps, scene } = buildDeps();
    const session = fakeSession();
    const host = buildHost({ isOnline: () => true, getSession: () => session });
    const loop = new GameLoop(deps, host);

    loop.update(16);

    expect(session.submit).toHaveBeenCalledTimes(1);
    expect(session.drive).toHaveBeenCalledTimes(1);
    expect(scene.reconcile).toHaveBeenCalledTimes(1);
  });

  it('gameover: reports the result hash and hands off to RunOutcome exactly once', () => {
    const { deps, runOutcome } = buildDeps();
    const gameoverState = createGameEngine(CFG).state;
    gameoverState.phase = 'gameover';
    const session = fakeSession({ state: gameoverState });
    const host = buildHost({ isOnline: () => true, getSession: () => session });
    const loop = new GameLoop(deps, host);

    loop.update(16);

    expect(session.reportResult).toHaveBeenCalledTimes(1);
    expect(runOutcome.handle).toHaveBeenCalledTimes(1);
    expect(runOutcome.handle).toHaveBeenCalledWith(gameoverState);
  });
});

describe('GameLoop — reset hooks (run-lifecycle callbacks)', () => {
  it('resetForNewRun zeroes the accumulator, so the very next frame needs a full tick before stepping', () => {
    const { deps } = buildDeps();
    const engine = createGameEngine(CFG);
    const advanceSpy = vi.spyOn(engine, 'advance');
    const host = buildHost({ getEngine: () => engine });
    const loop = new GameLoop(deps, host);

    loop.update(30); // build up some, but not quite a full tick, of accumulator
    loop.resetForNewRun();
    loop.update(10); // would NOT have been enough on its own — confirms the reset actually zeroed it
    expect(advanceSpy).not.toHaveBeenCalled();
  });

  it('resetOnlinePrediction does not throw and leaves the loop usable for a fresh online run', () => {
    const { deps } = buildDeps();
    const host = buildHost({ isOnline: () => true, getSession: () => fakeOnlineSessionForReset() });
    const loop = new GameLoop(deps, host);
    expect(() => loop.resetOnlinePrediction()).not.toThrow();
    expect(() => loop.update(16)).not.toThrow();
  });

  function fakeOnlineSessionForReset(): CoopSession {
    return { started: false } as unknown as CoopSession;
  }
});

// Stuck-portal fix (2026-08-12): dungeon mode's `wavesExhausted` is never set
// (SpawnSystem.tick's dungeon branch returns before the line that sets it), so
// checkpointEligible used to be permanently false on any non-final floor — the
// portal never opened and the extract/descend popup never appeared. `updateHud`
// (private, called from `advanceSim` while `phase === 'playing'`) is exercised here
// via a real dungeon `GameState` from `host.activeState()` — dt stays under one sim
// tick so `stepSim`/`engine.submit` never runs, isolating just the checkpoint gate.
describe('GameLoop — portal/checkpoint eligibility (dungeon mode, 2026-08-12 stuck-portal fix)', () => {
  const TINY_DUNGEON: DungeonConfig = { ...EMBER_DUNGEON, floorCount: 5 };

  function dungeonStateWithRooms(roomCount: number) {
    const s = createGameState({
      seed: 1, worldW: 800, worldH: 800, waves: [],
      dungeon: { config: TINY_DUNGEON, library: EMBER_ROOMS },
    });
    for (let i = 0; i < roomCount; i++) {
      s.dungeonRoomRuntime.push({ activated: false, roomTick: 0, schedule: [], cursor: 0, hasLiveEnemy: false });
    }
    return s;
  }

  it('portal stays closed before the capstone room is cleared', () => {
    const { deps } = buildDeps();
    const s = dungeonStateWithRooms(2);
    const host = buildHost({ getPhase: () => 'playing', activeState: () => s });
    const loop = new GameLoop(deps, host);

    loop.update(16); // under one sim tick — engine.submit/stepSim never runs

    expect(deps.roomBuilder.setPortalOpen).toHaveBeenCalledWith(false);
  });

  it('THE FIX: portal opens once the capstone is cleared, even with a live enemy in another co-resident room', () => {
    const { deps } = buildDeps();
    const s = dungeonStateWithRooms(2);
    s.dungeonRoomRuntime[0]!.activated = true;
    s.dungeonRoomRuntime[0]!.hasLiveEnemy = true; // another room on the floor still has a mob up
    s.dungeonRoomRuntime[1]!.activated = true;
    s.dungeonRoomRuntime[1]!.hasLiveEnemy = false; // the capstone itself is clear
    s.enemies.push(buildEnemyActor(s, toFp(10), toFp(10)));
    const host = buildHost({ getPhase: () => 'playing', activeState: () => s });
    const loop = new GameLoop(deps, host);

    loop.update(16);

    // Before the fix, the old `s.wavesExhausted && s.enemies.length === 0` check was
    // permanently false in dungeon mode — this call would have been `false` here too.
    expect(deps.roomBuilder.setPortalOpen).toHaveBeenCalledWith(true);
  });

  // 2026-08-12 follow-up (live bug report: boss loot never had a chance to be picked
  // up, since ExtractionSystem used to auto-resolve EXTRACT the instant the capstone
  // cleared — no portal, no popup, no time to walk over to the drops). The last floor
  // now opens the same portal as every other checkpoint; only the popup's Descend
  // button is hidden (PortalPrompt.test.ts covers that half).
  it('portal ALSO opens on the LAST floor once its capstone is cleared (no more instant auto-resolve)', () => {
    const { deps } = buildDeps();
    const s = dungeonStateWithRooms(2);
    s.dungeonRoomRuntime[1]!.activated = true;
    s.dungeonRoomRuntime[1]!.hasLiveEnemy = false;
    s.floorIndex = TINY_DUNGEON.floorCount - 1; // the final floor
    const host = buildHost({ getPhase: () => 'playing', activeState: () => s });
    const loop = new GameLoop(deps, host);

    loop.update(16);

    expect(deps.roomBuilder.setPortalOpen).toHaveBeenCalledWith(true);
  });

  it('passes isLastFloor=true through to the popup on the LAST floor, so it can hide Descend', () => {
    const { deps } = buildDeps();
    const s = dungeonStateWithRooms(2);
    s.dungeonRoomRuntime[1]!.activated = true;
    s.dungeonRoomRuntime[1]!.hasLiveEnemy = false;
    s.floorIndex = TINY_DUNGEON.floorCount - 1; // the final floor
    const host = buildHost({ getPhase: () => 'playing', activeState: () => s });
    const loop = new GameLoop(deps, host);

    loop.update(16);

    expect(deps.portalPrompt.update).toHaveBeenCalledWith(s, expect.any(Boolean), true);
  });
});
