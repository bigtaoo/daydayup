import { Graphics } from 'pixi.js';
import { CONFIG } from './config';
import { Entity } from './Entity';

// In-run drop, spawned on enemy death and collected on player overlap.
// This is the render-side stand-in for the Pickup pass (steps 8-9) of design/08;
// the slice rolls the drop with Math.random — the deterministic dropPrng lands
// with the 06 engine migration.
export type PickupKind = 'health' | 'coin';

export class Pickup extends Entity {
  readonly kind: PickupKind;
  private bob = 0; // hover phase
  private gfx: Graphics;

  constructor(gx: number, gy: number, kind: PickupKind) {
    super();
    this.gx = gx;
    this.gy = gy;
    this.z = 8;
    this.kind = kind;

    const color = kind === 'health' ? CONFIG.colors.pickupHealth : CONFIG.colors.pickupCoin;
    this.gfx = new Graphics();
    if (kind === 'health') {
      // A small plus sign reads as "heal" without art
      this.gfx.roundRect(-3, -9, 6, 18, 2).fill({ color });
      this.gfx.roundRect(-9, -3, 18, 6, 2).fill({ color });
    } else {
      this.gfx.circle(0, 0, 7).fill({ color });
      this.gfx.circle(0, 0, 3.5).fill({ color: 0xfffbe6, alpha: 0.7 });
    }
    this.addChild(this.gfx);
    this.makeShadow(9);
  }

  // Gentle hover so drops read as collectable, not as debris.
  step(dt: number) {
    this.bob += dt * 0.12;
    this.z = 8 + Math.sin(this.bob) * 3;
  }
}
