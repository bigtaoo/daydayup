import { Graphics } from 'pixi.js';
import { CONFIG } from './config';
import { Entity } from './Entity';
import type { PickupKind } from '@dd/engine';

export type { PickupKind };

// Pickup view — an in-run drop (health / coin). Pure presentation: the engine owns
// the drop roll and collection; the hover bob here is render-only eye candy (it is
// NOT part of the sim, which is why PickupItem has no z). Position lerps like any
// other view; z is the local bob.
export class Pickup extends Entity {
  private bob = 0;

  constructor(kind: PickupKind) {
    super();
    const gfx = new Graphics();
    const color = kind === 'health' ? CONFIG.colors.pickupHealth : CONFIG.colors.pickupCoin;
    if (kind === 'health') {
      // A small plus sign reads as "heal" without art.
      gfx.roundRect(-3, -9, 6, 18, 2).fill({ color });
      gfx.roundRect(-9, -3, 18, 6, 2).fill({ color });
    } else {
      gfx.circle(0, 0, 7).fill({ color });
      gfx.circle(0, 0, 3.5).fill({ color: 0xfffbe6, alpha: 0.7 });
    }
    this.addChild(gfx);
    this.makeShadow(9);
  }

  override interpolate(alpha: number, frameDt: number): void {
    this.bob += frameDt * 0.12;
    const z = 8 + Math.sin(this.bob) * 3;
    this.applyTransform(
      this.prevX + (this.curX - this.prevX) * alpha,
      this.prevY + (this.curY - this.prevY) * alpha,
      z,
    );
  }
}
