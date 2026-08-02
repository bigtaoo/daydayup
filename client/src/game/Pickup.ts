import { Graphics } from 'pixi.js';
import { CONFIG } from './config';
import { Entity } from './Entity';
import type { PickupKind } from '@dd/engine';

export type { PickupKind };

// Glow tint per kind — same colour as the shape itself (CONFIG.colors.pickup*), just
// softened/additive, so the glow reads as "this shape, glowing" rather than a mismatched
// halo.
const PICKUP_GLOW: Record<PickupKind, number> = {
  heal: CONFIG.colors.pickupHeal,
  weapon: CONFIG.colors.pickupWeapon,
  buff: CONFIG.colors.pickupBuff,
  crate: CONFIG.colors.pickupCrate,
  material: CONFIG.colors.pickupMaterial,
  bandage: CONFIG.colors.pickupHeal, // no dedicated bandage art yet — falls into the same crystal fallback shape below as 'material'
};

// Pickup view — an in-run drop (health / coin / weapon). Pure presentation:
// the engine owns the drop roll and collection; the hover bob here is render-only
// eye candy (it is NOT part of the sim, which is why PickupItem has no z). Position
// lerps like any other view; z is the local bob. Each kind gets a distinct silhouette
// so a player reads "new gun" (chevron) vs "heal" (plus) at a glance.
export class Pickup extends Entity {
  private bob = 0;
  readonly kind: PickupKind;

  constructor(kind: PickupKind) {
    super();
    this.kind = kind;
    // A soft additive glow behind the shape (design/10 legibility fix, 2026-08-02): a
    // flat-filled ~14px silhouette reads as a plain dot against a dark/busy floor —
    // the glow gives every pickup a bit of "pop" at a glance without new art. A
    // separate Graphics (not the crisp shape below) so only the glow itself blends
    // additively — the shape on top stays a normal, non-washed-out fill.
    const glow = new Graphics();
    glow.circle(0, 0, 13).fill({ color: PICKUP_GLOW[kind], alpha: 0.28 });
    glow.blendMode = 'add';
    this.addChild(glow);

    const gfx = new Graphics();
    if (kind === 'heal') {
      const color = CONFIG.colors.pickupHeal;
      // A small plus sign reads as "heal" without art.
      gfx.roundRect(-3, -9, 6, 18, 2).fill({ color });
      gfx.roundRect(-9, -3, 18, 6, 2).fill({ color });
    } else if (kind === 'weapon') {
      // A double chevron — "gear / new weapon".
      const color = CONFIG.colors.pickupWeapon;
      gfx.poly([-8, -7, 0, -1, -8, 5, -5, -1]).fill({ color });
      gfx.poly([0, -7, 8, -1, 0, 5, 3, -1]).fill({ color });
    } else if (kind === 'buff') {
      // An upward chevron in a diamond — "power up / run buff" (design/14).
      const color = CONFIG.colors.pickupBuff;
      gfx.poly([0, -9, 9, 0, 0, 9, -9, 0]).fill({ color, alpha: 0.35 });
      gfx.poly([-6, 3, 0, -6, 6, 3, 0, 0]).fill({ color });
    } else if (kind === 'crate') {
      // A plain square outline — "unknown," contents unresolved (design/15 anti-cheat
      // loot reveal). Flips to one of the shapes above the instant it resolves.
      const color = CONFIG.colors.pickupCrate;
      gfx.rect(-7, -7, 14, 14).stroke({ color, width: 2 });
    } else {
      // material — a small crystal (the run's carry-out currency, design/14)
      const color = CONFIG.colors.pickupMaterial;
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
