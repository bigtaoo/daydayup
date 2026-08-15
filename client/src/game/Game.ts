import { Application, Container } from 'pixi.js';
import {
  createGameEngine,
  SKIN_DEFS,
  type GameEngine,
  type GameState,
} from '@dd/engine';
import { CoopSession } from '../net/CoopSession';
import { connectOnlineSession } from './match/onlineConnect';
import { buildDungeonRunConfig, buildArenaDemoConfig } from './match/offlineConfig';
import { buildTutorialConfig } from './match/tutorialConfig';
import {
  defaultMetaState, bankMaterials, clearLoadout, selectCharacter,
  unlockBlueprint, createAccountSyncMetaStore, pullAccountMeta, type MetaState, type MetaStore,
} from '../meta';
import { getSession } from '../net/session';
import {
  defaultSettingsState, createWebSettingsStore, effectiveVolume,
  type SettingsState, type SettingsStore,
} from '../settings';
import { t, setLocale } from '../i18n';
import { THEME } from './theme';
import { Layers } from './scene/layers';
import { Scene } from './scene/Scene';
import { Screens } from './screens/Screens';
import { Forge } from './screens/Forge';
import { MainMenu } from './screens/MainMenu';
import { ModeSelect } from './screens/ModeSelect';
import { PvpPreview } from './screens/PvpPreview';
import { Matchmaking, type MatchmakingSignal } from './screens/Matchmaking';
import { PartyScreen } from './screens/PartyScreen';
import { LoginScreen } from './screens/LoginScreen';
import { Settings } from './screens/Settings';
import { PauseMenu } from './screens/PauseMenu';
import { Button } from './ui/widgets';
import { FxController } from './fx/FxController';
import { HudView } from './ui/HudView';
import { TouchControlsView } from './ui/TouchControlsView';
import { CommandBuilder } from './controllers/CommandBuilder';
import { AllyController } from './controllers/AllyController';
import { EventReactor } from './controllers/EventReactor';
import { TutorialHintController } from './controllers/TutorialHintController';
import { RoomBuilder } from './scene/RoomBuilder';
import { Backdrop } from './scene/Backdrop';
import { PortalPrompt } from './ui/PortalPrompt';
import { RunOutcome } from './controllers/RunOutcome';
import { ForgeActions } from './controllers/ForgeActions';
import { ScreenFlow } from './controllers/ScreenFlow';
import { GameLoop } from './controllers/GameLoop';
import { parseGameQueryParams } from './match/gameQueryParams';
import { computeScreenSize } from './viewport';
import type { Phase } from './phase';
import type { AudioBus, InputCanvas, InputSource } from '../platform/types';

// The demo runs the Ember biome as a seeded dungeon (design/05/09, ROADMAP 1.3): each
// floor is traversed room by room. The engine owns the geometry now — the render layer
// reads state.walls / state.obstacles / worldW/H per room and rebuilds on the
// `room_enter` event (RoomBuilder.build), so there are no fixed WORLD dimensions, wave
// list, or pillar layout here any more (offlineConfig.ts's own PLACEHOLDER_WORLD is
// ignored in dungeon/arena mode — each room/arena resizes the world as it loads).

const SEED_BASE = 0xda1d; // per-run seed = base + run index (deterministic, no Date)

// Render-side run phases (design/10). The engine only knows idle/playing/gameover;
// the main menu (the boot front door), the forge/loadout outpost (the between-run hub,
// design/14), and the result screens live here in the shell, along with score (derived
// from events). 'paused' is the in-run pause menu (design/10's own open question,
// resolved) — 'settings' also serves as the pause menu's settings sub-screen (Game
// tracks which phase to return to via settingsReturnPhase). 'squad' is the PvP
// pre-formed-party lobby (design/05/15's squad follow-up) — the first runtime (not
// boot-flag) entry point into PvP. Declared in phase.ts — shared vocabulary between
// Game and the screen layer, unit-testable without standing up a Pixi Application.

export class Game {
  private app: Application;
  private layers = new Layers();
  private input: InputSource;
  private audio: AudioBus;

  private scene = new Scene(this.layers);
  private engine: GameEngine | null = null;
  private builder: CommandBuilder;

  // In-match HUD (design/10 widget kit, extracted into HudView 2026-07-28): composed
  // bars/text/toast instead of one debug Text blob. `hudView` is the visibility root
  // every phase transition toggles; `hud` owns the actual widgets (see HudView.ts).
  private hudView = new Container();
  private readonly hud = new HudView();
  // On-screen sticks/buttons for touch play (design/10 open question) — pure
  // presentation over TouchControls' own hit-test geometry, mounted in `hudView` so it
  // shares the exact same phase-driven visibility as the rest of the in-run HUD.
  private readonly touchControlsView = new TouchControlsView();
  private settingsBtn!: Button;

  private screens = new Screens();
  private forge = new Forge();
  private mainMenu = new MainMenu();
  // ModeSelect (design/10 screen-flow gap): PLAY's new destination — solo PvE / co-op /
  // PvP solo queue / tutorial, previously only reachable as boot-time URL flags.
  private modeSelect = new ModeSelect();
  // PvP match preview (design/10 open question "PvP preset-pick has no UI yet") —
  // ModeSelect's PVP SOLO QUEUE routes here before Matchmaking, so a player sees their
  // character/map/PvP-scaled stats instead of jumping straight into "Finding a match…".
  // Solo-queue path only — see phase.ts's doc comment for why squad doesn't route here.
  private pvpPreview = new PvpPreview();
  // Matchmaking (design/10 screen-flow gap): wraps connectOnlineSession with real
  // connecting/error feedback — previously the game sat in a blank `playing` phase with
  // no UI while matchmaking ran, and a post-ticket failure hung forever with no error.
  private matchmaking = new Matchmaking();
  // Where Cancel/Back on the Matchmaking screen returns to — modeSelect for a solo
  // co-op/PvP queue (beginSoloQueue), squad for a pre-formed party (beginSquadMatch).
  // Same "remember the caller" convention as settingsReturnPhase.
  private matchmakingReturnPhase: 'modeSelect' | 'squad' = 'modeSelect';
  // Constructed in start(), not as a field initializer — it needs `this.matchBaseUrl`
  // AFTER the constructor's `?matchBaseUrl=` query-param override has applied, which a
  // field initializer would run before (design/05/15's PvP squad follow-up).
  private partyScreen!: PartyScreen;
  // Same constructed-in-start() reason as partyScreen — needs the post-override
  // `this.matchBaseUrl` (design/16-accounts.md).
  private loginScreen!: LoginScreen;
  private settingsScreen = new Settings();
  private pauseMenu = new PauseMenu();
  // Screen-transition widget orchestration (extracted 2026-08-12, see that file's doc
  // comment) — constructed in start(), same reason as partyScreen/loginScreen above:
  // it references settingsBtn (built in buildHud(), called from start()) and both of
  // those late-constructed screens.
  private screenFlow!: ScreenFlow;
  private readonly portalPrompt = new PortalPrompt();
  // Settings can be opened from the main menu, the forge, OR the in-run pause menu
  // (design/10); this is which phase the settings screen's BACK button returns to. Set
  // right before each openSettings()/openSettingsFromPause() call, never read otherwise.
  private settingsReturnPhase: 'menu' | 'forge' | 'paused' = 'menu';
  private readonly backdrop = new Backdrop(this.layers);
  private readonly roomBuilder = new RoomBuilder(this.layers, this.backdrop);
  // Win/lose/placement screens (design/15), extracted into RunOutcome 2026-07-28 — `this`
  // is its host for the score/meta/phase/screen reactions (see that file's doc comment).
  private readonly runOutcome = new RunOutcome(this);

  // Persistent between-run meta (design/14): loaded at boot, saved on every change. The
  // forge outpost mutates it (craft / character / acquire); a run reads only its
  // (skinId, loadout) at start and banks materials back into it on a successful extract.
  // Account-sync-aware (design/16-accounts.md): every save best-effort mirrors to
  // `/account/meta` once logged in; a guest's behavior is unchanged. The `() =>
  // this.matchBaseUrl` thunk is why this can stay a field initializer despite needing
  // the post-query-param-override URL — see accountSync.ts's own comment.
  private store: MetaStore = createAccountSyncMetaStore(() => this.matchBaseUrl);
  private meta: MetaState = defaultMetaState();
  // Craft/cycle-character/acquire/clear/browse actions (extracted 2026-08-12, see that
  // file's doc comment) — a field initializer is fine here (unlike screenFlow below):
  // both `forge` and `store` above are already-declared field initializers themselves,
  // no query-param-override timing dependency.
  private readonly forgeActions = new ForgeActions(this.forge, this.store);

  // Persistent client-side settings (design/10/11: master/SFX/music volume + mute).
  // Reached from the forge outpost only — see openSettings/closeSettings.
  private settingsStore: SettingsStore = createWebSettingsStore();
  private settings: SettingsState = defaultSettingsState();

  private phase: Phase = 'menu';
  private runCount = 0;
  private score = 0;
  // Chosen character (design/14) now lives in `this.meta.selectedSkin` — picked at the
  // forge outpost and carried into a run via EngineConfig.skinId (see beginRun).

  // Local co-op (ROADMAP 3.1): the seat THIS client drives, and an optional second seat
  // driven locally by a bot ally so the SECOND player is live + visible (the engine now
  // builds N seats via EngineConfig.players). `?coop=1` opts a run in (a dev toggle, like
  // `?skin=`); default single-player builds one seat and is byte-identical.
  // Online co-op (ROADMAP 3.3): `?online=1` runs the run off a REAL matchmade socket
  // instead — matchmaking → signed ticket → CoopSession drives the engine off the
  // server's confirmed frame stream. `localOwner` is then the ticket-assigned seat (set
  // from match_start), not a fixed 0, so each client's camera follows its own player.
  // Not `private` — read by EventReactor through the EventReactorHost interface.
  localOwner = 0;
  private coop = false;
  private online = false;
  // `?arenaDemo=1` — a DEV-ONLY harness, kept even after `?pvp=1` (below) became a
  // real matchmade entry point: it boots a tiny local synthetic 3-room ArenaMap with
  // zero network/matchmaking round-trip, so the PvP zone HUD row + Minimap (design/10)
  // have real `state.zoneEnabled`/`arenaMap`/`zone` data to iterate against without a
  // second tab or a running matchsvc. Not a substitute for `?pvp=1` — no real map, no
  // matchmaking, no HP/weapon scaling. Reuses the coop bot-ally submit path to drive
  // the second seat locally (see stepSim).
  private arenaDemo = false;
  // `?pvp=1` (design/15, ROADMAP Phase 4 closeout) — a REAL matchmade PvP arena run:
  // requests an 8-seat (default; `?seats=` overrides for local two-tab testing) 'pvp'-
  // mode match instead of 2-seat 'coop', builds an arena EngineConfig (ARENA_CATALOG +
  // squad-chunked teamIds, design/05/15) from `match_start`, and reports win/lose by
  // placement instead of the PvE extract/wipe outcome. Reuses the entire online/
  // CoopSession path `?online=1` already proved out — only `mode` and the config it
  // builds differ.
  private pvp = false;
  private pvpSeats = 2;
  // A pre-formed party's id (design/05/15's squad follow-up, SQUAD screen) — set by
  // beginSquadMatch, threaded into connectOnlineSession so every member's `POST /find`
  // groups into one squad chunk. Undefined for a plain `?pvp=1` boot-flag solo queue.
  private partyId?: string;
  private matchBaseUrl = 'http://localhost:8788';
  private session: CoopSession | null = null;
  private readonly ally = new AllyController();
  // `?lag=` DEV harness (LaggyTransport, CoopSession construction in connectForMatchmaking)
  // to feel/tune the online predictor's smoothing without real devices — the predictor
  // itself now lives in GameLoop (extracted 2026-08-12, see that file's doc comment).
  private lagMs = 0;
  // Fixed-step sim + interpolated render main loop (extracted 2026-08-12, see that
  // file's doc comment) — constructed in start(), same late-construction reason as
  // screenFlow (needs partyScreen, built there too).
  private gameLoop!: GameLoop;

  // Post-processing / game-feel (design/01 fidelity roadmap milestone 3), extracted
  // into FxController 2026-07-28. Offline-only (never touches advanceOnline — see
  // FxController.addHitStop's doc): a strong hit-stop pause would have to be
  // reconciled against the server's confirmed frame stream online, which isn't worth
  // the complexity for a pure juice effect.
  private readonly fx = new FxController(this.layers);

  // Event→feedback reactions (fx/audio/score/hud), extracted into EventReactor
  // 2026-07-28 — see that file's doc comment. `this` is its host for the handful of
  // reactions that reach back into Game-owned state (score/meta/room rebuild).
  private readonly events: EventReactor;
  // The tutorial level's teaching-beat toasts (design/10 screen-flow gap) — same
  // render-only, state+events-only shape as EventReactor, only ever consumed while
  // `tutorialActive` (see stepSim). `this` satisfies its tiny Host (`localOwner`).
  private readonly tutorialHints: TutorialHintController;
  // True only for the standalone tutorial level (beginTutorialRun) — always offline,
  // never `this.online`. Gates the tutorial hint reactions and where Pause/result-screen
  // confirm/quit actually return to (ModeSelect instead of Forge).
  private tutorialActive = false;

  constructor(app: Application, input: InputSource, audio: AudioBus) {
    this.app = app;
    this.input = input;
    this.audio = audio;
    // Built here (not as a field initializer) — it needs `this.audio`, which isn't
    // assigned yet when field initializers run.
    this.events = new EventReactor(this.fx, this.hud, this.audio, this);
    this.tutorialHints = new TutorialHintController(this.hud, this);
    this.builder = new CommandBuilder(input);
    // Load persistent meta (bank / unlocks / loadout / chosen character, design/14).
    this.meta = this.store.load();
    // Dev/demo `?query=` overrides (parseGameQueryParams — see that file's doc comment
    // for what each means). `?skin=` still only overrides to a character the account
    // owns (selectCharacter itself guards that) — otherwise the saved choice stands.
    if (typeof location !== 'undefined') {
      const q = parseGameQueryParams(location.search);
      if (q.skinOverride) this.meta = selectCharacter(this.meta, q.skinOverride);
      this.coop = q.coop;
      this.online = q.online;
      this.arenaDemo = q.arenaDemo;
      this.pvp = q.pvp;
      if (q.pvpSeats !== null) this.pvpSeats = q.pvpSeats;
      if (q.matchBaseUrl !== null) this.matchBaseUrl = q.matchBaseUrl;
      if (q.lagMs !== null) this.lagMs = q.lagMs;
      if (q.loadoutOverride) this.meta = { ...this.meta, loadout: q.loadoutOverride };
    }
    app.stage.eventMode = 'static'; // let the overlay receive pointer taps (web)
    app.stage.addChild(this.layers.root);

    // Persisted volume + language take effect immediately, not just after the first
    // settings edit (design/17-i18n.md: `setLocale` is the live mirror every `t()` call
    // reads, `this.settings.locale` is only the persisted copy).
    this.settings = this.settingsStore.load();
    this.applyAudioSettings();
    this.applyControlLayout();
    setLocale(this.settings.locale);
    this.settingsScreen.onChange = (s) => {
      this.settings = s;
      this.settingsStore.save(s);
      this.applyAudioSettings();
      this.applyControlLayout();
    };
    this.settingsScreen.onBack = () =>
      this.settingsReturnPhase === 'paused' ? this.openPauseFromSettings() : this.closeSettings();
  }

  private applyAudioSettings() {
    this.audio.setSfxVolume(effectiveVolume(this.settings, 'sfx'));
    this.audio.setMusicVolume(effectiveVolume(this.settings, 'music'));
  }

  // Left-handed control-layout option (design/10 open question, `Settings.ts`) — a
  // no-op for any InputSource that doesn't implement setControlMirror (a test fake
  // with no touch controls at all has nothing to mirror).
  private applyControlLayout() {
    this.input.setControlMirror?.(this.settings.controlLayout === 'mirrored');
  }

  start() {
    // Ground / walls / pillars are per-room now (buildRoom, driven by the `room_enter`
    // event), so nothing static is built here — only the fixed HUD overlay.
    this.buildHud();

    // Post-processing (design/01 milestone 3): vignette + chromatic-aberration live on
    // `world` only — the `ui` layer (HUD/menus) must stay crisp and undistorted.
    this.fx.attach(this.app.renderer);

    // Constructed here, not as a field initializer — see the field's own doc comment
    // (needs `this.matchBaseUrl` after the constructor's query-param override).
    this.partyScreen = new PartyScreen({ matchBaseUrl: this.matchBaseUrl });
    this.loginScreen = new LoginScreen({ matchBaseUrl: this.matchBaseUrl });
    this.layers.ui.addChild(
      this.mainMenu.view, this.modeSelect.view, this.forge.view, this.pvpPreview.view, this.matchmaking.view,
      this.screens.view, this.settingsScreen.view, this.pauseMenu.view,
      this.partyScreen.view, this.loginScreen.view,
    );
    // Same late-construction reason as partyScreen/loginScreen above — needs
    // settingsBtn (built by buildHud() just above) and both of those.
    this.screenFlow = new ScreenFlow({
      mainMenu: this.mainMenu, modeSelect: this.modeSelect, pvpPreview: this.pvpPreview,
      matchmaking: this.matchmaking, partyScreen: this.partyScreen, loginScreen: this.loginScreen,
      forge: this.forge, screens: this.screens, settingsScreen: this.settingsScreen,
      pauseMenu: this.pauseMenu, settingsBtn: this.settingsBtn, hudView: this.hudView,
    });
    // Same late-construction reason as screenFlow above — needs partyScreen.
    this.gameLoop = new GameLoop({
      scene: this.scene, roomBuilder: this.roomBuilder, fx: this.fx, hud: this.hud,
      touchControlsView: this.touchControlsView, portalPrompt: this.portalPrompt,
      partyScreen: this.partyScreen, builder: this.builder, ally: this.ally,
      input: this.input, events: this.events, runOutcome: this.runOutcome,
      tutorialHints: this.tutorialHints,
    }, this);
    this.mainMenu.onPlay = () => this.showModeSelect();
    this.mainMenu.onSquad = () => this.showSquad();
    this.mainMenu.onAccount = () => this.showAccount();
    this.mainMenu.onSettings = () => this.openSettings();
    this.modeSelect.onSolo = () => this.showForge();
    this.modeSelect.onCoop = () => this.beginSoloQueue(false);
    this.modeSelect.onPvpSolo = () => this.beginSoloQueue(true);
    this.modeSelect.onTutorial = () => this.beginTutorialRun();
    this.modeSelect.onBack = () => this.showMenu();
    this.pvpPreview.onQueue = () => this.showMatchmaking();
    this.pvpPreview.onBack = () => this.showModeSelect();
    this.matchmaking.onConnected = (session) => this.finalizeOnlineRun(session);
    this.matchmaking.onCancelled = () => this.onMatchmakingCancelled();
    this.partyScreen.onBack = () => this.showMenu();
    this.partyScreen.onStartMatch = (partyId) => this.beginSquadMatch(partyId);
    this.loginScreen.onBack = () => this.showMenu();
    // A login/register/logout can change which MetaStore backs the forge (design/16
    // -accounts.md's account-bound blueprints) and the main menu's own "Hi, X" label.
    this.loginScreen.onSessionChange = () => {
      this.mainMenu.refreshAccountLabel();
      void this.syncMetaStoreWithSession();
    };
    this.forge.onBack = () => this.showMenu();
    this.forge.onCycleCharacter = () => this.forgeCycleCharacter();
    this.forge.onClear = () => this.forgeClear();
    this.forge.onCraftAt = (i) => this.forgeCraftAt(i);
    this.forge.onStart = () => this.confirm();
    this.forge.onAcquire = () => this.forgeAcquireBlueprint();
    this.screens.onConfirm = () => this.confirm();
    this.screens.onMenu = () => this.showMenu();
    this.pauseMenu.onResume = () => this.resume();
    this.pauseMenu.onSettings = () => this.openSettingsFromPause();
    this.pauseMenu.onQuit = () => this.quitRun();
    // Portal popup (design/10 legibility fix, 2026-08-02): a button click is the
    // player's explicit checkpoint choice — routes to CommandBuilder's one-shot
    // latches, same shape as onSwitchWeapon → builder.requestSwap() below.
    this.portalPrompt.onExtract = () => this.builder.requestConfirmExtract();
    this.portalPrompt.onDescend = () => this.builder.requestConfirmDescend();
    // Ground-weapon click-to-collect (design/03, ENGINE_VERSION 32) — same shape as
    // the portal popup above: a row click latches the target id onto the builder.
    this.hud.weaponPickupPrompt.onPick = (id) => this.builder.requestPickup(id);
    // In-run pause button (a real gap this pass closed — see HudView.pauseBtn's own
    // doc comment): the same pause() the Escape/P keyboard handler below already calls,
    // guarded by the same `!this.online` check (pause() freezes the local sim loop
    // unconditionally — see its own doc comment on why that's unsafe for a shared match).
    this.hud.onPause = () => {
      if (!this.online && this.phase === 'playing') this.pause();
    };
    // Tapping the idle-slot chip (HudView, design/10 HUD follow-up) swaps the active
    // weapon — same latch as the keyboard/touch swap controls just below.
    this.hud.onSwapWeapon = () => {
      if (this.phase === 'playing') this.builder.requestSwap();
    };

    this.input.attach(this.app.canvas as unknown as InputCanvas);
    // Discrete actions route through the shell: during a run they latch a one-tick
    // button pulse on the command builder; on menus/results a press confirms.
    this.input.onSwitchWeapon = () => {
      if (this.phase === 'playing') this.builder.requestSwap();
    };
    // Forge outpost controls (web keyboard, design/14). A touch forge is a follow-up —
    // like the touch INTERACT control — so this is guarded to the DOM and only acts in
    // the forge phase. Digits craft, C cycles character, X clears, B acquires, Enter descends,
    // O opens settings. Escape/O closes settings again (a touch settings entry is the
    // SETTINGS button built in buildHud, reachable on WeChat too).
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', (e) => {
        this.onForgeKey(e.code);
        if (this.phase === 'settings' && (e.code === 'Escape' || e.code === 'KeyO')) this.closeSettings();
        // In-run pause (design/10, now resolved) — Escape/P toggles. Offline/local play
        // ONLY (see pause()'s doc comment): a shared online match can't be frozen from
        // one client, so the hotkey is a deliberate no-op there for now.
        if (!this.online) {
          if (this.phase === 'playing' && (e.code === 'Escape' || e.code === 'KeyP')) this.pause();
          else if (this.phase === 'paused' && (e.code === 'Escape' || e.code === 'KeyP')) this.resume();
        }
      });
    }

    // Registered after WebPlatform's own `resizeTo: window` listener (added during
    // `app.init()`, well before this `start()` runs), so the browser's guaranteed
    // same-event listener ordering means Pixi's renderer.resize() has already run by
    // the time our own 'resize' fires — screenSize() below reads the already-updated
    // renderer dimensions, not last frame's.
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', () => requestAnimationFrame(() => this.relayoutViewport()));
    }

    this.showMenu();
    this.app.ticker.add((t) => this.update(t.deltaMS));
  }

  // ---- Scene construction (static) ----
  //
  // Room/pillar geometry construction now lives in RoomBuilder (extracted 2026-07-28)
  // — see roomBuilder.build() calls in beginArenaDemoRun / EventReactorHost.onRoomEnter.

  private buildHud() {
    this.backdrop.resize(this.screenSize().w, this.screenSize().h);
    this.hud.build(this.layers, this.screenSize());
    this.portalPrompt.reposition(this.screenSize());
    this.hudView.addChild(this.hud.view, this.touchControlsView.view, this.portalPrompt.view);
    this.layers.ui.addChild(this.hudView);

    // Settings entry (design/10) — only shown in the forge phase (showForge/beginRun).
    this.settingsBtn = new Button(t('settings.title'), { w: 110, h: 30, fontSize: 12 });
    this.settingsBtn.onTap = () => this.openSettings();
    this.settingsBtn.view.visible = false;
    this.layers.ui.addChild(this.settingsBtn.view);
    this.settingsBtn.view.position.set(this.screenSize().w - 130, this.screenSize().h - 50);
  }

  private openSettings() {
    if (this.phase !== 'forge' && this.phase !== 'menu') return;
    this.settingsReturnPhase = this.phase;
    this.phase = 'settings';
    const { w, h } = this.screenSize();
    this.screenFlow.openSettings(w, h, this.settings);
  }

  private closeSettings() {
    if (this.settingsReturnPhase === 'menu') this.showMenu();
    else this.showForge();
  }

  // ---- In-run pause menu (design/10, now resolved) ----
  //
  // Offline/local play ONLY (single-player + local `?coop=1` bot ally): the sim
  // genuinely freezes (update() skips advanceSim while phase is 'paused', mirroring
  // hitStopMs's own "acc doesn't accumulate while frozen" trick — no catch-up burst on
  // resume). A shared online/PvP match can't be frozen from one client without server
  // reconciliation (the same reasoning `hitStopMs` itself is offline-only for), so the
  // pause hotkey is a deliberate no-op there (see the keydown handler in start()) —
  // a documented scope decision, not an oversight.

  private pause() {
    this.phase = 'paused';
    const { w, h } = this.screenSize();
    this.screenFlow.pause(w, h, this.tutorialActive ? t('tutorial.skip') : undefined);
  }

  private resume() {
    this.screenFlow.resume();
    this.phase = 'playing';
  }

  private openSettingsFromPause() {
    this.settingsReturnPhase = 'paused';
    this.phase = 'settings';
    const { w, h } = this.screenSize();
    this.screenFlow.openSettingsFromPause(w, h, this.settings);
  }

  private openPauseFromSettings() {
    this.phase = 'paused';
    const { w, h } = this.screenSize();
    this.screenFlow.openPauseFromSettings(w, h, this.tutorialActive ? t('tutorial.skip') : undefined);
  }

  // Voluntary quit (design/10) — behaves like a death for the run's own bookkeeping:
  // the floor's un-banked materials are simply forfeited, same as `lose()` never
  // calling bankMaterials (design/05 "death forfeits the floor buffer for free"). No
  // defeat screen/score penalty though — this was a choice, not a loss. Doubles as the
  // tutorial's Skip (design/10 screen-flow gap): a skip counts the same as a completion
  // for `hasSeenTutorial` (never forced, same ethos as LoginScreen's guest path), and
  // returns to ModeSelect instead of Forge (a tutorial run never touched the loadout).
  private quitRun() {
    this.pauseMenu.hide();
    if (this.online) {
      this.session?.close();
      this.session = null;
    } else {
      this.engine = null;
    }
    // Reset so a later offline run never inherits a stale online flag — a pre-existing
    // gap (quitRun never reset this before) that ModeSelect's new solo-queue entry
    // points make more reachable (activeState()/stepSim-vs-advanceOnline both key off
    // `this.online`, previously only set by the `?online=1`/`?pvp=1` URL flags).
    this.online = false;
    const wasTutorial = this.tutorialActive;
    this.tutorialActive = false;
    if (wasTutorial) {
      this.markTutorialSeen();
      this.showModeSelect();
    } else {
      this.showForge();
    }
  }

  /** Guest-local, account-independent (design/10) — set once, on tutorial completion OR
   * skip alike. Idempotent: a no-op (no extra save) once already true. */
  markTutorialSeen() {
    if (this.meta.hasSeenTutorial) return;
    this.meta = { ...this.meta, hasSeenTutorial: true };
    this.store.save(this.meta);
  }

  // Re-run whichever screen's own layout math is currently on-screen against a fresh
  // screenSize() (window resize / orientation change / F11 fullscreen toggle). The
  // canvas itself already tracks the viewport (WebPlatform's `resizeTo: window`) —
  // this is the missing half: each screen's Panel/button positions were only ever
  // computed once, at the moment it was shown, so without this they stayed pinned to
  // whatever size was current back then (funny reference: relayout on resize, not just
  // on first show). HudView.reposition already existed for exactly this but was never
  // wired to anything.
  private relayoutViewport() {
    const { w, h } = this.screenSize();
    this.backdrop.resize(w, h);
    this.hud.reposition({ w, h });
    this.portalPrompt.reposition({ w, h });
    this.screenFlow.repositionSettingsButtonIfForge(this.phase === 'forge', w, h);
    switch (this.phase) {
      case 'menu': this.mainMenu.show(w, h); break;
      case 'modeSelect': this.modeSelect.show(w, h); break;
      case 'pvpPreview': this.pvpPreview.show(w, h, this.meta.selectedSkin); break;
      case 'forge': this.forge.render(this.meta, w, h); break;
      case 'matchmaking': this.matchmaking.resize(w, h); break; // NOT show() — must not restart connect()
      case 'squad': this.partyScreen.show(w, h); break;
      case 'account': this.loginScreen.show(w, h); break;
      case 'paused': this.pauseMenu.show(w, h, this.tutorialActive ? t('tutorial.skip') : undefined); break;
      case 'settings': this.settingsScreen.show(w, h, this.settings); break;
      case 'victory':
      case 'defeat':
        this.screens.resize(w, h);
        break;
      case 'playing':
        break; // in-run HUD only needs the reposition() above — no static panel layout
    }
  }

  // ---- Run lifecycle ----

  // The main menu — the boot front door (design/10 screen flow). PLAY drops into the
  // forge/loadout screen below; SQUAD opens the PvP party lobby (design/05/15);
  // SETTINGS reuses the same settings overlay the forge uses.
  private showMenu() {
    this.phase = 'menu';
    const { w, h } = this.screenSize();
    this.screenFlow.showMenu(w, h);
  }

  // The mode-select branch point (design/10 screen-flow gap) — PLAY's new destination.
  // BACK returns to the main menu; SOLO routes to the unchanged Forge/offline path,
  // CO-OP/PVP SOLO QUEUE open the matchmaking screen (beginSoloQueue), TUTORIAL starts
  // the standalone level (beginTutorialRun).
  private showModeSelect() {
    this.phase = 'modeSelect';
    const { w, h } = this.screenSize();
    this.screenFlow.showModeSelect(w, h, !this.meta.hasSeenTutorial);
  }

  /**
   * PvP match preview (design/10 open question "PvP preset-pick has no UI yet", 15) —
   * shown for the solo PVP-SOLO-QUEUE path only (`beginSoloQueue(true)`), between
   * ModeSelect and Matchmaking, so a player sees their character/the real map/PvP-
   * scaled stats before committing to queue. Does NOT run for the squad path — see
   * phase.ts's doc comment on 'pvpPreview' for why.
   */
  private showPvpPreview() {
    this.phase = 'pvpPreview';
    const { w, h } = this.screenSize();
    this.screenFlow.showPvpPreview(w, h, this.meta.selectedSkin);
  }

  // The PvP pre-formed-party lobby (design/05/15's squad follow-up). BACK returns to
  // the main menu; a successful `onStartMatch` hands off to beginSquadMatch below.
  private showSquad() {
    this.phase = 'squad';
    const { w, h } = this.screenSize();
    this.screenFlow.showSquad(w, h);
  }

  // Login/register/logout (design/16-accounts.md — the never-built account front
  // door). BACK returns to the main menu, same shape as showSquad.
  private showAccount() {
    this.phase = 'account';
    const { w, h } = this.screenSize();
    this.screenFlow.showAccount(w, h);
  }

  /**
   * Wraps connectOnlineSession with real connecting/error feedback (design/10 screen-
   * flow gap) — reached from ModeSelect's CO-OP/PVP SOLO QUEUE (beginSoloQueue) or
   * PartyScreen's START MATCHING (beginSquadMatch), which set `matchmakingReturnPhase`
   * first so Cancel/Back knows where to go back to.
   */
  private showMatchmaking() {
    this.phase = 'matchmaking';
    const { w, h } = this.screenSize();
    this.screenFlow.showMatchmaking(w, h, (signal) => this.connectForMatchmaking(signal));
  }

  /** The Matchmaking screen's injected connect function. */
  private connectForMatchmaking(signal: MatchmakingSignal): Promise<CoopSession> {
    return connectOnlineSession({
      matchBaseUrl: this.matchBaseUrl,
      pvp: this.pvp,
      pvpSeats: this.pvpSeats,
      lagMs: this.lagMs,
      partyId: this.partyId,
      signal,
      onMatchStart: (localOwner) => { this.localOwner = localOwner; },
      // Mid-match reconnect feedback (ROADMAP reconnect, design/06) — a drop this far
      // in is no longer this promise's business (it already resolved), so it's
      // surfaced straight through the HUD/outcome screen instead of Matchmaking's own
      // connecting/error state.
      onReconnecting: () => this.hud.toast(t('toast.reconnecting'), THEME.colors.enemy),
      onReconnected: () => this.hud.toast(t('toast.reconnected'), THEME.colors.pickupHeal),
      onConnectionLost: () => this.onOnlineConnectionLost(),
    });
  }

  /**
   * The bounded mid-match reconnect loop gave up (ROADMAP reconnect, design/06) —
   * previously this class of failure just left the run frozen forever with no
   * feedback at all (`CoopSession.drive()` silently stalls on a dead transport).
   * Ends the run the same way a real defeat does: the player gets a clear result
   * screen instead of a stuck one.
   */
  private onOnlineConnectionLost(): void {
    if (this.phase !== 'playing') return; // already resolved some other way (e.g. gameover raced it)
    this.setPhase('defeat');
    this.hideHud();
    this.showOutcomeScreen(false, t('results.connectionLostTitle'), [t('results.connectionLostBody')]);
  }

  private onMatchmakingCancelled() {
    this.matchmaking.hide();
    this.online = false;
    this.partyId = undefined;
    if (this.matchmakingReturnPhase === 'squad') this.showSquad();
    else this.showModeSelect();
  }

  /** ModeSelect's CO-OP / PVP SOLO QUEUE buttons (design/10 screen-flow gap) — the
   * menu-driven counterpart to the `?online=1`/`?pvp=1` boot-time URL flags, which were
   * previously the ONLY way to reach either mode. */
  private beginSoloQueue(pvp: boolean) {
    this.online = true;
    this.pvp = pvp;
    this.partyId = undefined;
    this.matchmakingReturnPhase = 'modeSelect';
    // PvP gets the match-preview confirm step first (design/10 open question); co-op
    // is plain PvE dungeon content and has nothing PvP-scaled to preview.
    if (pvp) this.showPvpPreview();
    else this.showMatchmaking();
  }

  /**
   * The party leader tapped START (or a member's poll saw the leader already had) —
   * hand off to the SAME online/PvP connect path `?pvp=1` uses, with this run's
   * squad size forced to 8 seats (2 squads of `SQUAD_SIZE`, the shape `teamIdForOwner`
   * actually chunks — design/05/15) and `partyId` attached so every member's
   * `POST /find` groups into one squad instead of a stranger's.
   */
  private beginSquadMatch(partyId: string) {
    this.online = true;
    this.pvp = true;
    this.pvpSeats = 8;
    this.partyId = partyId;
    this.matchmakingReturnPhase = 'squad';
    this.showMatchmaking();
  }

  // The forge outpost / loadout screen — the between-run hub (design/14). Shows the
  // current meta (bank / blueprints / loadout / character); Fire, Enter, or the START
  // RUN button descends into a run.
  private showForge() {
    this.phase = 'forge';
    const { w, h } = this.screenSize();
    this.screenFlow.showForge(w, h, this.meta);
  }

  /**
   * Re-syncs `this.meta` with the server right after a login/register
   * (design/16-accounts.md). A brand-new account has no server state yet — that case
   * pushes the current (possibly guest-accumulated) local state up instead of
   * overwriting it with nothing. Best-effort: any network failure just keeps using
   * local state, same as every other account-sync call in this project.
   */
  private async syncMetaStoreWithSession(): Promise<void> {
    const session = getSession();
    if (!session) return; // logged out — local state keeps being used as-is
    try {
      const remote = await pullAccountMeta(this.matchBaseUrl, session.token);
      this.meta = remote ?? this.meta;
      this.store.save(this.meta); // mirrors into localStorage and (if remote was null) pushes local state up
      if (this.phase === 'forge') {
        const { w, h } = this.screenSize();
        this.forge.render(this.meta, w, h);
      }
    } catch {
      /* offline/best-effort — keep using local state */
    }
  }

  // Apply a forge control (web keyboard). Mutates meta through the pure forge
  // transactions, persists, and re-renders. No-op outside the forge phase. Digits/C/X/B
  // route through the SAME private methods the Loadout screen's buttons call
  // (forgeCraftAt/forgeCycleCharacter/forgeClear/forgeAcquireBlueprint) — one source of
  // truth for both input paths, not duplicated logic.
  private onForgeKey(code: string) {
    if (this.phase !== 'forge') return;
    const digit = /^Digit([1-9])$/.exec(code);
    const { w, h } = this.screenSize();
    if (digit) {
      const i = Number(digit[1]) - 1;
      if (this.forge.order[i]) this.forgeCraftAt(i);
    } else if (code === 'KeyC') {
      this.forgeCycleCharacter();
    } else if (code === 'KeyX') {
      this.forgeClear();
    } else if (code === 'KeyB') {
      this.forgeAcquireBlueprint();
    } else if (code === 'KeyO') {
      this.openSettings();
    } else if (code === 'Enter' || code === 'NumpadEnter') {
      this.confirm();
    } else if (code === 'ArrowUp' || code === 'ArrowDown') {
      // Browse cursor only (design/10 compare card) — never crafts, so it can't be
      // confused with the digit keys'/row taps' immediate craft.
      this.forgeActions.moveSelection(this.meta, code === 'ArrowUp' ? -1 : 1, w, h);
    }
  }

  private forgeCraftAt(i: number) {
    const { w, h } = this.screenSize();
    this.meta = this.forgeActions.craftAt(this.meta, i, w, h);
  }

  private forgeCycleCharacter() {
    const { w, h } = this.screenSize();
    this.meta = this.forgeActions.cycleCharacter(this.meta, w, h);
  }

  private forgeAcquireBlueprint() {
    const { w, h } = this.screenSize();
    this.meta = this.forgeActions.acquireBlueprint(this.meta, w, h);
  }

  private forgeClear() {
    const { w, h } = this.screenSize();
    this.meta = this.forgeActions.clear(this.meta, w, h);
  }

  /**
   * Render state reset shared by every fresh run: offline dungeon/arenaDemo (beginRun),
   * a newly-connected online match (finalizeOnlineRun), and the tutorial
   * (beginTutorialRun). Extracted (design/10 screen-flow gap) so the online/tutorial
   * paths get the exact same cleanup the offline path always had, instead of
   * duplicating it or (as the online path used to) skipping it until connect resolved.
   */
  private resetRunRenderState() {
    this.scene.clear();
    // `particles.view` is a PERSISTENT child of `layers.fx` (added once in start()),
    // not a transient `_life`-tagged flash/trail — skip it here or a restart would
    // destroy the particle system itself, not just clear stale particles.
    for (const child of [...this.layers.fx.children]) {
      if (child !== this.fx.particles.view) child.destroy();
    }
    this.fx.resetForNewRun();
    this.roomBuilder.clear();
    this.score = 0;
    this.gameLoop.resetForNewRun();
    this.screenFlow.hideSettingsButton();
  }

  // Fresh OFFLINE run: reset render state and stand up a new engine (design/10
  // rebuild). Online runs no longer go through here at all (design/10 screen-flow gap)
  // — they route ModeSelect/PartyScreen → showMatchmaking → finalizeOnlineRun instead,
  // so a real connecting/error screen exists instead of a blank `playing` phase.
  private beginRun() {
    this.resetRunRenderState();
    this.tutorialActive = false;

    // `?arenaDemo=1` (dev-only, see the field's doc comment) — a synthetic local PvP
    // arena instead of the PvE dungeon, purely so the zone HUD row + Minimap have real
    // data to draw and can be eyeballed in a browser.
    if (this.arenaDemo) {
      this.beginArenaDemoRun();
      return;
    }

    // Carry the chosen character + the crafted loadout into the run (design/14) — see
    // offlineConfig.ts's buildDungeonRunConfig doc comment for the coop/single-player shape.
    this.engine = createGameEngine(buildDungeonRunConfig({
      seed: SEED_BASE + this.runCount,
      coop: this.coop,
      localSeat: { skinId: this.meta.selectedSkin, loadout: this.meta.loadout },
      allySkinId: this.allySkinId(),
    }));
    this.runCount++;

    // The crafted weapons are spent the moment they enter a run — one run each
    // (design/05). Consume the staged loadout now so a death doesn't refund it and the
    // next visit to the forge starts empty. Materials already left the bank at craft time.
    this.meta = clearLoadout(this.meta);
    this.store.save(this.meta);

    // No view priming here: the first room loads on sim tick 1 (SpawnSystem), which
    // teleports the player onto its spawn point and emits `room_enter`. The player's
    // view is first created — and snapped — during that tick's reconcile, at the real
    // spawn, and buildRoom draws the room then. Priming now would spawn the view at the
    // placeholder centre and make it visibly slide to the room spawn.
    this.phase = 'playing';
    this.hudView.visible = true;
    this.forge.hide();
    this.screens.hide();
  }

  /**
   * ModeSelect's TUTORIAL button (design/10 screen-flow gap) — a fixed, offline,
   * always-skippable standalone level (`tutorialConfig.ts`'s own doc comment has the
   * full account of why it's flat-mode, not the real dungeon). Mirrors
   * `beginArenaDemoRun`'s directness: flat mode never fires `room_enter` (that event is
   * dungeon-only, `SpawnSystem.loadRoom`), so `RoomBuilder`/`Portal` never gets
   * constructed by the normal event path — primed here directly instead, exactly like
   * the PvP arena demo (which has the same property, being all co-resident from tick 0).
   */
  private beginTutorialRun() {
    this.resetRunRenderState();
    this.tutorialActive = true;
    this.tutorialHints.reset();
    this.engine = createGameEngine(buildTutorialConfig({ skinId: this.meta.selectedSkin }));
    this.runCount++;
    this.roomBuilder.build(this.engine.state);
    this.phase = 'playing';
    this.hudView.visible = true;
    this.modeSelect.hide();
    this.screens.hide();
  }

  /** Dev-only (see `arenaDemo` field doc comment): a tiny synthetic 3-room ArenaMap +
   * two local seats on distinct teams. Unlike dungeon mode, arena rooms are all
   * co-resident from tick 0 (ROADMAP 4.2b) — no `room_enter` event ever fires to prime
   * the view, so `buildRoom` is called once here directly. The second seat is driven by
   * the existing coop bot-ally submit path (stepSim), not a real opponent. */
  private beginArenaDemoRun() {
    this.engine = createGameEngine(buildArenaDemoConfig({
      seed: SEED_BASE + this.runCount,
      localSkinId: this.meta.selectedSkin,
      allySkinId: this.allySkinId(),
    }));
    this.runCount++;
    this.roomBuilder.build(this.engine.state);
    this.phase = 'playing';
    this.hudView.visible = true;
    this.forge.hide();
    this.screens.hide();
  }

  // ---- Online co-op (ROADMAP 3.3): matchmaking → socket → CoopSession ----
  //
  // Connection setup (matchmaking + ticket redemption) lives in onlineConnect.ts, and the
  // run-config shape it needs in matchConfig.ts (both extracted 2026-07-28, pure of Game
  // state) — this just owns the session's lifecycle and phase transition. The matchmaking
  // ATTEMPT itself (design/10 screen-flow gap) now lives entirely in the Matchmaking
  // screen (connectForMatchmaking is just its injected connect function) — this method
  // only runs once that screen already has a connected session in hand, so there's no
  // more "blank playing phase while invisibly connecting" window.

  /** A match actually started — enter `playing` with the now-live session. */
  private finalizeOnlineRun(session: CoopSession) {
    this.resetRunRenderState();
    this.tutorialActive = false;
    this.session?.close();
    this.session = session;
    this.gameLoop.resetOnlinePrediction(); // re-anchors on the first confirmed frame of the new run
    this.matchmaking.hide();
    this.phase = 'playing';
    this.hudView.visible = true;
    this.forge.hide();
    this.screens.hide();
    this.partyScreen.hide();
  }

  /** A free character distinct from the local pick, for the co-op bot ally (ROADMAP 3.1). */
  allySkinId(): string {
    return Object.keys(SKIN_DEFS).find((id) => id !== this.meta.selectedSkin) ?? this.meta.selectedSkin;
  }

  // ---- RunOutcomeHost (see RunOutcome.ts) ----

  currentScore(): number {
    return this.score;
  }

  setPhase(phase: 'victory' | 'defeat'): void {
    this.phase = phase;
  }

  hideHud(): void {
    this.hudView.visible = false;
  }

  bankRunMaterials(s: GameState): void {
    this.meta = bankMaterials(this.meta, s.bankedMaterials);
    this.store.save(this.meta);
  }

  showOutcomeScreen(won: boolean, title: string, lines: readonly string[]): void {
    const { w, h } = this.screenSize();
    this.screens.show(w, h, won, title, lines, t('results.confirmHint'));
  }

  /**
   * The live sim state driving the render this frame — the locally-owned engine offline,
   * or the co-op session's engine online (ROADMAP 3.3). All shared render/event/HUD code
   * reads through this so it works identically on both paths (null before a run starts, or
   * online while still connecting/awaiting match_start).
   *
   * Not `private` — this doubles as the EventReactorHost interface EventReactor calls
   * back through (see the `events` field doc comment).
   */
  activeState(): GameState | null {
    return this.online ? this.session?.state ?? null : this.engine?.state ?? null;
  }

  // ---- EventReactorHost (see EventReactor.ts) ----

  addScore(delta: number): void {
    this.score += delta;
  }

  onRoomEnter(s: GameState): void {
    this.roomBuilder.build(s);
  }

  onDoorStateChange(s: GameState): void {
    this.roomBuilder.updateDoors(s);
  }

  onForceRegroup(): void {
    // Collapse prev==cur on the local player's view so interpolate() draws the new,
    // teleported position with no lerp-pan (same mechanism Scene.positionLocal/new-
    // entity spawn already use `Entity.snap()` for).
    this.scene.player?.snap();
  }

  onWeaponPickup(weaponId: string): void {
    if (!this.meta.unlockedBlueprints.includes(weaponId)) {
      this.meta = unlockBlueprint(this.meta, weaponId);
      this.store.save(this.meta);
    }
  }

  actorAt(id: number): { hitFlash(): void } | undefined {
    return this.scene.actorAt(id);
  }

  confirm() {
    this.audio.resume(); // a confirm tap is a user gesture — clears the autoplay gate (design/11)
    if (this.phase === 'menu') this.showForge();
    else if (this.phase === 'forge') this.beginRun();
    else if (this.phase === 'victory' || this.phase === 'defeat') {
      // The tutorial never touched the loadout, so it returns to ModeSelect instead of
      // Forge (design/10 screen-flow gap) — `hasSeenTutorial` was already marked the
      // moment this run hit gameover (stepSim), not here.
      if (this.tutorialActive) {
        this.tutorialActive = false;
        this.showModeSelect();
      } else {
        this.showForge();
      }
    }
  }

  // ---- Main loop (see GameLoop.ts) ----

  private update(dt: number) {
    this.gameLoop.update(dt);
  }

  // ---- GameLoopHost (see GameLoop.ts) ----

  getPhase(): Phase {
    return this.phase;
  }

  isOnline(): boolean {
    return this.online;
  }

  isCoop(): boolean {
    return this.coop;
  }

  isArenaDemo(): boolean {
    return this.arenaDemo;
  }

  isTutorialActive(): boolean {
    return this.tutorialActive;
  }

  getEngine(): GameEngine | null {
    return this.engine;
  }

  getSession(): CoopSession | null {
    return this.session;
  }

  selectedSkinId(): string {
    return this.meta.selectedSkin;
  }

  // Formula (and the HiDPI bug it fixes) lives in viewport.ts, split out to be unit-testable.
  screenSize() {
    return computeScreenSize(this.app);
  }
}
