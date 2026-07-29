import { Application, Container } from 'pixi.js';
import {
  createGameEngine,
  hashState,
  SKIN_DEFS,
  PLAYER_BASE,
  type GameEngine,
  type GameEvent,
  type GameState,
} from '@dd/engine';
import { CoopSession } from '../net/CoopSession';
import { connectOnlineSession } from './onlineConnect';
import { buildDungeonRunConfig, buildArenaDemoConfig } from './offlineConfig';
import { LocalPredictor, DEFAULT_PREDICTOR } from './LocalPredictor';
import {
  defaultMetaState, bankMaterials, craft, clearLoadout, selectCharacter,
  unlockBlueprint, acquireBlueprint, purchasableBlueprints,
  createWebMetaStore, type MetaState, type MetaStore,
} from '../meta';
import {
  defaultSettingsState, createWebSettingsStore, effectiveVolume,
  type SettingsState, type SettingsStore,
} from '../settings';
import { ELEMENT_COLORS } from './config';
import { Layers } from './layers';
import { Scene } from './Scene';
import { Screens } from './Screens';
import { Forge } from './Forge';
import { MainMenu } from './MainMenu';
import { PartyScreen } from './PartyScreen';
import { Settings } from './Settings';
import { PauseMenu } from './PauseMenu';
import { Button } from './ui/widgets';
import { FxController } from './FxController';
import { HudView } from './HudView';
import { TouchControlsView } from './ui/TouchControlsView';
import { CommandBuilder } from './CommandBuilder';
import { AllyController } from './AllyController';
import { EventReactor } from './EventReactor';
import { RoomBuilder } from './RoomBuilder';
import { RunOutcome } from './RunOutcome';
import { parseGameQueryParams } from './gameQueryParams';
import { fpToPx, bradToRad } from './coords';
import type { AudioBus, InputCanvas, InputSource } from '../platform/types';

// The demo runs the Ember biome as a seeded dungeon (design/05/09, ROADMAP 1.3): each
// floor is traversed room by room. The engine owns the geometry now — the render layer
// reads state.walls / state.obstacles / worldW/H per room and rebuilds on the
// `room_enter` event (RoomBuilder.build), so there are no fixed WORLD dimensions, wave
// list, or pillar layout here any more (offlineConfig.ts's own PLACEHOLDER_WORLD is
// ignored in dungeon/arena mode — each room/arena resizes the world as it loads).

const SEED_BASE = 0xda1d; // per-run seed = base + run index (deterministic, no Date)
const SIM_DT_MS = 1000 / 30; // fixed sim step: the engine runs at 30 Hz (design/06)
const MAX_STEPS = 5; // catch-up cap per render frame → no spiral of death

// Render-side run phases (design/10). The engine only knows idle/playing/gameover;
// the main menu (the boot front door), the forge/loadout outpost (the between-run hub,
// design/14), and the result screens live here in the shell, along with score (derived
// from events). 'paused' is the in-run pause menu (design/10's own open question,
// resolved) — 'settings' also serves as the pause menu's settings sub-screen (Game
// tracks which phase to return to via settingsReturnPhase). 'squad' is the PvP
// pre-formed-party lobby (design/05/15's squad follow-up) — the first runtime (not
// boot-flag) entry point into PvP.
type Phase = 'menu' | 'forge' | 'playing' | 'paused' | 'victory' | 'defeat' | 'settings' | 'squad';

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
  // Constructed in start(), not as a field initializer — it needs `this.matchBaseUrl`
  // AFTER the constructor's `?matchBaseUrl=` query-param override has applied, which a
  // field initializer would run before (design/05/15's PvP squad follow-up).
  private partyScreen!: PartyScreen;
  private settingsScreen = new Settings();
  private pauseMenu = new PauseMenu();
  // Settings can be opened from the main menu, the forge, OR the in-run pause menu
  // (design/10); this is which phase the settings screen's BACK button returns to. Set
  // right before each openSettings()/openSettingsFromPause() call, never read otherwise.
  private settingsReturnPhase: 'menu' | 'forge' | 'paused' = 'menu';
  private readonly roomBuilder = new RoomBuilder(this.layers);
  // Win/lose/placement screens (design/15), extracted into RunOutcome 2026-07-28 — `this`
  // is its host for the score/meta/phase/screen reactions (see that file's doc comment).
  private readonly runOutcome = new RunOutcome(this);

  // Persistent between-run meta (design/14): loaded at boot, saved on every change. The
  // forge outpost mutates it (craft / character / acquire); a run reads only its
  // (skinId, loadout) at start and banks materials back into it on a successful extract.
  private store: MetaStore = createWebMetaStore();
  private meta: MetaState = defaultMetaState();

  // Persistent client-side settings (design/10/11: master/SFX/music volume + mute).
  // Reached from the forge outpost only — see openSettings/closeSettings.
  private settingsStore: SettingsStore = createWebSettingsStore();
  private settings: SettingsState = defaultSettingsState();

  private phase: Phase = 'menu';
  private acc = 0; // accumulated real time (ms) not yet consumed by a sim step
  private runCount = 0;
  private score = 0;
  private prevFire = false; // rising-edge confirm on menus
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

  // Online local-player prediction (design/06): the render layer draws the local seat's own
  // movement/aim ahead of the confirmed frame stream to hide RTT, then eases to the
  // authoritative position. Render-only — the sim is untouched. `lagMs` is a `?lag=` DEV
  // harness (LaggyTransport) to feel/tune the smoothing without real devices.
  private readonly predictor = new LocalPredictor({
    // Match the sim's own speed so predicted ≈ confirmed at zero latency: player moves
    // PLAYER_BASE.speedPerTick per 30 Hz tick (players.ts) → px/sec.
    speedPxPerSec: fpToPx(PLAYER_BASE.speedPerTick) * (1000 / SIM_DT_MS),
    ...DEFAULT_PREDICTOR,
  });
  private predLastTick = -1;
  private lagMs = 0;

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

  constructor(app: Application, input: InputSource, audio: AudioBus) {
    this.app = app;
    this.input = input;
    this.audio = audio;
    // Built here (not as a field initializer) — it needs `this.audio`, which isn't
    // assigned yet when field initializers run.
    this.events = new EventReactor(this.fx, this.hud, this.audio, this);
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

    // Persisted volume takes effect immediately, not just after the first settings edit.
    this.settings = this.settingsStore.load();
    this.applyAudioSettings();
    this.settingsScreen.onChange = (s) => {
      this.settings = s;
      this.settingsStore.save(s);
      this.applyAudioSettings();
    };
    this.settingsScreen.onBack = () =>
      this.settingsReturnPhase === 'paused' ? this.openPauseFromSettings() : this.closeSettings();
  }

  private applyAudioSettings() {
    this.audio.setSfxVolume(effectiveVolume(this.settings, 'sfx'));
    this.audio.setMusicVolume(effectiveVolume(this.settings, 'music'));
  }

  start() {
    // Ground / walls / pillars are per-room now (buildRoom, driven by the `room_enter`
    // event), so nothing static is built here — only the fixed HUD overlay.
    this.buildHud();

    // Post-processing (design/01 milestone 3): vignette + chromatic-aberration live on
    // `world` only — the `ui` layer (HUD/menus) must stay crisp and undistorted.
    this.fx.attach();

    // Constructed here, not as a field initializer — see the field's own doc comment
    // (needs `this.matchBaseUrl` after the constructor's query-param override).
    this.partyScreen = new PartyScreen({ matchBaseUrl: this.matchBaseUrl });
    this.layers.ui.addChild(
      this.mainMenu.view, this.forge.view, this.screens.view, this.settingsScreen.view, this.pauseMenu.view,
      this.partyScreen.view,
    );
    this.mainMenu.onPlay = () => this.showForge();
    this.mainMenu.onSquad = () => this.showSquad();
    this.mainMenu.onSettings = () => this.openSettings();
    this.partyScreen.onBack = () => this.showMenu();
    this.partyScreen.onStartMatch = (partyId) => this.beginSquadMatch(partyId);
    this.forge.onBack = () => this.showMenu();
    this.forge.onCycleCharacter = () => this.forgeCycleCharacter();
    this.forge.onClear = () => this.forgeClear();
    this.forge.onCraftAt = (i) => this.forgeCraftAt(i);
    this.forge.onStart = () => this.confirm();
    this.screens.onConfirm = () => this.confirm();
    this.screens.onMenu = () => this.showMenu();
    this.pauseMenu.onResume = () => this.resume();
    this.pauseMenu.onSettings = () => this.openSettingsFromPause();
    this.pauseMenu.onQuit = () => this.quitRun();

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

    this.showMenu();
    this.app.ticker.add((t) => this.update(t.deltaMS));
  }

  // ---- Scene construction (static) ----
  //
  // Room/pillar geometry construction now lives in RoomBuilder (extracted 2026-07-28)
  // — see roomBuilder.build() calls in beginArenaDemoRun / EventReactorHost.onRoomEnter.

  private buildHud() {
    this.hud.build(this.layers, this.screenSize());
    this.hudView.addChild(this.hud.view, this.touchControlsView.view);
    this.layers.ui.addChild(this.hudView);

    // Settings entry (design/10) — only shown in the forge phase (showForge/beginRun).
    this.settingsBtn = new Button('SETTINGS', { w: 110, h: 30, fontSize: 12 });
    this.settingsBtn.onTap = () => this.openSettings();
    this.settingsBtn.view.visible = false;
    this.layers.ui.addChild(this.settingsBtn.view);
    this.settingsBtn.view.position.set(this.screenSize().w - 130, this.screenSize().h - 50);
  }

  private openSettings() {
    if (this.phase !== 'forge' && this.phase !== 'menu') return;
    this.settingsReturnPhase = this.phase;
    this.phase = 'settings';
    this.forge.hide();
    this.mainMenu.hide();
    this.settingsBtn.view.visible = false;
    const { w, h } = this.screenSize();
    this.settingsScreen.show(w, h, this.settings);
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
    this.pauseMenu.show(w, h);
  }

  private resume() {
    this.pauseMenu.hide();
    this.phase = 'playing';
  }

  private openSettingsFromPause() {
    this.settingsReturnPhase = 'paused';
    this.pauseMenu.hide();
    this.phase = 'settings';
    const { w, h } = this.screenSize();
    this.settingsScreen.show(w, h, this.settings);
  }

  private openPauseFromSettings() {
    this.settingsScreen.hide();
    this.phase = 'paused';
    const { w, h } = this.screenSize();
    this.pauseMenu.show(w, h);
  }

  // Voluntary quit (design/10) — behaves like a death for the run's own bookkeeping:
  // the floor's un-banked materials are simply forfeited, same as `lose()` never
  // calling bankMaterials (design/05 "death forfeits the floor buffer for free"). No
  // defeat screen/score penalty though — this was a choice, not a loss.
  private quitRun() {
    this.pauseMenu.hide();
    if (this.online) {
      this.session?.close();
      this.session = null;
    } else {
      this.engine = null;
    }
    this.showForge();
  }

  // ---- Run lifecycle ----

  // The main menu — the boot front door (design/10 screen flow). PLAY drops into the
  // forge/loadout screen below; SQUAD opens the PvP party lobby (design/05/15);
  // SETTINGS reuses the same settings overlay the forge uses.
  private showMenu() {
    this.phase = 'menu';
    this.hudView.visible = false;
    this.forge.hide();
    this.screens.hide();
    this.settingsScreen.hide();
    this.partyScreen.hide();
    this.settingsBtn.view.visible = false;
    const { w, h } = this.screenSize();
    this.mainMenu.show(w, h);
  }

  // The PvP pre-formed-party lobby (design/05/15's squad follow-up). BACK returns to
  // the main menu; a successful `onStartMatch` hands off to beginSquadMatch below.
  private showSquad() {
    this.phase = 'squad';
    this.hudView.visible = false;
    this.mainMenu.hide();
    this.forge.hide();
    this.screens.hide();
    this.settingsScreen.hide();
    const { w, h } = this.screenSize();
    this.partyScreen.show(w, h);
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
    this.beginRun();
  }

  // The forge outpost / loadout screen — the between-run hub (design/14). Shows the
  // current meta (bank / blueprints / loadout / character); Fire, Enter, or the START
  // RUN button descends into a run.
  private showForge() {
    this.phase = 'forge';
    this.hudView.visible = false;
    this.mainMenu.hide();
    this.screens.hide();
    this.settingsScreen.hide();
    this.partyScreen.hide();
    const { w, h } = this.screenSize();
    this.forge.render(this.meta, w, h);
    this.settingsBtn.view.position.set(w - 130, h - 50);
    this.settingsBtn.view.visible = true;
  }

  // Apply a forge control (web keyboard). Mutates meta through the pure forge
  // transactions, persists, and re-renders. No-op outside the forge phase. Digits/C/X
  // route through the SAME private methods the Loadout screen's buttons call
  // (forgeCraftAt/forgeCycleCharacter/forgeClear) — one source of truth for both input
  // paths, not duplicated logic.
  private onForgeKey(code: string) {
    if (this.phase !== 'forge') return;
    const digit = /^Digit([1-9])$/.exec(code);
    if (digit) {
      const i = Number(digit[1]) - 1;
      if (this.forge.order[i]) this.forgeCraftAt(i);
    } else if (code === 'KeyC') {
      this.forgeCycleCharacter();
    } else if (code === 'KeyX') {
      this.forgeClear();
    } else if (code === 'KeyB') {
      const buyable = purchasableBlueprints(this.meta);
      if (buyable[0]) {
        this.meta = acquireBlueprint(this.meta, buyable[0]); // demo: free grant (2.4 scaffold)
        this.store.save(this.meta);
        const { w, h } = this.screenSize();
        this.forge.render(this.meta, w, h);
      }
    } else if (code === 'KeyO') {
      this.openSettings();
    } else if (code === 'Enter' || code === 'NumpadEnter') {
      this.confirm();
    } else if (code === 'ArrowUp' || code === 'ArrowDown') {
      // Browse cursor only (design/10 compare card) — never crafts, so it can't be
      // confused with the digit keys'/row taps' immediate craft.
      this.forge.moveSelection(code === 'ArrowUp' ? -1 : 1);
      const { w, h } = this.screenSize();
      this.forge.render(this.meta, w, h);
    }
  }

  /** Craft blueprint `i` into the loadout (digit key or a Loadout-screen row tap) —
   * also moves the browse cursor onto it, so the compare card previews what was just
   * crafted. Silently ignores locked/unaffordable/full, same as before. */
  private forgeCraftAt(i: number) {
    this.forge.selectedIndex = i;
    const id = this.forge.order[i];
    if (id) {
      const res = craft(this.meta, id);
      if (res.ok) {
        this.meta = res.meta;
        this.store.save(this.meta);
      }
    }
    const { w, h } = this.screenSize();
    this.forge.render(this.meta, w, h);
  }

  private forgeCycleCharacter() {
    const next = this.cycleCharacter(this.meta);
    if (next !== this.meta) {
      this.meta = next;
      this.store.save(this.meta);
      const { w, h } = this.screenSize();
      this.forge.render(this.meta, w, h);
    }
  }

  private forgeClear() {
    this.meta = clearLoadout(this.meta);
    this.store.save(this.meta);
    const { w, h } = this.screenSize();
    this.forge.render(this.meta, w, h);
  }

  /** Advance the chosen character to the next owned one (design/14 roster select). */
  private cycleCharacter(m: MetaState): MetaState {
    const owned = m.ownedCharacters.filter((id) => SKIN_DEFS[id]);
    if (owned.length < 2) return m;
    const i = owned.indexOf(m.selectedSkin);
    return selectCharacter(m, owned[(i + 1) % owned.length]!);
  }

  // Fresh run: reset render state and stand up a new engine (design/10 rebuild).
  private beginRun() {
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
    this.acc = 0;
    this.settingsBtn.view.visible = false;

    // Online co-op (ROADMAP 3.3): the run is driven off a real matchmade socket, not a
    // locally-owned engine. Hand off to the async connect path and enter `playing` — the
    // render loop idles (advanceOnline) until the server's match_start builds the engine.
    if (this.online) {
      this.beginOnlineRun();
      return;
    }

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

  /** A free character distinct from the local pick, for the co-op bot ally (ROADMAP 3.1). */
  private allySkinId(): string {
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

  showOutcomeScreen(title: string, lines: readonly string[]): void {
    const { w, h } = this.screenSize();
    this.screens.show(w, h, title, lines, 'Press Fire — back to the loadout');
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

  onWeaponPickup(weaponId: string): void {
    if (!this.meta.unlockedBlueprints.includes(weaponId)) {
      this.meta = unlockBlueprint(this.meta, weaponId);
      this.store.save(this.meta);
    }
  }

  private confirm() {
    this.audio.resume(); // a confirm tap is a user gesture — clears the autoplay gate (design/11)
    if (this.phase === 'menu') this.showForge();
    else if (this.phase === 'forge') this.beginRun();
    else if (this.phase === 'victory' || this.phase === 'defeat') this.showForge();
  }

  // ---- Main loop: fixed-step sim + interpolated render ----

  private update(dt: number) {
    if (this.phase === 'playing') {
      if (this.online) this.advanceOnline(dt);
      else this.advanceSim(dt);
    } else if (this.phase === 'paused') {
      // Genuinely frozen (offline-only, see pause()'s doc comment): advanceSim/
      // advanceOnline are never called, so `acc` simply doesn't move — the same
      // no-catch-up-burst property hitStopMs already relies on. fx keeps fading so
      // the frozen frame doesn't look inert.
      this.updateFx(dt);
      this.scene.interpolate(1, dt);
    } else {
      // Menu / result / squad lobby: freeze the last frame, keep fx fading, poll for
      // confirm. `partyScreen.update` no-ops when hidden, so it's safe to call
      // unconditionally rather than gating on `this.phase === 'squad'` here too.
      this.updateFx(dt);
      this.scene.interpolate(1, dt);
      this.pollConfirm();
      this.partyScreen.update(dt);
    }
  }

  private advanceSim(dt: number) {
    // Hit-stop (design/01 milestone 3): a brief FULL freeze of sim ticks on a strong
    // hit — offline/local only (see the `hitStopMs` field doc). Render (fx/particles/
    // camera shake) keeps animating through the freeze; only `stepSim` is skipped, and
    // `acc` deliberately does NOT accumulate `dt` while frozen, so the sim resumes at a
    // clean single-tick cadence afterward instead of bursting through a catch-up.
    if (this.fx.consumeHitStop(dt)) {
      // frozen this frame — sim skipped, render still animates below
    } else {
      this.acc += dt;
      let steps = 0;
      while (this.phase === 'playing' && this.acc >= SIM_DT_MS && steps < MAX_STEPS) {
        this.stepSim();
        this.acc -= SIM_DT_MS;
        steps++;
      }
      if (steps >= MAX_STEPS) this.acc = 0; // drop the backlog after a long stall
    }

    const alpha = this.phase === 'playing' ? Math.min(1, this.acc / SIM_DT_MS) : 1;
    this.scene.interpolate(alpha, dt);
    this.updateFx(dt);
    this.updateCamera(alpha);
    if (this.phase === 'playing') {
      this.updateHud(dt);
      this.touchControlsView.update(this.input.getTouchVisual());
      // Keep the confirm edge fresh so arriving on a result screen with fire still
      // held doesn't instantly restart (the press must be released and re-issued).
      this.prevFire = this.input.read().firing;
    }
  }

  // One deterministic sim frame: collect input → command → advance the engine →
  // mirror the new state into views → react to this tick's events.
  private stepSim() {
    const engine = this.engine!;
    const s = engine.state;
    const p = s.players[this.localOwner];
    const playerPx = p ? { x: fpToPx(p.gx), y: fpToPx(p.gy) } : { x: 0, y: 0 };
    const cam = { x: this.layers.world.x, y: this.layers.world.y };

    const frame = s.tick + 1;
    engine.submit(this.builder.build(frame, this.localOwner, playerPx, cam, s, { enabled: this.settings.autoAim, screenPx: this.screenSize() }));
    // Local co-op (ROADMAP 3.1) — and the `?arenaDemo=1` dev harness, which reuses this
    // exact path: every non-local seat is driven by the bot ally, whose command goes
    // through the exact same submit path a networked teammate's would — the engine
    // can't tell a local bot from a remote player.
    if (this.coop || this.arenaDemo) {
      for (let owner = 0; owner < s.players.length; owner++) {
        if (owner !== this.localOwner) engine.submit(this.ally.build(s, owner, this.localOwner, frame));
      }
    }
    const events = engine.advance(frame) ?? [];

    this.scene.reconcile(s, p?.id ?? -1); // camera follows the LOCAL seat
    this.spawnBulletTrails(s);
    this.consumeEvents(events);

    if (s.phase === 'gameover') this.runOutcome.handle(s);
  }

  // ---- Online co-op (ROADMAP 3.3): matchmaking → socket → CoopSession ----
  //
  // Connection setup (matchmaking + ticket redemption) lives in onlineConnect.ts, and the
  // run-config shape it needs in matchConfig.ts (both extracted 2026-07-28, pure of Game
  // state) — this just owns the session's lifecycle and phase transition.

  /**
   * Enter a matchmade run. Async: connectOnlineSession asks the control plane for a
   * match and redeems the signed ticket, and CoopSession then drives the engine off the
   * confirmed frame stream. We enter `playing` immediately — advanceOnline idles until
   * `match_start` builds the engine — so the shell shows the run frame, not the forge.
   */
  private async beginOnlineRun() {
    this.phase = 'playing';
    this.hudView.visible = true;
    this.settingsBtn.view.visible = false;
    this.forge.hide();
    this.screens.hide();
    this.partyScreen.hide();
    this.session?.close();
    this.session = null;
    this.predictor.deactivate(); // re-anchors on the first confirmed frame of the new run
    this.predLastTick = -1;
    try {
      this.session = await connectOnlineSession({
        matchBaseUrl: this.matchBaseUrl,
        pvp: this.pvp,
        pvpSeats: this.pvpSeats,
        lagMs: this.lagMs,
        partyId: this.partyId,
        onMatchStart: (localOwner) => { this.localOwner = localOwner; },
      });
    } catch (e) {
      // Matchmaking or the socket failed — return to the forge (a real UI would toast this).
      console.error('[online] failed to start match', e);
      this.online = false; // fall back to offline for the next run attempt
      this.partyId = undefined; // don't silently retry a failed squad match with a stale party
      this.showForge();
      this.online = true;
    }
  }

  /**
   * The online counterpart to advanceSim. The SERVER is the clock: each render frame we
   * relay the local seat's latest command and drain every frame the server has confirmed
   * (CoopSession.drive self-paces the catch-up), then mirror the resulting state. The LOCAL
   * seat's movement/aim is drawn from a render-layer predictor ahead of the confirmed frame
   * (design/06 latency-hiding) and eased back on each confirmed frame; remote seats/enemies/
   * bullets stay confirmed. The sim is never touched — determinism is preserved.
   */
  private advanceOnline(dt: number) {
    const session = this.session;
    if (!session || !session.started) {
      // Connecting / awaiting match_start — hold the scene, keep fx fading.
      this.scene.interpolate(1, dt);
      this.updateFx(dt);
      return;
    }
    const s = session.state!;
    const p = s.players[this.localOwner];
    const playerPx = p ? { x: fpToPx(p.gx), y: fpToPx(p.gy) } : { x: 0, y: 0 };
    const cam = { x: this.layers.world.x, y: this.layers.world.y };

    // Relay this render tick's local command (server stamps the authoritative seat/frame).
    const cmd = this.builder.build(session.frame, this.localOwner, playerPx, cam, s, { enabled: this.settings.autoAim, screenPx: this.screenSize() });
    session.submit(cmd);

    // Predict the local seat's own motion for THIS render frame (before draining confirmed
    // frames) so movement/aim respond instantly under latency. Suspended when downed/dead.
    const predicting = !!p && p.alive && !p.downed;
    if (predicting) this.predictor.predict(cmd.moveBrad, cmd.moveMag, cmd.aimBrad, dt);

    const events = session.drive();

    // Reconcile toward the confirmed local position — but ONLY when a new confirmed frame
    // landed (a stall must not drag the prediction back); first activation snaps to spawn.
    if (predicting && p) {
      if (!this.predictor.isActive) {
        this.predictor.reset(fpToPx(p.gx), fpToPx(p.gy), bradToRad(p.facing));
      } else if (s.tick > this.predLastTick) {
        this.predictor.reconcile(fpToPx(p.gx), fpToPx(p.gy));
      }
      this.predLastTick = s.tick;
    } else {
      this.predictor.deactivate();
    }

    this.scene.reconcile(s, p?.id ?? -1); // camera follows the LOCAL (ticket-assigned) seat
    // Draw the local seat from the predictor (camera follows it too); remote seats confirmed.
    if (predicting && p && this.predictor.isActive) {
      const pose = this.predictor.pose;
      this.scene.positionLocal(pose.x, pose.y, fpToPx(p.z), pose.facing);
    }
    this.spawnBulletTrails(s);
    this.consumeEvents(events);
    this.scene.interpolate(1, dt);
    this.updateFx(dt);
    this.updateCamera(1);
    this.updateHud(dt);
    this.touchControlsView.update(this.input.getTouchVisual());
    this.prevFire = this.input.read().firing;

    if (s.phase === 'gameover') {
      // Report the local end-of-match hash (+ placements, for a PvP result) so the
      // server's checkpoint/hash-verified settlement — and, for PvP, the matchsvc
      // ladder-rating report (design/15, ROADMAP 4.4/4.6) — actually fires for a REAL
      // match. Exactly once: this branch only runs while `this.phase === 'playing'`,
      // and runOutcome.handle always moves it to 'victory'/'defeat' before returning.
      this.session?.reportResult(hashState(s));
      this.runOutcome.handle(s);
    }
  }

  // Events are the only engine→render channel (design/08): fx feedback + score + audio.
  // The actual per-event-type reactions live in EventReactor (extracted 2026-07-28).
  private consumeEvents(events: readonly GameEvent[]) {
    this.events.consume(events);
  }

  // ---- fx / camera (FxController does the actual work — see that file) ----

  // Per-element bullet trails (design/03/07). Once per sim tick, drop a fading
  // element-coloured dot at each live elemental bullet's position; the fx fade
  // (FxController.updateFx) turns the string of dots into a comet tail. Physical
  // rounds leave none — the trail IS the "this shot is elemental" tell, matched to
  // the bullet's glow and the aura it will leave on a hit. Render-only: reads
  // engine state, never writes it (design/08).
  private spawnBulletTrails(s: GameState) {
    for (const b of s.projectiles) {
      if (!b.alive) continue;
      const color = ELEMENT_COLORS[b.damageType];
      if (color === undefined) continue; // physical → no trail
      this.fx.trailDot(fpToPx(b.gx), fpToPx(b.gy), color, fpToPx(b.radius) * 0.9);
    }
  }

  // Thin adapters: FxController itself is decoupled from GameState/phase/screen size,
  // so these gather this frame's derived values (dust bounds, viewport, camera target)
  // and hand them down — the only reason these still live on Game rather than being
  // inlined at every call site.
  private updateFx(dt: number) {
    const s = this.activeState();
    const dustBounds = s ? { x: 0, y: 0, w: fpToPx(s.worldW), h: fpToPx(s.worldH) } : undefined;
    this.fx.updateFx(dt, this.phase === 'playing' ? 700 : 0, dustBounds);
  }

  private updateCamera(alpha: number) {
    const s = this.activeState();
    const worldSize = s ? { w: fpToPx(s.worldW), h: fpToPx(s.worldH) } : null;
    const { w: vw, h: vh } = this.screenSize();
    this.fx.updateCamera(alpha, { vw, vh }, worldSize, this.scene.player);
  }

  private screenSize() {
    return {
      w: this.app.renderer.width / this.app.renderer.resolution,
      h: this.app.renderer.height / this.app.renderer.resolution,
    };
  }

  private updateHud(dt: number) {
    const s = this.activeState();
    if (!s) return;
    this.hud.update(s, dt, {
      localOwner: this.localOwner,
      score: this.score,
      selectedSkin: this.meta.selectedSkin,
      showAlly: this.coop || this.arenaDemo,
      allySkinId: this.allySkinId(),
    });
  }

  // Rising-edge fire → confirm (start/restart) on non-playing screens.
  private pollConfirm() {
    const firing = this.input.read().firing;
    if (firing && !this.prevFire) this.confirm();
    this.prevFire = firing;
  }
}
