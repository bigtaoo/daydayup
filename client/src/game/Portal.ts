import { Graphics } from 'pixi.js';
import { CONFIG } from './config';
import { Entity } from './Entity';

/**
 * The extraction-checkpoint portal (design/10 legibility fix, 2026-08-02) — replaces
 * the old "HOLD [E] to EXTRACT / TAP [E] to DESCEND" text prompt with an actual
 * world-space object the player walks up to (PortalPrompt shows the exit/continue
 * popup once they're close enough). No art asset exists for this yet, so — same
 * convention as Pickup.ts's shape-only kinds — it's a stylized glowing gate drawn with
 * Pixi `Graphics`: a ring + an inner shimmer, reusing `CONFIG.colors.extractGlow`
 * (already the extraction checkpoint's own tint). Built once per room (RoomBuilder),
 * visibility toggled by `setOpen()` — hidden until the room's waves are exhausted
 * (design/05 "the portal opens only after the boss dies", generalized to every
 * checkpoint room, not just the final boss one).
 */
export class Portal extends Entity {
  private t = 0; // pulse clock (render-only, ms)

  constructor(radiusPx = 26) {
    super();
    const color = CONFIG.colors.extractGlow;

    const glow = new Graphics();
    glow.ellipse(0, 0, radiusPx * 1.6, radiusPx * 1.9).fill({ color, alpha: 0.18 });
    glow.blendMode = 'add';
    this.addChild(glow);

    const ring = new Graphics();
    ring.ellipse(0, -radiusPx * 0.9, radiusPx, radiusPx * 1.1).stroke({ color, width: 4, alpha: 0.85 });
    ring.ellipse(0, -radiusPx * 0.9, radiusPx * 0.7, radiusPx * 0.8).fill({ color, alpha: 0.22 });
    this.addChild(ring);

    this.makeShadow(radiusPx * 0.9);
    this.visible = false;
  }

  setOpen(open: boolean): void {
    this.visible = open;
  }

  override interpolate(alpha: number, frameDt: number): void {
    super.interpolate(alpha, frameDt);
    this.t += frameDt;
    this.alpha = 0.85 + 0.15 * Math.sin(this.t * 0.003);
  }
}
