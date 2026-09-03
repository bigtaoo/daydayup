/**
 * `gameWiring` — the callback table, and the key rule inside it.
 *
 * Two halves, tested differently on purpose.
 *
 * `keydownAction` is a pure function and gets ordinary cases. It carries the rule that pause
 * and F9 are OFFLINE-ONLY, which is the one thing in this file that fails invisibly: a
 * shared online match cannot be frozen from one client without server reconciliation, so an
 * Escape that started working online would desync everyone else in the room while looking,
 * to the player who pressed it, like the pause finally worked.
 *
 * `wireScreens`/`wireHud` are assignment tables, so the useful assertion is COVERAGE of the
 * table rather than the behaviour behind each entry: every callback slot the screens expose
 * must end up pointing at something. A slot left null is a dead button — it does nothing, it
 * logs nothing, and it is only findable by pressing it.
 */
import { describe, expect, it, vi } from 'vitest';
import { defaultMetaState, type MetaStore } from '../../meta';
import { RunState } from '../runState';
import { keydownAction, wireHud, wireScreens, type WiringDeps } from './gameWiring';

const store: MetaStore = { load: () => defaultMetaState(), save: () => {} };

describe('keydownAction', () => {
  it('closes the settings screen on Escape or O, from the settings phase only', () => {
    expect(keydownAction('Escape', 'settings', false)).toBe('closeSettings');
    expect(keydownAction('KeyO', 'settings', false)).toBe('closeSettings');
    // O in the FORGE opens it instead — that is ForgeInput's table, so this one must not
    // claim the key there.
    expect(keydownAction('KeyO', 'forge', false)).toBe('forge');
  });

  it('closes settings even during an online match', () => {
    // Settings is a client-local overlay, unlike pause: it does not stop the sim, so the
    // online guard must not swallow it. The ordering of the two checks is what decides this.
    expect(keydownAction('Escape', 'settings', true)).toBe('closeSettings');
  });

  it('toggles pause with Escape or P, in the right direction for each phase', () => {
    expect(keydownAction('Escape', 'playing', false)).toBe('pause');
    expect(keydownAction('KeyP', 'playing', false)).toBe('pause');
    expect(keydownAction('Escape', 'paused', false)).toBe('resume');
    expect(keydownAction('KeyP', 'paused', false)).toBe('resume');
  });

  it('saves a replay on F9 from any offline phase', () => {
    // Deliberately not phase-guarded: an offline run stays packable after it ends, and the
    // moment worth recording is one nobody planned for.
    for (const phase of ['menu', 'forge', 'playing', 'paused', 'victory', 'defeat']) {
      expect(keydownAction('F9', phase, false), phase).toBe('saveReplay');
    }
  });

  it('makes pause, resume and F9 NO-OPS while online', () => {
    // The rule this file exists to pin. Each returns `forge`, i.e. "not a shell hotkey" —
    // ForgeInput's own phase guard then ignores it too.
    for (const code of ['Escape', 'KeyP', 'F9']) {
      expect(keydownAction(code, 'playing', true), code).toBe('forge');
      expect(keydownAction(code, 'paused', true), code).toBe('forge');
    }
  });

  it('passes every other key through to the forge handler', () => {
    for (const code of ['Digit1', 'KeyC', 'KeyB', 'ArrowUp', 'Enter', 'Space']) {
      expect(keydownAction(code, 'forge', false), code).toBe('forge');
    }
  });

  it('does not pause from a phase that is not a live run', () => {
    for (const phase of ['menu', 'forge', 'victory', 'matchmaking']) {
      expect(keydownAction('Escape', phase, false), phase).toBe('forge');
    }
  });
});

/** A recorder for every callback slot the wiring assigns. */
function screenStub(...slots: string[]) {
  const obj: Record<string, unknown> = { refreshAccountLabel: vi.fn() };
  for (const s of slots) obj[s] = null;
  return obj;
}

function make() {
  const run = new RunState(store);
  const called: string[] = [];
  const track = (name: string) => vi.fn(() => void called.push(name));
  const nav = {
    showMenu: track('nav.showMenu'), showModeSelect: track('nav.showModeSelect'),
    showSquad: track('nav.showSquad'), showAccount: track('nav.showAccount'),
    openSettings: track('nav.openSettings'), showForge: track('nav.showForge'),
    showMatchmaking: track('nav.showMatchmaking'), openSettingsFromPause: track('nav.openSettingsFromPause'),
    resume: track('nav.resume'), pause: track('nav.pause'),
  };
  const runs = {
    beginTutorialRun: track('runs.beginTutorialRun'), finalizeOnlineRun: track('runs.finalizeOnlineRun'),
    quitRun: track('runs.quitRun'), saveReplay: track('runs.saveReplay'),
  };
  const net = {
    beginSoloQueue: vi.fn((pvp: boolean) => void called.push(`net.beginSoloQueue(${pvp})`)),
    beginSquadMatch: track('net.beginSquadMatch'), onCancelled: track('net.onCancelled'),
    syncMetaWithSession: vi.fn(() => Promise.resolve()),
  };
  const forgeInput = {
    cycleCharacter: track('forgeInput.cycleCharacter'), clear: track('forgeInput.clear'),
    craftAt: track('forgeInput.craftAt'), acquireBlueprint: track('forgeInput.acquireBlueprint'),
    onKey: vi.fn(),
  };
  const builder = {
    requestConfirmExtract: track('builder.requestConfirmExtract'),
    requestConfirmDescend: track('builder.requestConfirmDescend'),
    requestPickup: track('builder.requestPickup'),
    suppressFireUntilRelease: track('builder.suppressFireUntilRelease'),
    requestSwap: track('builder.requestSwap'),
  };
  const d: WiringDeps = {
    run,
    nav: nav as never, runs: runs as never, net: net as never, forgeInput: forgeInput as never,
    builder: builder as never,
    input: { onSwitchWeapon: null } as never,
    hud: {
      weaponPickupPrompt: screenStub('onPick', 'onPressStart'),
      onPause: null, onSwapWeapon: null, onSaveReplay: null,
    } as never,
    portalPrompt: screenStub('onExtract', 'onDescend') as never,
    mainMenu: screenStub('onPlay', 'onSquad', 'onAccount', 'onSettings') as never,
    modeSelect: screenStub('onSolo', 'onCoop', 'onPvpSolo', 'onTutorial', 'onBack') as never,
    pvpPreview: screenStub('onQueue', 'onBack') as never,
    matchmaking: screenStub('onConnected', 'onCancelled') as never,
    partyScreen: screenStub('onBack', 'onStartMatch') as never,
    loginScreen: screenStub('onBack', 'onSessionChange') as never,
    forge: screenStub('onBack', 'onCycleCharacter', 'onClear', 'onCraftAt', 'onStart', 'onAcquire') as never,
    screens: screenStub('onConfirm', 'onMenu') as never,
    pauseMenu: screenStub('onResume', 'onSettings', 'onQuit') as never,
    confirm: vi.fn(() => void called.push('confirm')),
    activeSlot: () => 0,
    ...{},
  };
  return { d, run, called, net, nav };
}

describe('wireScreens', () => {
  it('leaves NO callback slot unassigned', () => {
    // The whole point of the table. A slot still null after wiring is a button that does
    // nothing when pressed, with no error anywhere.
    const t = make();
    wireScreens(t.d);
    const screens = ['mainMenu', 'modeSelect', 'pvpPreview', 'matchmaking', 'partyScreen',
      'loginScreen', 'forge', 'screens', 'pauseMenu'] as const;
    for (const name of screens) {
      const obj = t.d[name] as unknown as Record<string, unknown>;
      for (const [slot, value] of Object.entries(obj)) {
        if (slot === 'refreshAccountLabel') continue;
        expect(value, `${name}.${slot} is still unassigned`).toBeTypeOf('function');
      }
    }
  });

  it('routes each button to the verb its label promises', () => {
    const t = make();
    wireScreens(t.d);
    const fire = (screen: keyof WiringDeps, slot: string, ...args: unknown[]): void => {
      (t.d[screen] as unknown as Record<string, (...a: unknown[]) => void>)[slot]!(...args);
    };
    fire('mainMenu', 'onPlay');
    fire('mainMenu', 'onSquad');
    fire('mainMenu', 'onAccount');
    fire('modeSelect', 'onSolo');
    fire('modeSelect', 'onCoop');
    fire('modeSelect', 'onPvpSolo');
    fire('modeSelect', 'onTutorial');
    fire('pvpPreview', 'onQueue');
    fire('partyScreen', 'onStartMatch', 'p1');
    fire('pauseMenu', 'onQuit');
    fire('pauseMenu', 'onResume');
    expect(t.called).toEqual([
      'nav.showModeSelect', 'nav.showSquad', 'nav.showAccount',
      'nav.showForge', 'net.beginSoloQueue(false)', 'net.beginSoloQueue(true)',
      'runs.beginTutorialRun', 'nav.showMatchmaking', 'net.beginSquadMatch',
      'runs.quitRun', 'nav.resume',
    ]);
  });

  it('sends every BACK button to the main menu', () => {
    const t = make();
    wireScreens(t.d);
    for (const screen of ['modeSelect', 'pvpPreview', 'partyScreen', 'loginScreen', 'forge'] as const) {
      t.called.length = 0;
      (t.d[screen] as unknown as Record<string, () => void>).onBack!();
      // pvpPreview's BACK goes one step back, not all the way home — the exception, and the
      // reason this is a per-screen assertion rather than one loop with one expectation.
      expect(t.called, screen).toEqual([screen === 'pvpPreview' ? 'nav.showModeSelect' : 'nav.showMenu']);
    }
  });

  it('refreshes BOTH the account label and the meta store on a session change', () => {
    // Half of it is the visible "Hi, X"; the other half is which MetaStore backs the forge.
    // Dropping the second leaves a freshly logged-in player looking at guest blueprints.
    const t = make();
    wireScreens(t.d);
    (t.d.loginScreen as unknown as { onSessionChange: () => void }).onSessionChange();
    expect((t.d.mainMenu as unknown as { refreshAccountLabel: ReturnType<typeof vi.fn> }).refreshAccountLabel)
      .toHaveBeenCalledTimes(1);
    expect(t.net.syncMetaWithSession).toHaveBeenCalledTimes(1);
  });
});

describe('wireHud', () => {
  it('leaves no HUD or portal slot unassigned', () => {
    const t = make();
    wireHud(t.d);
    const hud = t.d.hud as unknown as Record<string, unknown>;
    for (const slot of ['onPause', 'onSwapWeapon', 'onSaveReplay']) {
      expect(hud[slot], slot).toBeTypeOf('function');
    }
    const prompt = hud.weaponPickupPrompt as Record<string, unknown>;
    expect(prompt.onPick).toBeTypeOf('function');
    expect(prompt.onPressStart).toBeTypeOf('function');
    const portal = t.d.portalPrompt as unknown as Record<string, unknown>;
    expect(portal.onExtract).toBeTypeOf('function');
    expect(portal.onDescend).toBeTypeOf('function');
  });

  it('the HUD pause button obeys the SAME offline+playing guard the key does', () => {
    // Two entry points to one verb; a guard on only one of them is how a touch player ends
    // up able to freeze a shared match that a keyboard player cannot.
    const t = make();
    wireHud(t.d);
    const onPause = (t.d.hud as unknown as { onPause: () => void }).onPause;

    t.run.phase = 'playing';
    t.run.online = true;
    onPause();
    expect(t.called).toEqual([]);

    t.run.online = false;
    t.run.phase = 'menu';
    onPause();
    expect(t.called).toEqual([]);

    t.run.phase = 'playing';
    onPause();
    expect(t.called).toEqual(['nav.pause']);
  });

  it('the swap chip only latches while playing', () => {
    const t = make();
    wireHud(t.d);
    const onSwap = (t.d.hud as unknown as { onSwapWeapon: () => void }).onSwapWeapon;
    t.run.phase = 'forge';
    onSwap();
    expect(t.called).toEqual([]);
    t.run.phase = 'playing';
    onSwap();
    expect(t.called).toEqual(['builder.requestSwap']);
  });

  it('the record button is NOT phase-guarded — a finished run stays packable', () => {
    const t = make();
    wireHud(t.d);
    t.run.phase = 'defeat';
    (t.d.hud as unknown as { onSaveReplay: () => void }).onSaveReplay();
    expect(t.called).toEqual(['runs.saveReplay']);
  });

  it('a weapon-slot button swaps only when it names the OTHER slot', () => {
    // `shouldSwapToSlot` is the bridge from "slot 2" to the engine's toggle. Without it,
    // pressing the button for the weapon already in hand toggles away from it.
    const t = make();
    wireHud(t.d);
    const onSwitch = (t.d.input as unknown as { onSwitchWeapon: (s: number) => void }).onSwitchWeapon;
    t.run.phase = 'playing';
    // The control names a ONE-based slot; `activeSlot()` here is the zero-based 0, i.e. the
    // player is already holding what button 1 names.
    onSwitch(1);
    expect(t.called).toEqual([]);
    onSwitch(2);
    expect(t.called).toEqual(['builder.requestSwap']);
  });

  it('...and not at all outside a run', () => {
    const t = make();
    wireHud(t.d);
    const onSwitch = (t.d.input as unknown as { onSwitchWeapon: (s: number) => void }).onSwitchWeapon;
    t.run.phase = 'forge';
    onSwitch(2);
    expect(t.called).toEqual([]);
  });
});
