import { Graphics } from 'pixi.js';
import { CONFIG } from './config';
import { Entity } from './Entity';
import type { Faction } from './Actor';

// Bullet view. Pure presentation: a coloured dot with a shadow, positioned by the
// engine each tick. The engine may flip a bullet's faction (melee deflect: enemy →
// player); the view re-reads faction each reconcile and recolours to match.
export class Bullet extends Entity {
  private gfx = new Graphics();
  private radiusPx: number;
  private faction: Faction | null = null;

  constructor(radiusPx: number) {
    super();
    this.radiusPx = radiusPx;
    this.addChild(this.gfx);
    this.makeShadow(radiusPx * 0.8);
  }

  setFaction(faction: Faction): void {
    if (faction === this.faction) return;
    this.faction = faction;
    const color = faction === 'enemy' ? CONFIG.colors.bulletEnemy : CONFIG.colors.bulletPlayer;
    this.gfx.clear();
    this.gfx.circle(0, 0, this.radiusPx).fill({ color });
  }
}
