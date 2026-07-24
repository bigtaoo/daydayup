import { Application, Container, Graphics, Text } from 'pixi.js';
import {
  createGameEngine,
  WEAPON_SIM_BY_ID,
  DEFAULT_SKIN_ID,
  EMBER_DUNGEON,
  EMBER_ROOMS,
  type GameEngine,
  type GameEvent,
  type GameState,
} from '@dd/engine';
import { CONFIG, ELEMENT_COLORS, rarityColor } from './config';
import { Layers } from './layers';
import { Entity } from './Entity';
import { Scene } from './Scene';
import { Screens } from './Screens';
import { CommandBuilder } from './CommandBuilder';
import { fpToPx } from './coords';
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
const FX_LIFE_MS = 170; // flash lifetime

// Render-side run phases (design/10). The engine only knows idle/playing/gameover;
// menu/result live here in the shell, along with score (derived from events).
type Phase = 'menu' | 'playing' | 'victory' | 'defeat';

export class Game {
  private app: Application;
  private layers = new Layers();
  private input: InputSource;
  private audio: AudioBus;

  private scene = new Scene(this.layers);
  private engine: GameEngine | null = null;
  private builder: CommandBuilder;

  private hud!: Text;
  private screens = new Screens();
  private pillars: Entity[] = [];

  private phase: Phase = 'menu';
  private acc = 0; // accumulated real time (ms) not yet consumed by a sim step
  private runCount = 0;
  private score = 0;
  private prevFire = false; // rising-edge confirm on menus
  // Chosen character (design/14). Selection UI is 2.3; for the demo it is config-
  // driven — a `?skin=` URL param picks one, else the default. Passed to the engine.
  private skinId: string = DEFAULT_SKIN_ID;

  constructor(app: Application, input: InputSource, audio: AudioBus) {
    this.app = app;
    this.input = input;
    this.audio = audio;
    this.builder = new CommandBuilder(input);
    if (typeof location !== 'undefined') {
      const q = new URLSearchParams(location.search).get('skin');
      if (q) this.skinId = q; // unknown ids fall back to the default in-engine (resolveSkin)
    }
    app.stage.eventMode = 'static'; // let the overlay receive pointer taps (web)
    app.stage.addChild(this.layers.root);
  }

  start() {
    // Ground / walls / pillars are per-room now (buildRoom, driven by the `room_enter`
    // event), so nothing static is built here — only the fixed HUD overlay.
    this.buildHud();

    this.layers.ui.addChild(this.screens.view);
    this.screens.onConfirm = () => this.confirm();

    this.input.attach(this.app.canvas as unknown as InputCanvas);
    // Discrete actions route through the shell: during a run they latch a one-tick
    // button pulse on the command builder; on menus/results a press confirms.
    this.input.onSwitchWeapon = () => {
      if (this.phase === 'playing') this.builder.requestSwap();
    };

    this.showMenu();
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

    const g = new Graphics();
    g.rect(0, 0, w, h).fill({ color: CONFIG.colors.ground });
    const step = 64;
    for (let x = 0; x <= w; x += step) g.moveTo(x, 0).lineTo(x, h);
    for (let y = 0; y <= h; y += step) g.moveTo(0, y).lineTo(w, y);
    g.stroke({ color: CONFIG.colors.gridLine, width: 1 });

    // AABB walls (ROADMAP 1.2 — finally drawn): filled tiles with an outline so the
    // solid collision geometry reads at a glance.
    for (const wall of s.walls) {
      const wx = fpToPx(wall.x);
      const wy = fpToPx(wall.y);
      const ww = fpToPx(wall.w);
      const wh = fpToPx(wall.h);
      g.rect(wx, wy, ww, wh).fill({ color: CONFIG.colors.wall }).stroke({ color: CONFIG.colors.wallEdge, width: 2 });
    }
    this.layers.ground.addChild(g);

    this.buildPillars(s);
  }

  // Round pillars for the current room, from the engine's obstacle solids. Tall
  // Y-sortable objects (occlusion + collision). Rebuilt per room; the drawn body is a
  // little wider than the collision footprint so the player can stand against it.
  private buildPillars(s: GameState) {
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
      body.roundRect(-bodyW / 2, -height, bodyW, height + 10, 6).fill({ color: CONFIG.colors.pillar });
      body.ellipse(0, -height, bodyW / 2 + 2, 12).fill({ color: CONFIG.colors.pillarTop });
      p.addChild(body);
      p.makeShadow(rad + 12);
      this.layers.entities.addChild(p);
      this.layers.shadow.addChild(p.shadow!);
      this.pillars.push(p);
      p.place(fpToPx(o.gx), fpToPx(o.gy));
    }
  }

  private buildHud() {
    this.hud = new Text({
      text: '',
      style: { fill: 0xe2e8f0, fontSize: 15, fontFamily: 'monospace', lineHeight: 20 },
    });
    this.hud.x = 12;
    this.hud.y = 10;
    this.layers.ui.addChild(this.hud);
  }

  // ---- Run lifecycle ----

  private showMenu() {
    this.phase = 'menu';
    this.hud.visible = false;
    const { w, h } = this.screenSize();
    this.screens.show(w, h, 'DAYDAYUP',
      'A twin-stick arena — clear every wave to win.',
      'Press Fire to start');
  }

  // Fresh run: reset render state and stand up a new engine (design/10 rebuild).
  private beginRun() {
    this.scene.clear();
    for (const child of [...this.layers.fx.children]) child.destroy();
    for (const child of [...this.layers.ground.children]) child.destroy();
    for (const p of this.pillars) { p.shadow?.destroy(); p.destroy(); }
    this.pillars.length = 0;
    this.score = 0;
    this.acc = 0;

    this.engine = createGameEngine({
      seed: SEED_BASE + this.runCount,
      worldW: PLACEHOLDER_WORLD, // ignored in dungeon mode; each room sets its own bounds
      worldH: PLACEHOLDER_WORLD,
      waves: [],
      skinId: this.skinId,
      dungeon: { config: EMBER_DUNGEON, library: EMBER_ROOMS },
    });
    this.runCount++;

    // No view priming here: the first room loads on sim tick 1 (SpawnSystem), which
    // teleports the player onto its spawn point and emits `room_enter`. The player's
    // view is first created — and snapped — during that tick's reconcile, at the real
    // spawn, and buildRoom draws the room then. Priming now would spawn the view at the
    // placeholder centre and make it visibly slide to the room spawn.
    this.phase = 'playing';
    this.hud.visible = true;
    this.screens.hide();
  }

  private win() {
    const s = this.engine?.state;
    const floor = s ? s.floorIndex + 1 : 0;
    const mats = s ? this.totalBanked(s) : 0;
    this.phase = 'victory';
    this.hud.visible = false;
    this.score += CONFIG.score.victory;
    const { w, h } = this.screenSize();
    this.screens.show(w, h, 'EXTRACTED',
      `Escaped floor ${floor}/${EMBER_DUNGEON.floorCount}.   Materials ${mats}   Score ${this.score}`,
      'Press Fire to run again');
  }

  private lose() {
    const floor = this.engine ? this.engine.state.floorIndex + 1 : 0;
    this.phase = 'defeat';
    this.hud.visible = false;
    const { w, h } = this.screenSize();
    this.screens.show(w, h, 'DEFEAT',
      `You fell on floor ${floor}/${EMBER_DUNGEON.floorCount}.   The floor's materials were lost.   Score ${this.score}`,
      'Press Fire to try again');
  }

  /** Total materials safely banked so far this run (design/05 carry-out bag). */
  private totalBanked(s: GameState): number {
    let n = 0;
    for (const v of Object.values(s.bankedMaterials)) n += v ?? 0;
    return n;
  }

  private confirm() {
    this.audio.resume(); // a confirm tap is a user gesture — clears the autoplay gate (design/11)
    if (this.phase !== 'playing') this.beginRun();
  }

  // ---- Main loop: fixed-step sim + interpolated render ----

  private update(dt: number) {
    if (this.phase === 'playing') {
      this.advanceSim(dt);
    } else {
      // Menu / result: freeze the last frame, keep fx fading, poll for confirm.
      this.updateFx(dt);
      this.scene.interpolate(1, dt);
      this.pollConfirm();
    }
  }

  private advanceSim(dt: number) {
    this.acc += dt;
    let steps = 0;
    while (this.phase === 'playing' && this.acc >= SIM_DT_MS && steps < MAX_STEPS) {
      this.stepSim();
      this.acc -= SIM_DT_MS;
      steps++;
    }
    if (steps >= MAX_STEPS) this.acc = 0; // drop the backlog after a long stall

    const alpha = this.phase === 'playing' ? Math.min(1, this.acc / SIM_DT_MS) : 1;
    this.scene.interpolate(alpha, dt);
    this.updateFx(dt);
    this.updateCamera(alpha);
    if (this.phase === 'playing') {
      this.updateHud();
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
    const p = s.players[0];
    const playerPx = p ? { x: fpToPx(p.gx), y: fpToPx(p.gy) } : { x: 0, y: 0 };
    const cam = { x: this.layers.world.x, y: this.layers.world.y };

    const frame = s.tick + 1;
    engine.submit(this.builder.build(frame, 0, playerPx, cam));
    const events = engine.advance(frame) ?? [];

    this.scene.reconcile(s);
    this.spawnBulletTrails(s);
    this.consumeEvents(events);

    if (s.phase === 'gameover') {
      if (s.winner === 'enemies') this.lose();
      else this.win();
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
        case 'bullet_fired':
          this.flash(fpToPx(e.gx), fpToPx(e.gy), CONFIG.colors.muzzle, 12);
          cues.add('muzzle');
          break;
        case 'hit':
          this.flash(fpToPx(e.gx), fpToPx(e.gy),
            e.faction === 'enemy' ? CONFIG.colors.enemy : CONFIG.colors.swordGlow, 16);
          cues.add('impact');
          break;
        case 'shield_break':
          // A shattered shield — a bright cyan burst (design/07 two-pool break).
          this.flash(fpToPx(e.gx), fpToPx(e.gy), CONFIG.colors.shield, 28);
          cues.add('shield.break');
          break;
        case 'deflect':
          this.flash(fpToPx(e.gx), fpToPx(e.gy), CONFIG.colors.deflect, 20);
          cues.add('deflect');
          break;
        case 'status': {
          // Elemental fx — a coloured flash by effect (design/03/07).
          const c =
            e.effect === 'burn' ? CONFIG.colors.statusBurn
            : e.effect === 'chill' ? CONFIG.colors.statusChill
            : e.effect === 'shock' ? CONFIG.colors.statusShock
            : CONFIG.colors.statusPoison;
          this.flash(fpToPx(e.gx), fpToPx(e.gy), c, 12);
          cues.add(`status.${e.effect}` as AudioCue);
          break;
        }
        case 'clash':
          this.flash(fpToPx(e.gx), fpToPx(e.gy), CONFIG.colors.clash, 14);
          cues.add('clash');
          break;
        case 'death':
          if (e.faction === 'enemy') {
            this.score += CONFIG.score.kill;
            cues.add('death');
          }
          break;
        case 'pickup':
          switch (e.kind) {
            case 'heal':
              this.flash(fpToPx(e.gx), fpToPx(e.gy), CONFIG.colors.pickupHeal, 20);
              cues.add('pickup.heal');
              break;
            case 'weapon': {
              // Flash in the dropped weapon's rarity colour (design/14) — the tier
              // reads at a glance. Falls back to the generic amber if unresolved.
              const spec = e.weaponId ? WEAPON_SIM_BY_ID[e.weaponId] : undefined;
              const c = spec ? rarityColor(spec) : CONFIG.colors.pickupWeapon;
              this.flash(fpToPx(e.gx), fpToPx(e.gy), c, 24);
              cues.add('pickup.weapon');
              break;
            }
            case 'buff':
              this.flash(fpToPx(e.gx), fpToPx(e.gy), CONFIG.colors.pickupBuff, 22);
              cues.add('pickup.buff');
              break;
            default: // material
              this.score += CONFIG.score.material;
              this.flash(fpToPx(e.gx), fpToPx(e.gy), CONFIG.colors.pickupMaterial, 16);
              cues.add('pickup.material');
          }
          break;
        case 'wave_clear':
          this.score += CONFIG.score.waveClear;
          cues.add('wave-clear');
          break;
        case 'room_enter':
          // A new dungeon room went live (ROADMAP 1.3) — mirror its geometry: ground,
          // AABB walls, pillars, and the resized world bounds (design/08 render-only).
          if (this.engine) this.buildRoom(this.engine.state);
          break;
        case 'descend': {
          // Banked the floor's materials and dropped deeper — a green pulse at the player.
          const p = this.engine?.state.players[0];
          if (p) this.flash(fpToPx(p.gx), fpToPx(p.gy), CONFIG.colors.extractGlow, 30);
          this.score += CONFIG.score.waveClear;
          cues.add('wave-clear');
          break;
        }
        case 'win':
          cues.add('win');
          break;
        // 'win' score bonus is handled by the outcome check (win()).
      }
    }
    for (const cue of cues) this.audio.play(cue);
  }

  // ---- fx (world glow, driven by events) ----

  // Per-element bullet trails (design/03/07). Once per sim tick, drop a fading
  // element-coloured dot at each live elemental bullet's position; the fx fade
  // (updateFx) turns the string of dots into a comet tail. Physical rounds leave
  // none — the trail IS the "this shot is elemental" tell, matched to the bullet's
  // glow and the aura it will leave on a hit. Render-only: reads engine state, never
  // writes it (design/08).
  private spawnBulletTrails(s: GameState) {
    for (const b of s.projectiles) {
      if (!b.alive) continue;
      const color = ELEMENT_COLORS[b.damageType];
      if (color === undefined) continue; // physical → no trail
      this.trailDot(fpToPx(b.gx), fpToPx(b.gy), color, fpToPx(b.radius) * 0.9);
    }
  }

  private trailDot(x: number, y: number, color: number, radius: number) {
    const dot = new Graphics();
    dot.circle(0, 0, radius).fill({ color, alpha: 0.5 });
    dot.blendMode = 'add';
    dot.x = x;
    dot.y = y - 12;
    (dot as unknown as { _life: number })._life = FX_LIFE_MS;
    this.layers.fx.addChild(dot);
  }

  private flash(x: number, y: number, color: number, radius: number) {
    const glow = new Graphics();
    const steps = 5;
    for (let i = steps; i >= 1; i--) {
      glow.circle(0, 0, radius * (i / steps)).fill({ color, alpha: 0.16 });
    }
    glow.blendMode = 'add';
    glow.x = x;
    glow.y = y - 12;
    (glow as unknown as { _life: number })._life = FX_LIFE_MS;
    this.layers.fx.addChild(glow);
  }

  private updateFx(dt: number) {
    for (const child of [...this.layers.fx.children] as Container[]) {
      const holder = child as unknown as { _life: number };
      holder._life -= dt;
      child.alpha = Math.max(0, holder._life / FX_LIFE_MS);
      child.scale.set(1 + (1 - child.alpha) * 0.6);
      if (holder._life <= 0) {
        this.layers.fx.removeChild(child);
        child.destroy();
      }
    }
  }

  // ---- Camera / HUD ----

  private updateCamera(alpha: number) {
    const pv = this.scene.player;
    if (!pv) return;
    const vw = this.app.renderer.width / this.app.renderer.resolution;
    const vh = this.app.renderer.height / this.app.renderer.resolution;
    // World bounds are per-room now (dungeon mode), read live from the engine.
    const s = this.engine?.state;
    const worldW = s ? fpToPx(s.worldW) : vw;
    const worldH = s ? fpToPx(s.worldH) : vh;
    // Follow the player, but pin the camera inside the room. A room smaller than the
    // viewport is centred (the follow-clamp would otherwise fight itself, lo > hi).
    const cx = worldW <= vw ? (vw - worldW) / 2 : clamp(vw / 2 - pv.interpGroundX(alpha), vw - worldW, 0);
    const cy = worldH <= vh ? (vh - worldH) / 2 : clamp(vh / 2 - pv.interpGroundY(alpha), vh - worldH, 0);
    this.layers.world.x = cx;
    this.layers.world.y = cy;
  }

  private screenSize() {
    return {
      w: this.app.renderer.width / this.app.renderer.resolution,
      h: this.app.renderer.height / this.app.renderer.resolution,
    };
  }

  private updateHud() {
    const s = this.engine!.state;
    const p = s.players[0];
    const w = p?.weapon;
    const wname = w
      ? `${w.spec.name} [${w.spec.rarity}] (${w.spec.kind}) dmg ${w.spec.damage}`
      : 'none';
    const hp = p ? Math.max(0, p.hp) : 0;
    const maxHp = p ? p.maxHp : 0;
    const bar = '♥'.repeat(hp) + '·'.repeat(Math.max(0, maxHp - hp));
    // Shield pool (design/07 two-pool) — shown as a separate row of diamonds.
    const sh = p ? Math.max(0, p.shield) : 0;
    const maxSh = p ? p.maxShield : 0;
    const shieldRow = maxSh > 0 ? `   SH ${'◆'.repeat(sh)}${'◇'.repeat(Math.max(0, maxSh - sh))}` : '';
    const buffs = p && p.buffs.length ? `   Buffs ${p.buffs.length}` : '';

    // Dungeon progress (ROADMAP 1.3): floor / room within floor, plus the banked bag.
    const floor = s.floorIndex + 1;
    const room = Math.max(1, s.roomIndex + 1);
    const rooms = s.floorStages.length; // total stages this floor (linear or branching)
    const banked = this.totalBanked(s);

    // Extraction prompt: only at a non-last-floor checkpoint (the last floor auto-
    // extracts). A room with no enemies left and all waves exhausted IS the checkpoint.
    const atCheckpoint = s.wavesExhausted && s.enemies.length === 0 && s.phase !== 'gameover';
    const isLastFloor = floor >= EMBER_DUNGEON.floorCount;
    const prompt = atCheckpoint && !isLastFloor
      ? '\n▶ CHECKPOINT — hold [E] to EXTRACT (bank & leave) · tap [E] to DESCEND'
      : '';

    this.hud.text =
      `${this.skinId}   HP ${bar}${shieldRow}${buffs}\n` +
      `Floor ${floor}/${EMBER_DUNGEON.floorCount}   Room ${room}/${rooms}   Enemies ${s.enemies.length}   Banked ${banked}   Score ${this.score}\n` +
      `Weapon ${wname}\n` +
      `[1]/[2] swap · LMB attack · WASD move · [E] interact` +
      prompt;
  }

  // Rising-edge fire → confirm (start/restart) on non-playing screens.
  private pollConfirm() {
    const firing = this.input.read().firing;
    if (firing && !this.prevFire) this.confirm();
    this.prevFire = firing;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
