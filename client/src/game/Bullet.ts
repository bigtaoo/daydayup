import { Graphics } from 'pixi.js';
import { CONFIG } from './config';
import { Entity } from './Entity';
import type { Faction } from './Actor';

// Bullet. Can be deflected by melee (faction changes from enemy to player and is redirected).
export class Bullet extends Entity {
  vx: number;
  vy: number;
  faction: Faction;
  life = CONFIG.bulletLifetime;
  damage = 1;
  private gfx: Graphics;

  constructor(gx: number, gy: number, vx: number, vy: number, faction: Faction) {
    super();
    this.gx = gx;
    this.gy = gy;
    this.z = 12; // bullets sit slightly above the ground
    this.vx = vx;
    this.vy = vy;
    this.faction = faction;

    this.gfx = new Graphics();
    this.draw();
    this.addChild(this.gfx);
    this.makeShadow(CONFIG.bulletRadius * 0.8);
  }

  private draw() {
    const color = this.faction === 'enemy' ? CONFIG.colors.bulletEnemy : CONFIG.colors.bulletPlayer;
    this.gfx.clear();
    this.gfx.circle(0, 0, CONFIG.bulletRadius).fill({ color });
  }

  // Deflect: switch faction + redirect velocity, and recolor.
  deflect(vx: number, vy: number) {
    this.faction = 'player';
    this.vx = vx;
    this.vy = vy;
    this.life = CONFIG.bulletLifetime;
    this.draw();
  }

  step(dt: number) {
    this.gx += this.vx * dt;
    this.gy += this.vy * dt;
    this.life -= dt;
    if (this.life <= 0) this.alive = false;
  }
}
