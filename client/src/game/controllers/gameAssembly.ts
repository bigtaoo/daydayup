// Split out of Game.ts's start(), 2026-09-03 — the ASSEMBLY table: which collaborator gets
// which collaborators, and in what order.
//
// It is a free function for the same reason `gameWiring.ts` is: there is no state, only
// construction. What makes it worth its own file rather than sixty lines in the middle of
// `start()` is that the ORDER here is a real constraint with a real reason behind each step,
// and those reasons were previously spread across five separate comments in a method that also
// did the mounting, the wiring and the boot.
//
// The order, and why:
//
//   1. partyScreen / loginScreen  need `run.matchBaseUrl` AFTER the constructor's `?mm=`
//                                 override, so they cannot be field initializers.
//   2. screenFlow                 needs both of those plus `settingsBtn` (built by buildHud).
//   3. nav                        needs screenFlow. Depends on nothing else built here.
//   4. gameLoop                   needs partyScreen.
//   5. runs                       needs gameLoop AND nav.
//   6. net                        needs nav.
//   7. forgeInput                 needs nothing built here, and is last only for readability.
//
// `nav` reaching `net.connect` is the one backward reference, and it is a thunk on purpose:
// the Matchmaking screen calls it long after both exist. That is the only cycle in the
// object graph, it is deferred rather than structural, and it is named here so the next
// person does not have to rediscover it by reordering two lines and getting `undefined`.
import type { InputSource } from '../../platform/types';
import type { SettingsState } from '../../settings';
import type { GameState } from '@dd/engine';
import { LoginScreen } from '../screens/LoginScreen';
import { PartyScreen } from '../screens/PartyScreen';
import type { Forge } from '../screens/Forge';
import type { MainMenu } from '../screens/MainMenu';
import type { Matchmaking } from '../screens/Matchmaking';
import type { ModeSelect } from '../screens/ModeSelect';
import type { PauseMenu } from '../screens/PauseMenu';
import type { PvpPreview } from '../screens/PvpPreview';
import type { Screens } from '../screens/Screens';
import type { Settings } from '../screens/Settings';
import type { Container } from 'pixi.js';
import type { Button } from '../ui/widgets';
import type { HudView } from '../ui/HudView';
import type { PortalPrompt } from '../ui/PortalPrompt';
import type { FloorCardPrompt } from '../ui/FloorCardPrompt';
import type { TouchControlsView } from '../ui/TouchControlsView';
import type { Backdrop } from '../scene/Backdrop';
import type { Layers } from '../scene/layers';
import type { PickupDebugOverlay } from '../scene/PickupDebugOverlay';
import type { RoomBuilder } from '../scene/RoomBuilder';
import type { Scene } from '../scene/Scene';
import type { FxController } from '../fx/FxController';
import type { MatchRecorder } from '../match/MatchRecorder';
import type { AllyController } from './AllyController';
import type { ArtGate } from './ArtGate';
import type { CommandBuilder } from './CommandBuilder';
import type { EventReactor } from './EventReactor';
import type { ForgeActions } from './ForgeActions';
import type { RunOutcome } from './RunOutcome';
import type { TutorialHintController } from './TutorialHintController';
import { ForgeInput } from './ForgeInput';
import { GameLoop, type GameLoopHost } from './GameLoop';
import { OnlineMatch } from './OnlineMatch';
import { RunLifecycle } from './RunLifecycle';
import { ScreenFlow } from './ScreenFlow';
import { ScreenNav } from './ScreenNav';
import type { RunState } from '../runState';

/** What the assembly needs back from the shell — every one of these is a verb that reaches
 *  across two or more of the built parts, which is why it stays on `Game`. */
export interface GameShellHost extends GameLoopHost {
  settingsState(): SettingsState;
  /** End the run as a defeat with a result screen (`OnlineMatch`'s lost-connection path). */
  endRunAsDefeat(title: string, body: string): void;
}

/** Everything the assembly draws on that already exists by the time it runs. */
export interface AssemblyParts {
  run: RunState;
  layers: Layers;
  scene: Scene;
  fx: FxController;
  backdrop: Backdrop;
  roomBuilder: RoomBuilder;
  recorder: MatchRecorder;
  builder: CommandBuilder;
  ally: AllyController;
  input: InputSource;
  events: EventReactor;
  runOutcome: RunOutcome;
  tutorialHints: TutorialHintController;
  artGate: ArtGate;
  forgeActions: ForgeActions;
  hud: HudView;
  hudView: Container;
  touchControlsView: TouchControlsView;
  portalPrompt: PortalPrompt;
  floorCardPrompt: FloorCardPrompt;
  pickupDebugOverlay: PickupDebugOverlay | null;
  settingsBtn: Button;
  mainMenu: MainMenu;
  modeSelect: ModeSelect;
  pvpPreview: PvpPreview;
  matchmaking: Matchmaking;
  forge: Forge;
  screens: Screens;
  settingsScreen: Settings;
  pauseMenu: PauseMenu;
}

export interface AssembledGame {
  partyScreen: PartyScreen;
  loginScreen: LoginScreen;
  screenFlow: ScreenFlow;
  gameLoop: GameLoop;
  nav: ScreenNav;
  runs: RunLifecycle;
  net: OnlineMatch;
  forgeInput: ForgeInput;
}

/** Build the late-constructed half of the shell, mount the menu layer, and return the parts. */
export function assembleGame(p: AssemblyParts, host: GameShellHost): AssembledGame {
  const partyScreen = new PartyScreen({ matchBaseUrl: p.run.matchBaseUrl });
  const loginScreen = new LoginScreen({ matchBaseUrl: p.run.matchBaseUrl });
  p.layers.menu.mount(
    [p.mainMenu.view, p.modeSelect.view, p.forge.view, p.pvpPreview.view, p.matchmaking.view,
      p.screens.view, p.settingsScreen.view, p.pauseMenu.view,
      partyScreen.view, loginScreen.view],
    [p.settingsBtn.view], // floats OVER a screen — see MenuLayer.mount for why that matters
  );

  const screenFlow = new ScreenFlow({
    mainMenu: p.mainMenu, modeSelect: p.modeSelect, pvpPreview: p.pvpPreview,
    matchmaking: p.matchmaking, partyScreen, loginScreen,
    forge: p.forge, screens: p.screens, settingsScreen: p.settingsScreen,
    pauseMenu: p.pauseMenu, settingsBtn: p.settingsBtn, hudView: p.hudView,
  });

  // Declared before `nav` so the thunk below can close over it — see the header's note on
  // the one deferred back-reference in this graph.
  let net!: OnlineMatch;

  const nav = new ScreenNav({
    run: p.run, layers: p.layers, screenFlow, artGate: p.artGate,
    backdrop: p.backdrop, hud: p.hud, portalPrompt: p.portalPrompt, floorCardPrompt: p.floorCardPrompt,
    mainMenu: p.mainMenu, modeSelect: p.modeSelect, pvpPreview: p.pvpPreview,
    matchmaking: p.matchmaking, partyScreen, loginScreen,
    forge: p.forge, screens: p.screens, settingsScreen: p.settingsScreen,
    pauseMenu: p.pauseMenu,
    screenSize: () => host.screenSize(),
    settings: () => host.settingsState(),
    connect: (signal) => net.connect(signal),
  });

  const gameLoop = new GameLoop({
    scene: p.scene, roomBuilder: p.roomBuilder, fx: p.fx, hud: p.hud,
    touchControlsView: p.touchControlsView, portalPrompt: p.portalPrompt,
    floorCardPrompt: p.floorCardPrompt,
    partyScreen, builder: p.builder, ally: p.ally,
    input: p.input, events: p.events, runOutcome: p.runOutcome,
    tutorialHints: p.tutorialHints, pickupDebugOverlay: p.pickupDebugOverlay,
  }, host);

  const runs = new RunLifecycle({
    run: p.run, layers: p.layers, scene: p.scene, fx: p.fx,
    roomBuilder: p.roomBuilder, gameLoop, screenFlow,
    nav, artGate: p.artGate, recorder: p.recorder,
    tutorialHints: p.tutorialHints, hud: p.hud, hudView: p.hudView,
    forge: p.forge, modeSelect: p.modeSelect, matchmaking: p.matchmaking,
    partyScreen, pauseMenu: p.pauseMenu, screens: p.screens,
    allySkinId: () => host.allySkinId(),
  });

  net = new OnlineMatch({
    run: p.run, nav, hud: p.hud, matchmaking: p.matchmaking,
    endRunAsDefeat: (title, body) => host.endRunAsDefeat(title, body),
  });

  const forgeInput = new ForgeInput({
    run: p.run, layers: p.layers, forge: p.forge, forgeActions: p.forgeActions,
    screenSize: () => host.screenSize(),
    openSettings: () => nav.openSettings(),
    confirm: () => host.confirm(),
  });

  return { partyScreen, loginScreen, screenFlow, gameLoop, nav, runs, net, forgeInput };
}

/** Re-exported so `Game.ts` does not need a second import line for it. */
export type { GameState };
