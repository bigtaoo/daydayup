import { Graphics, Sprite } from 'pixi.js';
import { WEAPON_SIM_BY_ID } from '@dd/engine';
import { THEME } from '../theme';
import { getWeaponTexture } from '../../render/weaponSkins';
import { Entity } from './Entity';
import type { PickupKind } from '@dd/engine';

export type { PickupKind };

// Glow tint per kind — same colour as the shape itself (THEME.colors.pickup*), just
// softened/additive, so the glow reads as "this shape, glowing" rather than a mismatched
// halo.
const PICKUP_GLOW: Record<PickupKind, number> = {
  heal: THEME.colors.pickupHeal,
  weapon: THEME.colors.pickupWeapon,
  buff: THEME.colors.pickupBuff,
  crate: THEME.colors.pickupCrate,
  material: THEME.colors.pickupMaterial,
  bandage: THEME.colors.pickupHeal, // no dedicated bandage art yet — falls into the same crystal fallback shape below as 'material'
};

// Ambient hover, deliberately in the same band as the scene's other idle loops —
// Portal's alpha pulse (0.003 rad/ms) and Actor's status aura (0.008). The original
// 0.12 rad/ms was ~19 Hz, i.e. 2.0 rad of phase per 60fps frame: close enough to the
// Nyquist limit (π) that the "bob" aliased into a strobe whose apparent rate changed
// with the display's refresh rate instead of reading as a float.
const BOB_PERIOD_MS = 2000; // one unhurried hover cycle every 2s (0.5 Hz)
const BOB_RATE = (Math.PI * 2) / BOB_PERIOD_MS; // rad/ms
const BOB_REST_Z = 9; // hover height the bob oscillates around (px)
const BOB_AMPLITUDE = 4; // px either side of rest — bigger than before; slow travel needs the reach to read

// Golden angle: spacing successive drops' start phase by it keeps a whole floor's worth
// of loot from bobbing in lockstep (which is what made the field read as one flicker),
// with no Math.random — same determinism rule the rest of this render layer follows.
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

// The glow's fill alpha is the value at the TOP of the hover; the breathe below only ever
// scales it DOWN (Pixi clamps alpha at 1, so modulating above the fill would silently
// flatten the bright half of the cycle into a plateau).
const GLOW_ALPHA_PEAK = 0.34;
const GLOW_BREATHE = 0.36; // how much dimmer the bottom of the arc is, as a fraction of peak

// Pickup view — an in-run drop (health / coin / weapon). Pure presentation:
// the engine owns the drop roll and collection; the hover bob here is render-only
// eye candy (it is NOT part of the sim, which is why PickupItem has no z). Position
// lerps like any other view; z is the local bob. Each kind gets a distinct silhouette
// so a player reads "new gun" (chevron) vs "heal" (plus) at a glance.
export class Pickup extends Entity {
  private bob: number;
  private readonly glow: Graphics;
  readonly kind: PickupKind;

  /** `id` is the engine entity id, used only to spread the hover's start phase (see
   *  GOLDEN_ANGLE) — the view stays a pure function of it, so two clients drawing the
   *  same drop still agree frame-for-frame. Defaults to an in-phase 0 for callers that
   *  don't care (tests, one-off previews). */
  constructor(kind: PickupKind, weaponId?: string, id = 0) {
    super();
    this.kind = kind;
    this.bob = id * GOLDEN_ANGLE;
    // A soft additive glow behind the shape (design/10 legibility fix, 2026-08-02): a
    // flat-filled ~14px silhouette reads as a plain dot against a dark/busy floor —
    // the glow gives every pickup a bit of "pop" at a glance without new art. A
    // separate Graphics (not the crisp shape below) so only the glow itself blends
    // additively — the shape on top stays a normal, non-washed-out fill.
    const glow = new Graphics();
    glow.circle(0, 0, 13).fill({ color: PICKUP_GLOW[kind], alpha: GLOW_ALPHA_PEAK });
    glow.blendMode = 'add';
    this.addChild(glow);
    this.glow = glow;

    const gfx = new Graphics();
    if (kind === 'heal') {
      const color = THEME.colors.pickupHeal;
      // A small plus sign reads as "heal" without art.
      gfx.roundRect(-3, -9, 6, 18, 2).fill({ color });
      gfx.roundRect(-9, -3, 18, 6, 2).fill({ color });
    } else if (kind === 'weapon') {
      // The weapon's own real business-end art (same texture WeaponCard/Forge mount,
      // render/weaponSkins.ts) — reads as "that specific gun/blade", not just "a new
      // weapon". Falls back to the old double-chevron ("gear / new weapon") when the
      // texture isn't resolvable (unknown id / not yet loaded) — a ground item, unlike
      // WeaponCard's chip, has no adjacent name text to fall back on, so it must always
      // draw *something*.
      const simKind = weaponId ? WEAPON_SIM_BY_ID[weaponId]?.kind : undefined;
      const texture = getWeaponTexture(weaponId, simKind ?? 'ranged');
      if (texture) {
        const icon = new Sprite(texture);
        icon.anchor.set(0.5);
        const box = 22;
        icon.scale.set(Math.min(box / texture.width, box / texture.height));
        this.addChild(icon);
      } else {
        const color = THEME.colors.pickupWeapon;
        gfx.poly([-8, -7, 0, -1, -8, 5, -5, -1]).fill({ color });
        gfx.poly([0, -7, 8, -1, 0, 5, 3, -1]).fill({ color });
      }
    } else if (kind === 'buff') {
      // An upward chevron in a diamond — "power up / run buff" (design/14).
      const color = THEME.colors.pickupBuff;
      gfx.poly([0, -9, 9, 0, 0, 9, -9, 0]).fill({ color, alpha: 0.35 });
      gfx.poly([-6, 3, 0, -6, 6, 3, 0, 0]).fill({ color });
    } else if (kind === 'crate') {
      // A plain square outline — "unknown," contents unresolved (design/15 anti-cheat
      // loot reveal). Flips to one of the shapes above the instant it resolves.
      const color = THEME.colors.pickupCrate;
      gfx.rect(-7, -7, 14, 14).stroke({ color, width: 2 });
    } else {
      // material — a small crystal (the run's carry-out currency, design/14)
      const color = THEME.colors.pickupMaterial;
      gfx.circle(0, 0, 7).fill({ color });
      gfx.circle(0, 0, 3.5).fill({ color: 0xfffbe6, alpha: 0.7 });
    }
    this.addChild(gfx);
    this.makeShadow(9);
  }

  override interpolate(alpha: number, frameDt: number): void {
    this.bob += frameDt * BOB_RATE;
    const swing = Math.sin(this.bob);
    // The glow breathes with the hover rather than on its own clock: one slow cue
    // instead of two competing ones, and it keeps the drop's "pop" now that the motion
    // alone is too gentle to catch the eye. Scaling the Graphics' alpha (not refilling
    // it) keeps this a per-frame property write, no geometry rebuild.
    this.glow.alpha = 1 - (GLOW_BREATHE * (1 - swing)) / 2;
    const z = BOB_REST_Z + swing * BOB_AMPLITUDE;
    this.applyTransform(
      this.prevX + (this.curX - this.prevX) * alpha,
      this.prevY + (this.curY - this.prevY) * alpha,
      z,
    );
  }
}
