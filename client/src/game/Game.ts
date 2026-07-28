import { Application, Container, Graphics } from 'pixi.js';
import {
  createGameEngine,
  hashState,
  WEAPON_SIM_BY_ID,
  BLUEPRINT_CATALOG,
  SKIN_DEFS,
  EMBER_DUNGEON,
  EMBER_ROOMS,
  PLAYER_BASE,
  type GameEngine,
  type GameEvent,
  type GameState,
  type EngineConfig,
  type MatchStart,
} from '@dd/engine';
import { toFpGrid } from '@dd/engine/content/convert';
import { ARENA_CATALOG } from './arenaCatalog';
import { buildPvpEngineConfig } from './pvpConfig';
import { CoopSession } from '../net/CoopSession';
import { WebSocketTransport, LaggyTransport, type Transport } from '../net/transport';
import { findMatch } from '../net/matchmaking';
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
import { CONFIG, ELEMENT_COLORS, biomePalette, rarityColor, type BiomePalette } from './config';
import { Layers } from './layers';
import { Entity } from './Entity';
import { Scene } from './Scene';
import { Screens } from './Screens';
import { Forge } from './Forge';
import { Settings } from './Settings';
import { PauseMenu } from './PauseMenu';
import { Button } from './ui/widgets';
import { FxController } from './FxController';
import { HudView } from './HudView';
import { CommandBuilder } from './CommandBuilder';
import { AllyController } from './AllyController';
import { fpToPx, bradToRad } from './coords';
import type { AudioBus, AudioCue, InputCanvas, InputSource } from '../platform/types';

// The demo runs the Ember biome as a seeded dungeon (design/05/09, ROADMAP 1.3): each
// floor is generated from EMBER_ROOMS and traversed room by room. The engine owns the
// geometry now — the render layer reads state.walls / state.obstacles / worldW/H per
// room and rebuilds on the `room_enter` event (buildRoom), so there are no fixed WORLD
// dimensions, wave list, or pillar layout here any more. worldW/H below are placeholder
// bounds the engine ignores in dungeon mode (each room resizes the world as it loads).
const PLACEHOLDER_WORLD = 800;

const SEED_BASE = 0xda1d; // per-run seed = base + run index (deterministic, no Date)
const SIM_DT_MS = 1000 / 30; // fixed sim step: the engine runs at 30 Hz (design/06)
const MAX_STEPS = 5; // catch-up cap per render frame → no spiral of death

// Render-side run phases (design/10). The engine only knows idle/playing/gameover;
// the forge outpost (the between-run hub, design/14) and the result screens live here in
// the shell, along with score (derived from events). 'paused' is the in-run pause menu
// (design/10's own open question, resolved) — 'settings' also serves as the pause
// menu's settings sub-screen (Game tracks which phase to return to via pausedFromSettings).
type Phase = 'forge' | 'playing' | 'paused' | 'victory' | 'defeat' | 'settings';

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
  private settingsBtn!: Button;

  private screens = new Screens();
  private forge = new Forge();
  private settingsScreen = new Settings();
  private pauseMenu = new PauseMenu();
  // Settings can be opened from either the forge OR the in-run pause menu (design/10);
  // this is which phase the settings screen's BACK button returns to. Set right before
  // each openSettings()/openSettingsFromPause() call, never read otherwise.
  private settingsReturnPhase: 'forge' | 'paused' = 'forge';
  private pillars: Entity[] = [];

  // Persistent between-run meta (design/14): loaded at boot, saved on every change. The
  // forge outpost mutates it (craft / character / acquire); a run reads only its
  // (skinId, loadout) at start and banks materials back into it on a successful extract.
  private store: MetaStore = createWebMetaStore();
  private meta: MetaState = defaultMetaState();

  // Persistent client-side settings (design/10/11: master/SFX/music volume + mute).
  // Reached from the forge outpost only — see openSettings/closeSettings.
  private settingsStore: SettingsStore = createWebSettingsStore();
  private settings: SettingsState = defaultSettingsState();

  private phase: Phase = 'forge';
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
  private localOwner = 0;
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
  // one distinct teamId per seat) from `match_start`, and reports win/lose by placement
  // instead of the PvE extract/wipe outcome. Reuses the entire online/CoopSession path
  // `?online=1` already proved out — only `mode` and the config it builds differ.
  private pvp = false;
  private pvpSeats = 2;
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

  constructor(app: Application, input: InputSource, audio: AudioBus) {
    this.app = app;
    this.input = input;
    this.audio = audio;
    this.builder = new CommandBuilder(input);
    // Load persistent meta (bank / unlocks / loadout / chosen character, design/14).
    this.meta = this.store.load();
    // A `?skin=` URL param still overrides the chosen character (dev convenience), but
    // only to one the account owns — otherwise the saved choice stands.
    if (typeof location !== 'undefined') {
      const params = new URLSearchParams(location.search);
      const q = params.get('skin');
      if (q) this.meta = selectCharacter(this.meta, q);
      this.coop = params.get('coop') === '1'; // dev toggle: bring a local bot ally
      this.online = params.get('online') === '1'; // ROADMAP 3.3: real matchmade co-op
      this.arenaDemo = params.get('arenaDemo') === '1'; // dev toggle: synthetic local PvP arena
      this.pvp = params.get('pvp') === '1'; // real matchmade PvP arena (design/15)
      if (this.pvp) this.online = true; // a PvP run always rides the online/CoopSession path
      const seats = Number(params.get('seats'));
      if (Number.isInteger(seats) && seats >= 2 && seats <= 8) this.pvpSeats = seats;
      const mm = params.get('mm'); // override the matchsvc origin (default localhost:8788)
      if (mm) this.matchBaseUrl = mm;
      const lag = Number(params.get('lag')); // dev: inject synthetic one-way latency (ms)
      if (Number.isFinite(lag) && lag > 0) this.lagMs = lag;
      const wpn = params.get('wpn'); // dev toggle: start a run's loadout with exactly this weapon id
      if (wpn) this.meta = { ...this.meta, loadout: [wpn] };
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

    this.layers.ui.addChild(this.forge.view, this.screens.view, this.settingsScreen.view, this.pauseMenu.view);
    this.screens.onConfirm = () => this.confirm();
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

    this.showForge();
    this.app.ticker.add((t) => this.update(t.deltaMS));
  }

  // ---- Scene construction (static) ----

  // Rebuild the ground, AABB walls, and pillars for the CURRENTLY LOADED room. Driven
  // by the engine's `room_enter` event (and the first room at run start): dungeon
  // geometry lives in the engine now (state.walls / state.obstacles / worldW/H), and
  // this is the render mirror of it (design/08 "render only reads"). Grid/walls draw
  // flat on the ground layer; pillars are Y-sortable entities in the entities layer.
  private buildRoom(s: GameState) {
    const w = fpToPx(s.worldW);
    const h = fpToPx(s.worldH);

    for (const c of [...this.layers.ground.children]) c.destroy();

    // design/13 "per-biome background palette" — derived from the run's dungeon
    // biomeId (undefined outside dungeon mode, e.g. flat EngineConfig.floors/PvP
    // arena, which fall back to today's neutral palette unchanged).
    const palette = biomePalette(s.dungeonConfig?.biomeId);

    const g = new Graphics();
    g.rect(0, 0, w, h).fill({ color: palette.ground });
    const step = 64;
    for (let x = 0; x <= w; x += step) g.moveTo(x, 0).lineTo(x, h);
    for (let y = 0; y <= h; y += step) g.moveTo(0, y).lineTo(w, y);
    g.stroke({ color: palette.gridLine, width: 1 });

    // AABB walls (ROADMAP 1.2 — finally drawn): filled tiles with an outline so the
    // solid collision geometry reads at a glance.
    for (const wall of s.walls) {
      const wx = fpToPx(wall.x);
      const wy = fpToPx(wall.y);
      const ww = fpToPx(wall.w);
      const wh = fpToPx(wall.h);
      g.rect(wx, wy, ww, wh).fill({ color: palette.wall }).stroke({ color: palette.wallEdge, width: 2 });
    }
    this.layers.ground.addChild(g);

    this.buildPillars(s, palette);
  }

  // Round pillars for the current room, from the engine's obstacle solids. Tall
  // Y-sortable objects (occlusion + collision). Rebuilt per room; the drawn body is a
  // little wider than the collision footprint so the player can stand against it.
  private buildPillars(s: GameState, palette: BiomePalette) {
    for (const p of this.pillars) {
      p.shadow?.destroy();
      p.destroy();
    }
    this.pillars.length = 0;

    for (const o of s.obstacles) {
      const rad = fpToPx(o.radius);
      const bodyW = rad * 2 + 16; // visual body a touch wider than the footprint
      const height = 70;
      const p = new Entity();
      const body = new Graphics();
      body.roundRect(-bodyW / 2, -height, bodyW, height + 10, 6).fill({ color: palette.pillar });
      body.ellipse(0, -height, bodyW / 2 + 2, 12).fill({ color: palette.pillarTop });
      p.addChild(body);
      p.makeShadow(rad + 12);
      this.layers.entities.addChild(p);
      this.layers.shadow.addChild(p.shadow!);
      this.pillars.push(p);
      p.place(fpToPx(o.gx), fpToPx(o.gy));
    }
  }

  private buildHud() {
    this.hud.build(this.layers, this.screenSize());
    this.hudView.addChild(this.hud.view);
    this.layers.ui.addChild(this.hudView);

    // Settings entry (design/10) — only shown in the forge phase (showForge/beginRun).
    this.settingsBtn = new Button('SETTINGS', { w: 110, h: 30, fontSize: 12 });
    this.settingsBtn.onTap = () => this.openSettings();
    this.settingsBtn.view.visible = false;
    this.layers.ui.addChild(this.settingsBtn.view);
    this.settingsBtn.view.position.set(this.screenSize().w - 130, this.screenSize().h - 50);
  }

  private openSettings() {
    if (this.phase !== 'forge') return;
    this.settingsReturnPhase = 'forge';
    this.phase = 'settings';
    this.forge.hide();
    this.settingsBtn.view.visible = false;
    const { w, h } = this.screenSize();
    this.settingsScreen.show(w, h, this.settings);
  }

  private closeSettings() {
    this.showForge();
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

  // The forge outpost — the between-run hub (design/14). Shows the current meta (bank /
  // blueprints / loadout / character); Fire or Enter descends into a run.
  private showForge() {
    this.phase = 'forge';
    this.hudView.visible = false;
    this.screens.hide();
    this.settingsScreen.hide();
    const { w, h } = this.screenSize();
    this.forge.render(this.meta, w, h);
    this.settingsBtn.view.position.set(w - 130, h - 50);
    this.settingsBtn.view.visible = true;
  }

  // Apply a forge control (web keyboard). Mutates meta through the pure forge
  // transactions, persists, and re-renders. No-op outside the forge phase.
  private onForgeKey(code: string) {
    if (this.phase !== 'forge') return;
    const digit = /^Digit([1-9])$/.exec(code);
    let next = this.meta;
    if (digit) {
      const id = this.forge.order[Number(digit[1]) - 1];
      if (id) {
        const res = craft(this.meta, id);
        if (res.ok) next = res.meta; // silently ignores locked/unaffordable/full
      }
    } else if (code === 'KeyC') {
      next = this.cycleCharacter(this.meta);
    } else if (code === 'KeyX') {
      next = clearLoadout(this.meta);
    } else if (code === 'KeyB') {
      const buyable = purchasableBlueprints(this.meta);
      if (buyable[0]) next = acquireBlueprint(this.meta, buyable[0]); // demo: free grant (2.4 scaffold)
    } else if (code === 'KeyO') {
      this.openSettings();
      return;
    } else if (code === 'Enter' || code === 'NumpadEnter') {
      this.confirm();
      return;
    } else if (code === 'ArrowUp' || code === 'ArrowDown') {
      // Browse cursor only (design/10 compare card) — never crafts, so it can't be
      // confused with the digit keys' immediate craft.
      this.forge.moveSelection(code === 'ArrowUp' ? -1 : 1);
      const { w, h } = this.screenSize();
      this.forge.render(this.meta, w, h);
      return;
    }
    if (next !== this.meta) {
      this.meta = next;
      this.store.save(this.meta);
      const { w, h } = this.screenSize();
      this.forge.render(this.meta, w, h);
    }
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
    for (const child of [...this.layers.ground.children]) child.destroy();
    for (const p of this.pillars) { p.shadow?.destroy(); p.destroy(); }
    this.pillars.length = 0;
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

    // Carry the chosen character + the crafted loadout into the run (design/14). Local
    // co-op (ROADMAP 3.1) opts in a second seat — the bot ally, a distinct free character
    // — via EngineConfig.players; single-player passes the top-level skin/loadout and is
    // byte-identical (an absent `players` list → the same one-seat construction).
    const localSeat = { skinId: this.meta.selectedSkin, loadout: this.meta.loadout };
    this.engine = createGameEngine({
      seed: SEED_BASE + this.runCount,
      worldW: PLACEHOLDER_WORLD, // ignored in dungeon mode; each room sets its own bounds
      worldH: PLACEHOLDER_WORLD,
      waves: [],
      ...(this.coop
        ? { players: [localSeat, { skinId: this.allySkinId() }] }
        : { skinId: this.meta.selectedSkin, loadout: this.meta.loadout }),
      dungeon: { config: EMBER_DUNGEON, library: EMBER_ROOMS },
    });
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
    const map = ARENA_CATALOG.landing_basic;
    const px = (grid: number) => fpToPx(toFpGrid(grid));
    this.engine = createGameEngine({
      seed: SEED_BASE + this.runCount,
      worldW: PLACEHOLDER_WORLD,
      worldH: PLACEHOLDER_WORLD,
      waves: [],
      players: [
        { skinId: this.meta.selectedSkin, teamId: 0, start: [px(5), px(5)] }, // room A centre
        { skinId: this.allySkinId(), teamId: 1, start: [px(5), px(35)] }, // room C centre
      ],
      arena: map,
    });
    this.runCount++;
    this.buildRoom(this.engine.state);
    this.phase = 'playing';
    this.hudView.visible = true;
    this.forge.hide();
    this.screens.hide();
  }

  /** Decide + show the run's outcome from the sim's own gameover state (design/15's
   * placement model for an arena run, the PvE extract/wipe model otherwise). Shared by
   * the offline sim (stepSim) and the online/matchmade path (advanceOnline) — both just
   * detect `s.phase === 'gameover'` and hand the state here. */
  private handleGameOver(s: GameState) {
    if (s.zoneEnabled) {
      if (s.winner === this.localOwner) this.winArena(s);
      else this.loseArena(s);
    } else {
      if (s.winner === 'enemies') this.lose();
      else this.win();
    }
  }

  private win() {
    const s = this.activeState();
    const floor = s ? s.floorIndex + 1 : 0;
    const carried = s ? this.totalBanked(s) : 0;
    // Bank the run's carry-out into the persistent account (design/05/14) — the only
    // thing that leaves a run. A death (lose) never reaches here, so its floor buffer is
    // simply forfeited, no extra code.
    if (s) {
      this.meta = bankMaterials(this.meta, s.bankedMaterials);
      this.store.save(this.meta);
    }
    this.phase = 'victory';
    this.hudView.visible = false;
    this.score += CONFIG.score.victory;
    const { w, h } = this.screenSize();
    this.screens.show(w, h, 'EXTRACTED',
      `Escaped floor ${floor}/${EMBER_DUNGEON.floorCount}.   +${carried} materials banked.   Score ${this.score}`,
      'Press Fire — back to the forge');
  }

  private lose() {
    const s = this.activeState();
    const floor = s ? s.floorIndex + 1 : 0;
    this.phase = 'defeat';
    this.hudView.visible = false;
    const { w, h } = this.screenSize();
    this.screens.show(w, h, 'DEFEAT',
      `You fell on floor ${floor}/${EMBER_DUNGEON.floorCount}.   The floor's materials were lost.   Score ${this.score}`,
      'Press Fire — back to the forge');
  }

  /** PvP arena victory (design/15) — last seat standing. No materials/floor concept. */
  private winArena(s: GameState) {
    this.phase = 'victory';
    this.hudView.visible = false;
    this.score += CONFIG.score.victory;
    const { w, h } = this.screenSize();
    this.screens.show(w, h, 'VICTORY ROYALE',
      `1st place of ${s.players.length}.   Score ${this.score}`,
      'Press Fire — back to the forge');
  }

  /** PvP arena elimination (design/15) — `state.placements` is worst-to-best, the
   * winner never in it, so this seat's rank from the top is (total - its index). */
  private loseArena(s: GameState) {
    this.phase = 'defeat';
    this.hudView.visible = false;
    const idx = s.placements.indexOf(this.localOwner);
    const place = idx === -1 ? s.players.length : s.players.length - idx;
    const { w, h } = this.screenSize();
    this.screens.show(w, h, 'ELIMINATED',
      `Placed ${place}/${s.players.length}.   Score ${this.score}`,
      'Press Fire — back to the forge');
  }

  /** A free character distinct from the local pick, for the co-op bot ally (ROADMAP 3.1). */
  private allySkinId(): string {
    return Object.keys(SKIN_DEFS).find((id) => id !== this.meta.selectedSkin) ?? this.meta.selectedSkin;
  }

  /** Total materials safely banked so far this run (design/05 carry-out bag). */
  private totalBanked(s: GameState): number {
    let n = 0;
    for (const v of Object.values(s.bankedMaterials)) n += v ?? 0;
    return n;
  }

  /**
   * The live sim state driving the render this frame — the locally-owned engine offline,
   * or the co-op session's engine online (ROADMAP 3.3). All shared render/event/HUD code
   * reads through this so it works identically on both paths (null before a run starts, or
   * online while still connecting/awaiting match_start).
   */
  private activeState(): GameState | null {
    return this.online ? this.session?.state ?? null : this.engine?.state ?? null;
  }

  private confirm() {
    this.audio.resume(); // a confirm tap is a user gesture — clears the autoplay gate (design/11)
    if (this.phase === 'forge') this.beginRun();
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
      // Menu / result: freeze the last frame, keep fx fading, poll for confirm.
      this.updateFx(dt);
      this.scene.interpolate(1, dt);
      this.pollConfirm();
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

    if (s.phase === 'gameover') this.handleGameOver(s);
  }

  // ---- Online co-op (ROADMAP 3.3): matchmaking → socket → CoopSession ----

  /**
   * Enter a matchmade run. Async: ask the control plane for a match, redeem the signed
   * ticket on the gameserver socket, and let CoopSession drive the engine off the
   * confirmed frame stream. We enter `playing` immediately — advanceOnline idles until
   * `match_start` builds the engine — so the shell shows the run frame, not the forge.
   */
  private async beginOnlineRun() {
    this.phase = 'playing';
    this.hudView.visible = true;
    this.settingsBtn.view.visible = false;
    this.forge.hide();
    this.screens.hide();
    this.session?.close();
    this.session = null;
    this.predictor.deactivate(); // re-anchors on the first confirmed frame of the new run
    this.predLastTick = -1;
    try {
      const info = await findMatch(this.matchBaseUrl, {
        playerCount: this.pvp ? this.pvpSeats : 2,
        mode: this.pvp ? 'pvp' : 'coop',
      });
      const url = `${info.wsUrl}?ticket=${encodeURIComponent(info.token)}`;
      // A `?lag=` dev toggle wraps the socket to inject synthetic RTT (feel/tune prediction).
      let transport: Transport = new WebSocketTransport(url);
      if (this.lagMs > 0) transport = new LaggyTransport(transport, this.lagMs);
      this.session = new CoopSession({
        transport,
        roomId: info.roomId,
        owner: info.owner,
        seed: info.seed,
        playerCount: info.playerCount,
        buildConfig: (m) => this.buildOnlineConfig(m),
        // The ticket assigns THIS client's seat — the camera/HUD follow it, not a fixed 0.
        onMatchStart: (m) => {
          this.localOwner = m.localOwner;
        },
      });
    } catch (e) {
      // Matchmaking or the socket failed — return to the forge (a real UI would toast this).
      console.error('[online] failed to start match', e);
      this.online = false; // fall back to offline for the next run attempt
      this.showForge();
      this.online = true;
    }
  }

  /**
   * Build the run config from `match_start`. It MUST be byte-identical on every client
   * (determinism, design/06), so it derives ONLY from the shared seed + playerCount:
   * seats are skinned by index (distinct, agreed characters), and neither the local
   * chosen character nor the crafted loadout enters — carrying those into online play
   * needs them to travel through matchmaking first (a later step).
   *
   * `m.mode === 'pvp'` (design/15, ROADMAP Phase 4 closeout) branches to the arena
   * shape instead: every seat gets its OWN teamId (solo battle royale, ROADMAP 4.2a)
   * and `arena` is the real ~60-room launch map (`ARENA_CATALOG.arena_prototype_60`,
   * see arenaCatalog.ts) — setting `arena` is what flips `state.zoneEnabled` and turns
   * on ZoneSystem/EnvironmentSystem/the placement win condition, AND (ENGINE_VERSION
   * 20, ROADMAP 4.2c) what makes `GameState.buildSeat` resolve each seat's weapons/HP
   * through `buildArenaSpecs` (the landing-kit loadout + `PVP_SCALE_FACTOR`-scaled body
   * stats) instead of the PvE run-builder path — no `loadout` needs setting here at all,
   * since an arena seat never reads it.
   */
  private buildOnlineConfig(m: MatchStart): EngineConfig {
    const ids = Object.keys(SKIN_DEFS);
    if (m.mode === 'pvp') {
      // Extracted to pvpConfig.ts (design/06 anti-drift) — server/src/BotClient.ts builds
      // the identical config for a bot-filled seat from the same function.
      return buildPvpEngineConfig(m.seed, m.playerCount);
    }
    return {
      seed: m.seed,
      worldW: PLACEHOLDER_WORLD,
      worldH: PLACEHOLDER_WORLD,
      waves: [],
      players: Array.from({ length: m.playerCount }, (_, i) => ({ skinId: ids[i % ids.length]! })),
      dungeon: { config: EMBER_DUNGEON, library: EMBER_ROOMS },
    };
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
    this.prevFire = this.input.read().firing;

    if (s.phase === 'gameover') {
      // Report the local end-of-match hash (+ placements, for a PvP result) so the
      // server's checkpoint/hash-verified settlement — and, for PvP, the matchsvc
      // ladder-rating report (design/15, ROADMAP 4.4/4.6) — actually fires for a REAL
      // match. Exactly once: this branch only runs while `this.phase === 'playing'`,
      // and handleGameOver always moves it to 'victory'/'defeat' before returning.
      this.session?.reportResult(hashState(s));
      this.handleGameOver(s);
    }
  }

  // Events are the only engine→render channel (design/08): fx feedback + score + audio.
  private consumeEvents(events: readonly GameEvent[]) {
    // Coalesce audio cues within the frame: a bullet-hell frame can emit dozens of
    // identical events, so we collect the distinct cues here and play each ONCE after
    // the loop (design/11 "coalesce identical cues in the same frame"). fx/score still
    // react per-event below — only sound is deduped.
    const cues = new Set<AudioCue>();
    for (const e of events) {
      switch (e.type) {
        case 'bullet_fired': {
          const fx = fpToPx(e.gx);
          const fy = fpToPx(e.gy);
          this.fx.flash(fx, fy, CONFIG.colors.muzzle, 12);
          const facingRad = bradToRad(e.facing);
          this.fx.particles.muzzleFlame(fx, fy - 12, facingRad, CONFIG.colors.muzzle);
          this.fx.particles.shellCasing(fx, fy - 12, facingRad);
          cues.add('muzzle');
          break;
        }
        case 'hit':
          this.fx.flash(fpToPx(e.gx), fpToPx(e.gy),
            e.faction === 'enemy' ? CONFIG.colors.enemy : CONFIG.colors.swordGlow, 16);
          if (e.faction === 'enemy') {
            // The (any) player took the hit — a small punch of feedback.
            this.fx.addShake(0.18);
            this.fx.pulseChromatic(0.006);
          }
          cues.add('impact');
          break;
        case 'shield_break':
          // A shattered shield — a bright cyan burst (design/07 two-pool break).
          this.fx.flash(fpToPx(e.gx), fpToPx(e.gy), CONFIG.colors.shield, 28);
          this.fx.addShake(0.4);
          this.fx.addHitStop(50);
          this.fx.pulseChromatic(0.014);
          cues.add('shield.break');
          break;
        case 'deflect':
          this.fx.flash(fpToPx(e.gx), fpToPx(e.gy), CONFIG.colors.deflect, 20);
          this.fx.addShake(0.22);
          this.fx.pulseChromatic(0.008);
          cues.add('deflect');
          break;
        case 'status': {
          // Elemental fx — a coloured flash by effect (design/03/07).
          const c =
            e.effect === 'burn' ? CONFIG.colors.statusBurn
            : e.effect === 'chill' ? CONFIG.colors.statusChill
            : e.effect === 'shock' ? CONFIG.colors.statusShock
            : CONFIG.colors.statusPoison;
          this.fx.flash(fpToPx(e.gx), fpToPx(e.gy), c, 12);
          cues.add(`status.${e.effect}` as AudioCue);
          break;
        }
        case 'clash':
          this.fx.flash(fpToPx(e.gx), fpToPx(e.gy), CONFIG.colors.clash, 14);
          cues.add('clash');
          break;
        case 'enrage':
          // A boss crossed its enrage threshold (design/09 traits) — a hard red pulse,
          // distinct from a normal hit flash, so it reads as a real escalation moment.
          this.fx.flash(fpToPx(e.gx), fpToPx(e.gy), CONFIG.colors.enemy, 40);
          this.fx.addShake(0.35);
          this.fx.pulseChromatic(0.012);
          cues.add('shield.break'); // reuse the existing sting; no dedicated cue authored yet
          break;
        case 'death':
          if (e.faction === 'enemy') {
            this.score += CONFIG.score.kill;
            this.fx.particles.explosionDebris(fpToPx(e.gx), fpToPx(e.gy) - 12, CONFIG.colors.enemy);
            this.fx.addShake(0.15);
            cues.add('death');
          }
          break;
        case 'pickup':
          switch (e.kind) {
            case 'heal':
              this.fx.flash(fpToPx(e.gx), fpToPx(e.gy), CONFIG.colors.pickupHeal, 20);
              cues.add('pickup.heal');
              this.hud.toast('+1 HP', CONFIG.colors.pickupHeal);
              break;
            case 'weapon': {
              // Flash in the dropped weapon's rarity colour (design/14) — the tier
              // reads at a glance. Falls back to the generic amber if unresolved.
              const spec = e.weaponId ? WEAPON_SIM_BY_ID[e.weaponId] : undefined;
              const c = spec ? rarityColor(spec) : CONFIG.colors.pickupWeapon;
              this.fx.flash(fpToPx(e.gx), fpToPx(e.gy), c, 24);
              cues.add('pickup.weapon');
              this.hud.toast(spec ? spec.name : 'New weapon', c);
              // Finding a catalogued weapon permanently unlocks its forge blueprint
              // (design/14 "2–3 common blueprints drop from runs") — first-pass: any
              // catalogued pickup grants it. Meta is separate from the sim, so this
              // mid-run write can't affect determinism.
              if (e.weaponId && BLUEPRINT_CATALOG[e.weaponId] && !this.meta.unlockedBlueprints.includes(e.weaponId)) {
                this.meta = unlockBlueprint(this.meta, e.weaponId);
                this.store.save(this.meta);
              }
              break;
            }
            case 'buff':
              this.fx.flash(fpToPx(e.gx), fpToPx(e.gy), CONFIG.colors.pickupBuff, 22);
              cues.add('pickup.buff');
              this.hud.toast(e.buffId ? `Buff: ${e.buffId}` : 'Buff', CONFIG.colors.pickupBuff);
              break;
            default: // material
              this.score += CONFIG.score.material;
              this.fx.flash(fpToPx(e.gx), fpToPx(e.gy), CONFIG.colors.pickupMaterial, 16);
              cues.add('pickup.material');
              this.hud.toast(`+${e.qty ?? 1} ${e.materialId ?? 'material'}`, CONFIG.colors.pickupMaterial);
          }
          break;
        case 'wave_clear':
          this.score += CONFIG.score.waveClear;
          cues.add('wave-clear');
          break;
        case 'room_enter': {
          // A new dungeon room went live (ROADMAP 1.3) — mirror its geometry: ground,
          // AABB walls, pillars, and the resized world bounds (design/08 render-only).
          const s = this.activeState();
          if (s) this.buildRoom(s);
          break;
        }
        case 'descend': {
          // Banked the floor's materials and dropped deeper — a green pulse at the player.
          const p = this.activeState()?.players[this.localOwner];
          if (p) this.fx.flash(fpToPx(p.gx), fpToPx(p.gy), CONFIG.colors.extractGlow, 30);
          this.score += CONFIG.score.waveClear;
          cues.add('wave-clear');
          break;
        }
        case 'downed':
          // A player was incapacitated (co-op downed/revive, ROADMAP 3.2) — a red pulse.
          // In the single-player demo this is the moment the run is lost.
          this.fx.flash(fpToPx(e.gx), fpToPx(e.gy), CONFIG.colors.clash, 28);
          this.fx.addShake(0.55);
          this.fx.addHitStop(80);
          this.fx.pulseChromatic(0.02);
          cues.add('death');
          break;
        case 'revived':
          // A teammate channelled the player back up — a green pulse (co-op only).
          this.fx.flash(fpToPx(e.gx), fpToPx(e.gy), CONFIG.colors.extractGlow, 28);
          cues.add('pickup.heal');
          break;
        case 'win':
          cues.add('win');
          break;
        // 'win' score bonus is handled by the outcome check (win()).
      }
    }
    for (const cue of cues) this.audio.play(cue);
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
