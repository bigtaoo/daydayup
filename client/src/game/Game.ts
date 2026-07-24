import { Application, Container, Graphics, Text } from 'pixi.js';
import {
  createGameEngine,
  WEAPON_SIM_BY_ID,
  type GameEngine,
  type GameEvent,
  type GameState,
  type WaveDef,
} from '@dd/engine';
import { CONFIG, ELEMENT_COLORS, rarityColor } from './config';
import { Layers } from './layers';
import { Entity } from './Entity';
import { Scene } from './Scene';
import { Screens } from './Screens';
import { CommandBuilder } from './CommandBuilder';
import { fpToPx } from './coords';
import type { AudioBus, AudioCue, InputCanvas, InputSource } from '../platform/types';

// World size (px) — the arena for camera bounds and scene layout. Passed to the
// engine as px; the engine converts to grid-fp at its boundary (pxToFp).
const WORLD_W = 1600;
const WORLD_H = 1200;

// Scripted run: three escalating waves, in world px. The engine's SpawnSystem owns
// wave pacing now; this is just the position data handed to EngineConfig. A spawn
// entry is [x, y] (basic mob) or [x, y, type] where type keys ENEMY_BLUEPRINTS —
// the elemental variants each resist one element and are weak to a counter, so the
// player is rewarded for swapping to the right damage type (design/07).
const WAVES: WaveDef[] = [
  // Wave 1: a gentle intro — mostly basic, one fire-resistant emberling to notice.
  [[300, 300], [1300, 300], [800, 200, 'emberling']],
  // Wave 2: elemental pairs — bring ice for the emberling, fire for the frostling.
  [[250, 950, 'emberling'], [1350, 950, 'frostling'], [1300, 350, 'galvanist'], [300, 650]],
  // Wave 3: an armoured ironclad (shrug bullets/fire — shock it) among a mixed pack.
  [[200, 300, 'frostling'], [1400, 300, 'galvanist'], [200, 900], [1400, 900, 'emberling'], [800, 150, 'ironclad']],
  // Wave 4: the Blightlord finale — a durable boss weak to poison. Bring venom, stack
  // it, and watch the DoT + poison aura melt it (design/03/07). Two galvanists harass.
  [[800, 250, 'blightlord'], [300, 900, 'galvanist'], [1300, 900, 'galvanist']],
];

// Pillar layout (world px). Single source of truth for both the render mesh
// (buildPillars) and the engine's collision solids (EngineConfig.obstacles).
// Radius is the pillar's *base* footprint — smaller than the drawn body so the
// player (feet footprint) can stand against it and its body covers the lower
// column (Y-sort depth). Also the bullet-stop radius.
const PILLAR_RADIUS = 14;
const PILLARS: ReadonlyArray<readonly [number, number]> = [
  [400, 400], [700, 550], [1000, 380], [1150, 720], [520, 780], [880, 900],
];

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

  constructor(app: Application, input: InputSource, audio: AudioBus) {
    this.app = app;
    this.input = input;
    this.audio = audio;
    this.builder = new CommandBuilder(input);
    app.stage.eventMode = 'static'; // let the overlay receive pointer taps (web)
    app.stage.addChild(this.layers.root);
  }

  start() {
    this.buildGround();
    this.buildPillars();
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

  private buildGround() {
    const g = new Graphics();
    g.rect(0, 0, WORLD_W, WORLD_H).fill({ color: CONFIG.colors.ground });
    const step = 64;
    for (let x = 0; x <= WORLD_W; x += step) g.moveTo(x, 0).lineTo(x, WORLD_H);
    for (let y = 0; y <= WORLD_H; y += step) g.moveTo(0, y).lineTo(WORLD_W, y);
    g.stroke({ color: CONFIG.colors.gridLine, width: 1 });
    this.layers.ground.addChild(g);
  }

  private buildPillars() {
    // Tall objects that validate Y-sort occlusion AND collide — the engine gets
    // the same PILLARS list as round solids (EngineConfig.obstacles below). Placed
    // once, never interpolated.
    for (const [gx, gy] of PILLARS) {
      const p = new Entity();
      const height = 70;
      const body = new Graphics();
      body.roundRect(-22, -height, 44, height + 10, 6).fill({ color: CONFIG.colors.pillar });
      body.ellipse(0, -height, 24, 12).fill({ color: CONFIG.colors.pillarTop });
      p.addChild(body);
      p.makeShadow(26);
      this.layers.entities.addChild(p);
      this.layers.shadow.addChild(p.shadow!);
      this.pillars.push(p);
      p.place(gx!, gy!);
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
    this.score = 0;
    this.acc = 0;

    this.engine = createGameEngine({
      seed: SEED_BASE + this.runCount,
      worldW: WORLD_W,
      worldH: WORLD_H,
      waves: WAVES,
      obstacles: PILLARS.map(([x, y]) => [x, y, PILLAR_RADIUS] as const),
    });
    this.runCount++;

    // Prime the view + camera before the first sim step (player exists at tick 0).
    this.scene.reconcile(this.engine.state);

    this.phase = 'playing';
    this.hud.visible = true;
    this.screens.hide();
  }

  private win() {
    this.phase = 'victory';
    this.hud.visible = false;
    this.score += CONFIG.score.victory;
    const { w, h } = this.screenSize();
    this.screens.show(w, h, 'VICTORY',
      `All ${WAVES.length} waves cleared.   Score ${this.score}`,
      'Press Fire to play again');
  }

  private lose() {
    const wave = this.engine ? this.engine.state.waveIndex + 1 : 0;
    this.phase = 'defeat';
    this.hud.visible = false;
    const { w, h } = this.screenSize();
    this.screens.show(w, h, 'DEFEAT',
      `You reached wave ${wave} / ${WAVES.length}.   Score ${this.score}`,
      'Press Fire to try again');
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
            case 'health':
              this.flash(fpToPx(e.gx), fpToPx(e.gy), CONFIG.colors.pickupHealth, 20);
              cues.add('pickup.health');
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
            default: // coin
              this.score += CONFIG.score.coin;
              this.flash(fpToPx(e.gx), fpToPx(e.gy), CONFIG.colors.pickupCoin, 16);
              cues.add('pickup.coin');
          }
          break;
        case 'wave_clear':
          this.score += CONFIG.score.waveClear;
          cues.add('wave-clear');
          break;
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
    let cx = vw / 2 - pv.interpGroundX(alpha);
    let cy = vh / 2 - pv.interpGroundY(alpha);
    cx = clamp(cx, vw - WORLD_W, 0);
    cy = clamp(cy, vh - WORLD_H, 0);
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
    const wave = Math.max(1, s.waveIndex + 1);
    const buffs = p && p.buffs.length ? `   Buffs ${p.buffs.length}` : '';
    this.hud.text =
      `HP ${bar}${buffs}\n` +
      `Wave ${wave}/${WAVES.length}   Enemies ${s.enemies.length}   Score ${this.score}\n` +
      `Weapon ${wname}\n` +
      `[1]/[2] swap weapon   LMB = attack (melee swing also parries bullets)   WASD = move`;
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
