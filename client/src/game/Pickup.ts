import { Graphics } from 'pixi.js';
import { CONFIG } from './config';
import { Entity } from './Entity';
import type { PickupKind } from '@dd/engine';

export type { PickupKind };

// Pickup view — an in-run drop (health / coin / affix / weapon). Pure presentation:
// the engine owns the drop roll and collection; the hover bob here is render-only
// eye candy (it is NOT part of the sim, which is why PickupItem has no z). Position
// lerps like any other view; z is the local bob. Each kind gets a distinct silhouette
// so a player reads "power drop" (gem) vs "new gun" (chevron) at a glance.
export class Pickup extends Entity {
  private bob = 0;

  constructor(kind: PickupKind) {
    super();
    const gfx = new Graphics();
    if (kind === 'health') {
      const color = CONFIG.colors.pickupHealth;
      // A small plus sign reads as "heal" without art.
      gfx.roundRect(-3, -9, 6, 18, 2).fill({ color });
      gfx.roundRect(-9, -3, 18, 6, 2).fill({ color });
    } else if (kind === 'affix') {
      // A faceted gem — the run's power drop.
      const color = CONFIG.colors.pickupAffix;
      gfx.poly([0, -10, 8, -2, 5, 9, -5, 9, -8, -2]).fill({ color });
      gfx.poly([0, -10, 5, 9, -5, 9]).fill({ color: 0xfaf5ff, alpha: 0.35 });
    } else if (kind === 'weapon') {
      // A double chevron — "gear / new weapon".
      const color = CONFIG.colors.pickupWeapon;
      gfx.poly([-8, -7, 0, -1, -8, 5, -5, -1]).fill({ color });
      gfx.poly([0, -7, 8, -1, 0, 5, 3, -1]).fill({ color });
    } else {
      const color = CONFIG.colors.pickupCoin;
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
