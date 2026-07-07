import { Graphics } from 'pixi.js';
import { CONFIG } from '../config';
import { Weapon, type WeaponContext } from './Weapon';

export interface RangedSpec {
  fireRate: number; // frames between shots
  speed: number;
  damage: number;
}

// Ranged weapon. Data-driven (see design/03); the demo ships one default pistol.
export class RangedWeapon extends Weapon {
  readonly name = 'Blaster';
  readonly kind = 'ranged' as const;
  private spec: RangedSpec;

  constructor(spec: RangedSpec = { fireRate: 12, speed: CONFIG.bulletSpeed, damage: 1 }) {
    super();
    this.spec = spec;
    const g = new Graphics();
    // A barrel pointing along +x (facing 0 radians)
    g.roundRect(6, -4, 26, 8, 2).fill({ color: CONFIG.colors.gun });
    g.roundRect(2, -6, 10, 12, 3).fill({ color: 0x9aa5b1 });
    this.view.addChild(g);
  }

  use(ctx: WeaponContext, firing: boolean): void {
    if (!firing || !this.owner || this.cooldown > 0) return;
    this.cooldown = this.spec.fireRate;

    const a = this.owner.facing;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    // Spawn from the muzzle position
    const muzzleX = this.owner.gx + dx * 30;
    const muzzleY = this.owner.gy + dy * 30;
    ctx.spawnBullet(muzzleX, muzzleY, dx * this.spec.speed, dy * this.spec.speed, this.owner.faction);
    ctx.flash(muzzleX, muzzleY, CONFIG.colors.muzzle, 22);
  }
}
