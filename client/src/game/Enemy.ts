import { CONFIG } from './config';
import { Actor } from './Actor';
import { Skin } from './Skin';

// Simple shooter: fires at the target on a timer. Used to validate block/deflect.
export class Enemy extends Actor {
  private fireTimer: number;

  constructor(gx: number, gy: number) {
    const skin = new Skin(CONFIG.colors.enemy, 0xffd6d6, 15);
    super('enemy', skin, 15, CONFIG.enemyHp);
    this.gx = gx;
    this.gy = gy;
    this.fireTimer = Math.floor(CONFIG.enemyFireInterval * (0.5 + gx % 1));
  }

  // Returns true if the enemy should fire this frame; direction is toward the target.
  tick(dt: number, targetX: number, targetY: number): boolean {
    this.facing = Math.atan2(targetY - this.gy, targetX - this.gx);
    this.fireTimer -= dt;
    if (this.fireTimer <= 0) {
      this.fireTimer = CONFIG.enemyFireInterval;
      return true;
    }
    return false;
  }
}
