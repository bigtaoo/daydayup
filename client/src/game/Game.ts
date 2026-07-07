import { Application, Container, Graphics, Text } from 'pixi.js';
import { CONFIG } from './config';
import { Layers } from './layers';
import { Entity } from './Entity';
import { Actor } from './Actor';
import { Skin } from './Skin';
import { Bullet } from './Bullet';
import { Enemy } from './Enemy';
import type { InputCanvas, InputSource } from '../platform/types';
import type { WeaponContext } from './weapons/Weapon';
import { RangedWeapon } from './weapons/RangedWeapon';
import { MeleeWeapon } from './weapons/MeleeWeapon';

// World size (for camera bounds and scene layout)
const WORLD_W = 1600;
const WORLD_H = 1200;

export class Game {
  private app: Application;
  private layers = new Layers();
  private input: InputSource;

  private player!: Actor;
  private enemies: Enemy[] = [];
  private bullets: Bullet[] = [];
  private pillars: Entity[] = [];

  private hud!: Text;
  private ctx: WeaponContext;

  constructor(app: Application, input: InputSource) {
    this.app = app;
    this.input = input;
    app.stage.addChild(this.layers.root);

    // Callbacks a weapon uses to produce world effects
    this.ctx = {
      spawnBullet: (gx, gy, dx, dy, faction) => this.spawnBullet(gx, gy, dx, dy, faction),
      flash: (gx, gy, color, radius) => this.flash(gx, gy, color, radius),
    };
  }

  start() {
    this.buildGround();
    this.buildPillars();
    this.buildPlayer();
    this.buildEnemies();
    this.buildHud();

    this.input.attach(this.app.canvas as unknown as InputCanvas);
    this.input.onSwitchWeapon = (slot) => this.switchWeapon(slot);
    this.input.onJump = () => this.player.jump();

    this.app.ticker.add((t) => this.update(t.deltaTime));
  }

  // ---- Scene construction ----

  private buildGround() {
    const g = new Graphics();
    g.rect(0, 0, WORLD_W, WORLD_H).fill({ color: CONFIG.colors.ground });
    const step = 64;
    for (let x = 0; x <= WORLD_W; x += step) {
      g.moveTo(x, 0).lineTo(x, WORLD_H);
    }
    for (let y = 0; y <= WORLD_H; y += step) {
      g.moveTo(0, y).lineTo(WORLD_W, y);
    }
    g.stroke({ color: CONFIG.colors.gridLine, width: 1 });
    this.layers.ground.addChild(g);
  }

  private buildPillars() {
    // Pillars: tall objects used to validate Y-sort occlusion. Tilted-view drawing: base + top cap.
    const spots = [
      [400, 400], [700, 550], [1000, 380], [1150, 720], [520, 780], [880, 900],
    ];
    for (const [gx, gy] of spots) {
      const p = new Entity();
      p.gx = gx;
      p.gy = gy;
      const height = 70;
      const body = new Graphics();
      // Pillar body (with height: extends upward)
      body.roundRect(-22, -height, 44, height + 10, 6).fill({ color: CONFIG.colors.pillar });
      // Top cap (the top face seen in tilted view)
      body.ellipse(0, -height, 24, 12).fill({ color: CONFIG.colors.pillarTop });
      p.addChild(body);
      p.makeShadow(26);
      this.layers.entities.addChild(p);
      this.layers.shadow.addChild(p.shadow!);
      this.pillars.push(p);
      p.sync();
    }
  }

  private buildPlayer() {
    const skin = new Skin(CONFIG.colors.player, CONFIG.colors.playerFront, CONFIG.playerRadius);
    this.player = new Actor('player', skin, CONFIG.playerRadius, CONFIG.playerMaxHp);
    this.player.gx = WORLD_W / 2;
    this.player.gy = WORLD_H / 2;
    this.player.equip(new RangedWeapon());

    this.layers.entities.addChild(this.player);
    this.layers.shadow.addChild(this.player.shadow!);
    this.player.sync();
  }

  private buildEnemies() {
    const spots = [[300, 300], [1250, 350], [1300, 850], [250, 950]];
    for (const [gx, gy] of spots) {
      const e = new Enemy(gx, gy);
      this.enemies.push(e);
      this.layers.entities.addChild(e);
      this.layers.shadow.addChild(e.shadow!);
      e.sync();
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

  // ---- Weapons ----

  private switchWeapon(slot: number) {
    if (slot === 1) this.player.equip(new RangedWeapon());
    else if (slot === 2) this.player.equip(new MeleeWeapon());
  }

  // ---- World effects ----

  private spawnBullet(gx: number, gy: number, vx: number, vy: number, faction: 'player' | 'enemy') {
    const b = new Bullet(gx, gy, vx, vy, faction);
    this.bullets.push(b);
    this.layers.entities.addChild(b);
    this.layers.shadow.addChild(b.shadow!);
  }

  private flash(gx: number, gy: number, color: number, radius: number) {
    // Soft glow from stacked circles, additive blend. WeChat-safe (no canvas2D).
    const glow = new Graphics();
    const steps = 5;
    for (let i = steps; i >= 1; i--) {
      glow.circle(0, 0, radius * (i / steps)).fill({ color, alpha: 0.16 });
    }
    glow.blendMode = 'add';
    glow.x = gx;
    glow.y = gy - 12;
    (glow as unknown as { _life: number })._life = 10;
    this.layers.fx.addChild(glow);
  }

  private updateFx(dt: number) {
    for (const child of [...this.layers.fx.children] as Container[]) {
      const holder = child as unknown as { _life: number };
      holder._life -= dt;
      child.alpha = Math.max(0, holder._life / 10);
      child.scale.set(1 + (1 - child.alpha) * 0.6);
      if (holder._life <= 0) {
        this.layers.fx.removeChild(child);
        child.destroy();
      }
    }
  }

  // ---- Main loop ----

  private update(dt: number) {
    if (this.player.alive) this.updatePlayer(dt);
    this.updateEnemies(dt);
    this.updateBullets(dt);
    this.updateFx(dt);
    this.updateCamera();
    this.updateHud();
  }

  private updatePlayer(dt: number) {
    const inp = this.input.read();

    // Movement
    this.player.gx += inp.moveX * CONFIG.playerSpeed * dt;
    this.player.gy += inp.moveY * CONFIG.playerSpeed * dt;
    this.player.gx = clamp(this.player.gx, 20, WORLD_W - 20);
    this.player.gy = clamp(this.player.gy, 20, WORLD_H - 20);

    // Facing. 'point' aim (mouse) is a screen position → convert to world space.
    // 'dir' aim (virtual joystick) is already a direction; apply it only when active
    // so an idle stick keeps the last facing instead of snapping.
    if (inp.aim.mode === 'point') {
      const worldAimX = inp.aim.x - this.layers.world.x;
      const worldAimY = inp.aim.y - this.layers.world.y;
      this.player.facing = Math.atan2(worldAimY - this.player.gy, worldAimX - this.player.gx);
    } else if (inp.aim.dx !== 0 || inp.aim.dy !== 0) {
      this.player.facing = Math.atan2(inp.aim.dy, inp.aim.dx);
    }

    this.player.updatePhysics(dt);

    const weapon = this.player.weapon;
    if (weapon) {
      // Melee blocking state
      const isMelee = weapon instanceof MeleeWeapon;
      weapon.setBlocking(isMelee && inp.blocking);
      weapon.update(dt);
      // No firing while blocking; otherwise attack
      if (!(isMelee && inp.blocking)) {
        weapon.use(this.ctx, inp.firing);
        if (isMelee && (weapon as MeleeWeapon).isSwinging) this.resolveMeleeHit(weapon as MeleeWeapon);
      }
    }
    this.player.sync();
  }

  // Melee swing hitting enemies
  private resolveMeleeHit(weapon: MeleeWeapon) {
    const p = this.player;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const dx = e.gx - p.gx;
      const dy = e.gy - p.gy;
      const dist = Math.hypot(dx, dy);
      if (dist > weapon.meleeRange + e.radius) continue;
      const ang = Math.atan2(dy, dx);
      if (Math.abs(angleDiff(ang, p.facing)) <= weapon.meleeArc * 0.5) {
        e.takeDamage(weapon.meleeDamage);
        this.flash(e.gx, e.gy, CONFIG.colors.swordGlow, 18);
      }
    }
  }

  private updateEnemies(dt: number) {
    for (const e of this.enemies) {
      if (!e.alive) {
        this.removeActor(e);
        continue;
      }
      const fire = e.tick(dt, this.player.gx, this.player.gy);
      e.updatePhysics(dt);
      if (fire && this.player.alive) {
        const a = e.facing;
        this.spawnBullet(e.gx + Math.cos(a) * 20, e.gy + Math.sin(a) * 20,
          Math.cos(a) * CONFIG.bulletSpeed, Math.sin(a) * CONFIG.bulletSpeed, 'enemy');
      }
      e.sync();
    }
    this.enemies = this.enemies.filter((e) => e.alive);
  }

  private updateBullets(dt: number) {
    const p = this.player;
    const weapon = p.weapon;
    const arc = weapon ? weapon.blockArc() : { active: false, half: 0, range: 0 };

    for (const b of this.bullets) {
      if (!b.alive) continue;
      b.step(dt);

      // Out of bounds
      if (b.gx < -50 || b.gx > WORLD_W + 50 || b.gy < -50 || b.gy > WORLD_H + 50) {
        b.alive = false;
        continue;
      }

      if (b.faction === 'enemy' && p.alive) {
        const dx = b.gx - p.gx;
        const dy = b.gy - p.gy;
        const dist = Math.hypot(dx, dy);

        // Melee block/deflect (see design/03)
        if (arc.active && dist <= arc.range) {
          const toBullet = Math.atan2(dy, dx);
          if (Math.abs(angleDiff(toBullet, p.facing)) <= arc.half) {
            const target = this.nearestEnemy(b.gx, b.gy);
            let ndx: number;
            let ndy: number;
            if (target) {
              const a = Math.atan2(target.gy - b.gy, target.gx - b.gx);
              ndx = Math.cos(a);
              ndy = Math.sin(a);
            } else {
              // No enemy → mirror-reflect
              ndx = Math.cos(p.facing);
              ndy = Math.sin(p.facing);
            }
            const sp = CONFIG.bulletSpeed * 1.4;
            b.deflect(ndx * sp, ndy * sp);
            this.flash(b.gx, b.gy, CONFIG.colors.blockArc, 20);
            continue;
          }
        }

        // Hit the player
        if (dist <= p.radius + CONFIG.bulletRadius) {
          p.takeDamage(b.damage);
          b.alive = false;
          this.flash(p.gx, p.gy, CONFIG.colors.enemy, 18);
          continue;
        }
      } else if (b.faction === 'player') {
        // A deflected bullet hitting enemies
        const hit = this.nearestEnemyHit(b.gx, b.gy);
        if (hit) {
          hit.takeDamage(2);
          b.alive = false;
          this.flash(b.gx, b.gy, CONFIG.colors.swordGlow, 18);
          continue;
        }
      }

      b.sync();
    }

    // Cleanup
    this.bullets = this.bullets.filter((b) => {
      if (!b.alive) {
        b.destroy();
        return false;
      }
      return true;
    });
  }

  private nearestEnemy(x: number, y: number): Enemy | null {
    let best: Enemy | null = null;
    let bd = Infinity;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const d = Math.hypot(e.gx - x, e.gy - y);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    return best;
  }

  private nearestEnemyHit(x: number, y: number): Enemy | null {
    for (const e of this.enemies) {
      if (!e.alive) continue;
      if (Math.hypot(e.gx - x, e.gy - y) <= e.radius + CONFIG.bulletRadius) return e;
    }
    return null;
  }

  private removeActor(a: Actor) {
    a.shadow?.parent?.removeChild(a.shadow);
    a.parent?.removeChild(a);
  }

  private updateCamera() {
    // Camera follows the player, centered, clamped to the world
    const vw = this.app.renderer.width / this.app.renderer.resolution;
    const vh = this.app.renderer.height / this.app.renderer.resolution;
    let cx = vw / 2 - this.player.gx;
    let cy = vh / 2 - this.player.gy;
    cx = clamp(cx, vw - WORLD_W, 0);
    cy = clamp(cy, vh - WORLD_H, 0);
    this.layers.world.x = cx;
    this.layers.world.y = cy;
  }

  private updateHud() {
    const w = this.player.weapon;
    const wname = w ? `${w.name} (${w.kind})` : 'none';
    const hp = '♥'.repeat(this.player.hp) + '·'.repeat(this.player.maxHp - this.player.hp);
    const blocking = w && w.blockArc().active ? '  [blocking]' : '';
    this.hud.text =
      `HP ${hp}${blocking}\n` +
      `Weapon ${wname}   Enemies ${this.enemies.length}\n` +
      `[1] gun  [2] sword   LMB = attack   RMB/Shift = block   Space = jump   WASD = move` +
      (this.player.alive ? '' : '\n\nYou are down — refresh to restart');
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// Normalize an angle difference to [-PI, PI]
function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
