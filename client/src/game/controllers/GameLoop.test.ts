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
import { createGameEngine, createGameState, buildEnemyActor, makeCommand, quantizeMove, ReplayInputSource, toFp, toReplay, EMBER_DUNGEON, EMBER_ROOMS, type DungeonConfig } from '@dd/engine';
import type { CoopSession } from '../../net/CoopSession';
import type { InputSource, InputState, TouchVisual } from '../../platform/types';
import { CommandBuilder } from './CommandBuilder';
import { AllyController } from './AllyController';
import { GameLoop, type GameLoopDeps, type GameLoopHost } from './GameLoop';
import { MAX_WALL_HEIGHT } from '../scene/wallGeometry';

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
    player: undefined as
      | { curX: number; curY: number; bodySilhouette: { halfW: number; bodyH: number } }
      | undefined,
    enemies: [] as ReadonlyArray<{ curX: number; curY: number; bodySilhouette: { halfW: number; bodyH: number } }>,
    pickups: [] as ReadonlyArray<{ curX: number; curY: number; bodySilhouette: { halfW: number; bodyH: number } }>,
    interpolate: vi.fn(),
    reconcile: vi.fn(),
    positionLocal: vi.fn(),
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
  return {
    setPortalOpen: vi.fn(),
    updateOcclusion: vi.fn(),
    portalPx: null as { x: number; y: number } | null,
  };
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
    replayStopTick: () => null,
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

  it('idle (menu/victory/etc.): keeps fx fading and updates partyScreen, but never polls confirm itself', () => {
    // Confirm is driven entirely by Screens.ts's own CONFIRM/MAIN MENU Button taps now
    // (2026-08-17, see GameLoop's class doc comment) — GameLoop's idle branch has no
    // raw-input confirm path left to test; holding fire here must do nothing.
    const { deps, input, partyScreen } = buildDeps();
    const host = buildHost({ getPhase: () => 'victory' });
    const loop = new GameLoop(deps, host);

    input.state.firing = true;
    loop.update(16);
    loop.update(16);

    expect(partyScreen.update).toHaveBeenCalledWith(16);
    expect(host.confirm).not.toHaveBeenCalled();
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

  // `?replay=` playback (match/replayPlayback.ts). ReplayInputSource is read-only by
  // design — `submit` THROWS — so "the loop must not submit over the recording" is a
  // claim a real source can enforce rather than a spy having to notice.
  // CFG has no waves, and a wave-less run reaches `gameover` on tick 1 (its tick then
  // stops advancing) — useless for asserting WHERE playback stops. This one keeps running.
  const REPLAY_CFG = { ...CFG, waves: [[[520, 400] as const]] };
  const recordedReplay = (ticks: number) =>
    toReplay(
      REPLAY_CFG,
      Array.from({ length: ticks }, (_, i) =>
        makeCommand({ owner: 0, tick: i + 1, ...quantizeMove(1, 0), buttons: 0 }),
      ),
    );

  it('replay playback: drives the engine from the recording without submitting over it', () => {
    const { deps, scene } = buildDeps();
    const engine = createGameEngine(REPLAY_CFG, new ReplayInputSource(recordedReplay(10)));
    const host = buildHost({ getEngine: () => engine, replayStopTick: () => 10 });
    const loop = new GameLoop(deps, host);

    loop.update(SIM_DT_MS_FOR_TESTS);

    expect(engine.state.tick).toBe(1);
    expect(scene.reconcile).toHaveBeenCalledTimes(1);
  });

  it('replay playback: holds the sim at the marked tick while the render loop keeps going', () => {
    const { deps, scene } = buildDeps();
    const engine = createGameEngine(REPLAY_CFG, new ReplayInputSource(recordedReplay(10)));
    const host = buildHost({ getEngine: () => engine, replayStopTick: () => 3 });
    const loop = new GameLoop(deps, host);

    for (let i = 0; i < 10; i++) loop.update(SIM_DT_MS_FOR_TESTS);

    expect(engine.state.tick).toBe(3); // frozen AT the mark, not run to the stream's end
    expect(scene.interpolate).toHaveBeenCalledTimes(10); // still rendering every frame
  });

  it('THE CONTROL: without the replay guard the same setup throws, so the guard is load-bearing', () => {
    const { deps } = buildDeps();
    const engine = createGameEngine(REPLAY_CFG, new ReplayInputSource(recordedReplay(10)));
    // replayStopTick null = a normal run, so the loop submits a live command — which is
    // exactly what a read-only source refuses.
    const host = buildHost({ getEngine: () => engine, replayStopTick: () => null });
    const loop = new GameLoop(deps, host);

    expect(() => loop.update(SIM_DT_MS_FOR_TESTS)).toThrow(/read-only/);
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

describe('GameLoop — the render frame every per-actor clock rides on', () => {
  // The paused and not-yet-online paths above already assert `interpolate(1, 16)`. The RUNNING
  // path — the one a match actually spends its time in — only had `toHaveBeenCalled()`, and a
  // 2026-08-26 battery showed what that costs: `scene.interpolate(alpha, 0)` survived the whole
  // suite. Every clock `ActorFilters` owns rides on that argument (the shield shell's 200ms exit
  // and its shimmer, the hit-flash decay, the death dissolve, the burn heat-haze), so a frozen dt
  // is "no actor ever animates again" with 3000+ tests still green.
  it('hands the scene the real FRAME dt while running, not zero and not the sim step', () => {
    const { deps, scene } = buildDeps();
    const engine = createGameEngine(CFG);
    const host = buildHost({ getEngine: () => engine });
    const loop = new GameLoop(deps, host);

    loop.update(16);

    const calls = (scene.interpolate as ReturnType<typeof vi.fn>).mock.calls as Array<[number, number]>;
    expect(calls.length).toBeGreaterThan(0);
    for (const [, dt] of calls) expect(dt).toBe(16);
  });

  it('passes a LONGER frame straight through, so a hitch advances the clocks by what it cost', () => {
    // The bound that matters for the exit: a 200ms animation stepped by a constant would take a
    // different number of real milliseconds on a stuttering machine than on a smooth one.
    const { deps, scene } = buildDeps();
    const engine = createGameEngine(CFG);
    const loop = new GameLoop(deps, buildHost({ getEngine: () => engine }));

    loop.update(50);

    const calls = (scene.interpolate as ReturnType<typeof vi.fn>).mock.calls as Array<[number, number]>;
    for (const [, dt] of calls) expect(dt).toBe(50);
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

// `cameraFrame` (2026-08-17) — which rect `FxController.updateCamera` is told to FILL.
// A dungeon floor is co-resident, so fitting `worldSize` fitted the WHOLE FLOOR and the
// player saw several rooms at once; the fit target is now the room they're standing in.
// See design/01 "Framing the current room" for the why, and FxController.test.ts for
// what updateCamera then DOES with the rect — this block only covers the lookup.
//
// Every expectation here is the room rect GROWN UPWARD by MAX_WALL_HEIGHT (2026-08-18): the
// room's walls stand instead of lying flat (scene/wallGeometry.ts), so its north wall is
// drawn that far above the rect's own top edge and has to be inside the fitted frame. The
// MAXIMUM tier, not the typical one — a room's perimeter walls are the tall ones, and the
// perimeter is exactly what borders this rect.
describe('GameLoop.updateCamera — the frame rect handed to FxController', () => {
  // The engine converts px -> Fp at construction, so a rect authored in px comes back
  // through fpToPx with the same value; these expectations are in px throughout.
  function stateWithRoomRects(): ReturnType<typeof createGameState> {
    const s = createGameState({ seed: 1, worldW: 2000, worldH: 1000, waves: [], players: [{ start: [100, 100] }] });
    s.dungeonRoomRects.push(
      { id: 'r1', rect: { x: toFp(0), y: toFp(0), w: toFp(15), h: toFp(15) } },
      { id: 'r2', rect: { x: toFp(20), y: toFp(0), w: toFp(10), h: toFp(20) } },
    );
    return s;
  }

  /** The 5th argument of the last updateCamera call — `undefined` if it was never called. */
  function lastFrame(fx: { updateCamera: { mock: { calls: unknown[][] } } }) {
    const calls = fx.updateCamera.mock.calls;
    return calls.length === 0 ? undefined : calls[calls.length - 1]![4];
  }

  it("passes the rect of the room the local player is standing in", () => {
    const { deps, fx } = buildDeps();
    const s = stateWithRoomRects();
    s.players[0]!.roomId = 'r2';
    const loop = new GameLoop(deps, buildHost({ activeState: () => s }));

    loop.update(16);

    // 20/0/10/20 grid units at 32 px per grid.
    expect(lastFrame(fx)).toEqual({ x: 640, y: -MAX_WALL_HEIGHT, w: 320, h: 640 + MAX_WALL_HEIGHT });
  });

  it("follows the LOCAL seat's room in co-op, not whichever player is first", () => {
    const { deps, fx } = buildDeps();
    const s = createGameState({
      seed: 1, worldW: 2000, worldH: 1000, waves: [],
      players: [{ start: [100, 100] }, { start: [900, 100] }],
    });
    s.dungeonRoomRects.push(
      { id: 'r1', rect: { x: toFp(0), y: toFp(0), w: toFp(15), h: toFp(15) } },
      { id: 'r2', rect: { x: toFp(20), y: toFp(0), w: toFp(10), h: toFp(20) } },
    );
    s.players[0]!.roomId = 'r1';
    s.players[1]!.roomId = 'r2';
    const loop = new GameLoop(deps, buildHost({ activeState: () => s, localOwner: 1 }));

    loop.update(16);

    expect(lastFrame(fx)).toEqual({ x: 640, y: -MAX_WALL_HEIGHT, w: 320, h: 640 + MAX_WALL_HEIGHT });
  });

  it('prefers the DUNGEON list when a state carries both — the precedence `roomRectsPx` also uses', () => {
    // Two files pick between the two co-resident room models with the same "dungeon first" rule:
    // `cameraFrame` here, and `scene/groundLayer.ts`'s `roomRectsPx`, which decides which rooms get
    // their own wash/mottle/light pool. `groundLayer.test.ts` pins its copy against a state holding
    // both lists; a 2026-08-27 mutation battery found this copy unread — reversing the ternary
    // passed all 3,310 client tests. If the two ever disagreed, the camera would frame a room out
    // of one model while the floor beneath it was painted from the other.
    //
    // Since 2026-08-27 there is only ONE ternary to reverse: both files call
    // `engine/state/roomModel.ts roomRects`, and a config can no longer carry both models at all
    // (`GameState` throws). This test and `groundLayer.test.ts`'s copy are what prove each call
    // site still READS the shared rule rather than re-inlining its own — they are the reason that
    // refactor was not a leap of faith, since both passed it unchanged.
    //
    // The arena decoy deliberately SHARES the dungeon room's id, because that is the only shape
    // where the wrong list still finds a hit and so fails silently rather than falling back.
    const { deps, fx } = buildDeps();
    const s = stateWithRoomRects();
    s.arenaRoomRects.push({ id: 'r2', rect: { x: toFp(50), y: toFp(50), w: toFp(4), h: toFp(4) } });
    s.players[0]!.roomId = 'r2';
    const loop = new GameLoop(deps, buildHost({ activeState: () => s }));

    loop.update(16);

    // The dungeon r2 (20/0/10/20 grid), not the decoy at 50/50.
    expect(lastFrame(fx)).toEqual({ x: 640, y: -MAX_WALL_HEIGHT, w: 320, h: 640 + MAX_WALL_HEIGHT });
  });

  it('falls back to the arena room list when there are no dungeon rooms (PvP)', () => {
    const { deps, fx } = buildDeps();
    const s = createGameState({ seed: 1, worldW: 2000, worldH: 1000, waves: [], players: [{ start: [100, 100] }] });
    s.arenaRoomRects.push({ id: 'a1', rect: { x: toFp(1), y: toFp(2), w: toFp(8), h: toFp(6) } });
    s.players[0]!.roomId = 'a1';
    const loop = new GameLoop(deps, buildHost({ activeState: () => s }));

    loop.update(16);

    expect(lastFrame(fx)).toEqual({ x: 32, y: 64 - MAX_WALL_HEIGHT, w: 256, h: 192 + MAX_WALL_HEIGHT });
  });

  it('grows the room rect upward by exactly the tallest wall height, and only upward', () => {
    const { deps, fx } = buildDeps();
    const s = stateWithRoomRects();
    s.players[0]!.roomId = 'r1';
    const loop = new GameLoop(deps, buildHost({ activeState: () => s }));

    loop.update(16);

    // r1 is 0/0/15/15 grid = 0/0/480/480 px. x and w are untouched (a standing wall never
    // widens); y moves up by MAX_WALL_HEIGHT and h absorbs exactly that much, so the rect's
    // BOTTOM edge stays put — growing downward instead would push the player off-centre.
    const frame = lastFrame(fx) as { x: number; y: number; w: number; h: number };
    expect(frame.x).toBe(0);
    expect(frame.w).toBe(480);
    expect(frame.y).toBe(-MAX_WALL_HEIGHT);
    expect(frame.y + frame.h).toBe(480);
  });

  it('passes null while the player is in a doorway (roomId cleared) — the camera keeps the whole floor', () => {
    const { deps, fx } = buildDeps();
    const s = stateWithRoomRects();
    s.players[0]!.roomId = undefined; // EnvironmentSystem clears it between rooms
    const loop = new GameLoop(deps, buildHost({ activeState: () => s }));

    loop.update(16);

    expect(lastFrame(fx)).toBeNull();
  });

  it('passes null for a roomId with no rect, rather than throwing (content-bug tolerance)', () => {
    const { deps, fx } = buildDeps();
    const s = stateWithRoomRects();
    s.players[0]!.roomId = 'r_does_not_exist';
    const loop = new GameLoop(deps, buildHost({ activeState: () => s }));

    expect(() => loop.update(16)).not.toThrow();
    expect(lastFrame(fx)).toBeNull();
  });

  it('passes null with no state at all — the camera path must tolerate a run that has not started', () => {
    const { deps, fx } = buildDeps();
    // `playing` with a null state is the one-frame window between beginRun and the
    // engine existing; `menu`/`paused` freeze the last frame and never re-aim the
    // camera at all, so they can't exercise this.
    const loop = new GameLoop(deps, buildHost({ getPhase: () => 'playing', activeState: () => null }));

    expect(() => loop.update(16)).not.toThrow();
    expect(lastFrame(fx)).toBeNull();
  });
});

describe('GameLoop — the occlusion x-ray is driven every render frame', () => {
  // The wiring nothing else can see: `scene/occlusion.ts` and `RoomBuilder` are both covered by
  // their own tests, and both stay green if this call is deleted — only a live look would notice.
  // It rides `updateFx` deliberately, because that wrapper is already called from every render
  // path (playing / paused / menu / offline / online) and already holds the local player.
  const silhouette = { halfW: 12.96, bodyH: 32 };

  it('passes the local player\'s ground point and DRAWN silhouette, with this frame\'s dt', () => {
    const { deps, scene, roomBuilder } = buildDeps();
    scene.player = { curX: 1200, curY: 140.8, bodySilhouette: silhouette };
    const loop = new GameLoop(deps, buildHost({ getPhase: () => 'playing' }));

    loop.update(16);

    expect(roomBuilder.updateOcclusion).toHaveBeenCalledWith(
      [{ x: 1200, y: 140.8, halfW: 12.96, bodyH: 32 }],
      16,
    );
  });

  it('passes an empty list with no local player, so a block cannot freeze mid-x-ray on a menu', () => {
    const { deps, scene, roomBuilder } = buildDeps();
    scene.player = undefined;
    const loop = new GameLoop(deps, buildHost({ getPhase: () => 'victory' }));

    loop.update(16);

    expect(roomBuilder.updateOcclusion).toHaveBeenCalledWith([], 16);
  });

  it('includes every live enemy, so one gets its own x-ray even with no player in the room at all (live report *"如果只有怪物在墙下面的话，就看不到怪物了"*)', () => {
    const { deps, scene, roomBuilder } = buildDeps();
    scene.player = undefined;
    scene.enemies = [{ curX: 40, curY: 60, bodySilhouette: silhouette }];
    const loop = new GameLoop(deps, buildHost({ getPhase: () => 'playing' }));

    loop.update(16);

    expect(roomBuilder.updateOcclusion).toHaveBeenCalledWith(
      [{ x: 40, y: 60, halfW: 12.96, bodyH: 32 }],
      16,
    );
  });

  it('passes both the player and every enemy together', () => {
    const { deps, scene, roomBuilder } = buildDeps();
    scene.player = { curX: 1200, curY: 140.8, bodySilhouette: silhouette };
    scene.enemies = [{ curX: 40, curY: 60, bodySilhouette: silhouette }];
    const loop = new GameLoop(deps, buildHost({ getPhase: () => 'playing' }));

    loop.update(16);

    expect(roomBuilder.updateOcclusion).toHaveBeenCalledWith(
      [
        { x: 40, y: 60, halfW: 12.96, bodyH: 32 },
        { x: 1200, y: 140.8, halfW: 12.96, bodyH: 32 },
      ],
      16,
    );
  });

  it('includes every live pickup even with no player/enemy in the room at all (live report *"被墙挡住的物品，只有角色走到墙下的时候才显示"*) — a drop can\'t walk into the hidden band itself, so it has to be a focus on its own account', () => {
    const { deps, scene, roomBuilder } = buildDeps();
    scene.player = undefined;
    scene.pickups = [{ curX: 25, curY: 50, bodySilhouette: silhouette }];
    const loop = new GameLoop(deps, buildHost({ getPhase: () => 'playing' }));

    loop.update(16);

    expect(roomBuilder.updateOcclusion).toHaveBeenCalledWith(
      [{ x: 25, y: 50, halfW: 12.96, bodyH: 32 }],
      16,
    );
  });

  it('passes the player, every enemy and every pickup together, pickups last', () => {
    const { deps, scene, roomBuilder } = buildDeps();
    scene.player = { curX: 1200, curY: 140.8, bodySilhouette: silhouette };
    scene.enemies = [{ curX: 40, curY: 60, bodySilhouette: silhouette }];
    scene.pickups = [{ curX: 25, curY: 50, bodySilhouette: silhouette }];
    const loop = new GameLoop(deps, buildHost({ getPhase: () => 'playing' }));

    loop.update(16);

    expect(roomBuilder.updateOcclusion).toHaveBeenCalledWith(
      [
        { x: 40, y: 60, halfW: 12.96, bodyH: 32 },
        { x: 1200, y: 140.8, halfW: 12.96, bodyH: 32 },
        { x: 25, y: 50, halfW: 12.96, bodyH: 32 },
      ],
      16,
    );
  });

  it('keeps running while PAUSED — a frozen frame still has to show the character', () => {
    const { deps, scene, roomBuilder } = buildDeps();
    scene.player = { curX: 10, curY: 20, bodySilhouette: silhouette };
    const loop = new GameLoop(deps, buildHost({ getPhase: () => 'paused' }));

    loop.update(16);

    expect(roomBuilder.updateOcclusion).toHaveBeenCalledTimes(1);
  });

  it('runs once per RENDER frame, not once per sim tick', () => {
    // A fade measured in ms has to advance on frames where no sim tick happened at all, or it
    // steps in 33 ms jumps at 60 fps and reads as a stutter rather than a fade.
    const { deps, scene, roomBuilder } = buildDeps();
    const engine = createGameEngine(CFG);
    scene.player = { curX: 0, curY: 0, bodySilhouette: silhouette };
    const loop = new GameLoop(deps, buildHost({ getEngine: () => engine }));

    loop.update(8); // well under one sim tick
    loop.update(8);
    expect(roomBuilder.updateOcclusion).toHaveBeenCalledTimes(2);
  });

  it('reuses its scratch array across frames without leaking a stale focus when the count shrinks then grows back', () => {
    // `GameLoop.occlusionFociScratch` is written into in place and only truncated (never
    // reallocated) each frame — the same shape of optimization as `Scene.seenScratch` — so the
    // failure mode worth pinning down is specifically a shrink-then-regrow: does a frame with
    // fewer foci than the last one actually drop the extra slots (`foci.length = n`), and does a
    // later frame that grows again get FRESH values rather than whatever a dropped slot's
    // reused object last held?
    const { deps, scene, roomBuilder } = buildDeps();
    scene.player = { curX: 1200, curY: 140.8, bodySilhouette: silhouette };
    scene.enemies = [{ curX: 40, curY: 60, bodySilhouette: silhouette }];
    // Phase 'victory' (not 'playing'): three repeated calls just need updateFx wired every
    // frame, not a real sim to step — same reason the "empty list with no local player" test
    // above picks a non-'playing' phase.
    const loop = new GameLoop(deps, buildHost({ getPhase: () => 'victory' }));

    loop.update(16); // 2 foci: one enemy + the player
    expect(roomBuilder.updateOcclusion).toHaveBeenLastCalledWith(
      [
        { x: 40, y: 60, halfW: 12.96, bodyH: 32 },
        { x: 1200, y: 140.8, halfW: 12.96, bodyH: 32 },
      ],
      16,
    );

    scene.player = undefined;
    scene.enemies = [];
    loop.update(16); // shrinks to 0 — must not still report either frame-1 object
    expect(roomBuilder.updateOcclusion).toHaveBeenLastCalledWith([], 16);

    scene.enemies = [{ curX: 5, curY: 6, bodySilhouette: silhouette }];
    loop.update(16); // grows back to 1 — must be this frame's data, not a stale reused slot
    expect(roomBuilder.updateOcclusion).toHaveBeenLastCalledWith(
      [{ x: 5, y: 6, halfW: 12.96, bodyH: 32 }],
      16,
    );
  });
});

// The local player's glow is the one PERSISTENT light in the registry, re-registered at the
// player's current position every render frame rather than tracked as a spawn. Since
// 2026-08-24 that registration is ALL `updateFx` does for lighting — the set is uploaded to
// the one scene-lighting pass by `FxController.updateCamera`, not applied per actor here
// (`Scene.applyLighting` is gone). These pin the half that stayed.
describe('GameLoop — the local player glow (design/01 milestone 2)', () => {
  const silhouette = { halfW: 1, bodyH: 1 };

  it('re-registers the glow at the player position every frame under the same id', () => {
    // One id, every frame, is what makes it a replace-in-place rather than an accumulating
    // leak: `LightRegistry.addPersistent` keys on it. A frame-unique id would put a trail of
    // stale glows along the player's path and quietly exhaust the shader's light slots.
    const { deps, scene, fx } = buildDeps();
    const loop = new GameLoop(deps, buildHost());

    scene.player = { curX: 10, curY: 20, bodySilhouette: silhouette };
    loop.update(16);
    scene.player = { curX: 90, curY: 40, bodySilhouette: silhouette };
    loop.update(16);

    const calls = fx.lights.addPersistent.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls.every((c: unknown[]) => c[0] === 'local')).toBe(true);
    expect(calls[0]![1]).toMatchObject({ x: 10, y: 20 });
    expect(calls[1]![1]).toMatchObject({ x: 90, y: 40 });
  });

  it('drops the glow when there is no player view, rather than leaving it at a stale position', () => {
    const { deps, scene, fx } = buildDeps();
    const loop = new GameLoop(deps, buildHost());

    scene.player = { curX: 10, curY: 20, bodySilhouette: silhouette };
    loop.update(16);
    scene.player = undefined;
    loop.update(16);

    expect(fx.lights.removePersistent).toHaveBeenCalledWith('local');
  });

  it('registers it from every render path, not just `playing`', () => {
    // `updateFx` is the one wrapper every phase goes through (playing / paused / idle /
    // online), which is exactly why the registration lives there and needs no per-path wiring.
    for (const phase of ['playing', 'paused', 'victory'] as const) {
      const { deps, scene, fx } = buildDeps();
      const loop = new GameLoop(deps, buildHost({ getPhase: () => phase }));
      scene.player = { curX: 1, curY: 2, bodySilhouette: silhouette };
      loop.update(16);
      expect(fx.lights.addPersistent).toHaveBeenCalledTimes(1);
    }
  });

  it('gives the glow a real radius and a warm colour — a light with neither would be invisible', () => {
    // The shader drops a light with radius or intensity 0 outright (`LightRegistry.snapshot`),
    // so these are not decoration: a regression to 0 here would silently unlight the player.
    const { deps, scene, fx } = buildDeps();
    const loop = new GameLoop(deps, buildHost());
    scene.player = { curX: 0, curY: 0, bodySilhouette: silhouette };
    loop.update(16);

    const light = fx.lights.addPersistent.mock.calls[0]![1] as { radius: number; intensity: number; color: number };
    expect(light.radius).toBeGreaterThan(0);
    expect(light.intensity).toBeGreaterThan(0);
    expect(light.color).toBeGreaterThan(0);
  });
});
