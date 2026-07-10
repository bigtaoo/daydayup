import { Graphics } from 'pixi.js';
import { CONFIG } from './config';
import { Entity } from './Entity';
import { Skin } from './Skin';

export type Faction = 'player' | 'enemy';
export type WeaponKind = 'ranged' | 'melee';

// How far (× body radius) to lift the sprite so the ground anchor sits at the feet.
// Bigger → more of the body rises above the anchor → more it can overlap a pillar.
const BODY_LIFT_R = 0.7;

// Actor view (player / enemy). Pure presentation: body skin, a soft shadow, and a
// cosmetic weapon graphic that swaps shape by the engine weapon's kind (Stage D:
// no weapon logic lives here — the engine owns firing, cooldowns, and the loadout).
export class Actor extends Entity {
  private skin: Skin;
  private weaponGfx = new Graphics();
  private weaponKind: WeaponKind | null | undefined = undefined;
  private radiusPx: number;

  constructor(faction: Faction, radiusPx: number, tint?: number) {
    super();
    this.radiusPx = radiusPx;
    // The actor container sorts children so the weapon can sit in front of / behind.
    this.sortableChildren = true;

    const [body, front] =
      faction === 'player'
        ? [CONFIG.colors.player, CONFIG.colors.playerFront]
        : [CONFIG.colors.enemy, 0xffd6d6];
    // An enemy blueprint tint (elemental variant) overrides the default body colour.
    this.skin = new Skin(tint ?? body, front, radiusPx);
    this.addChild(this.skin.view);

    this.weaponGfx.zIndex = 1;
    this.addChild(this.weaponGfx);
    this.makeShadow(radiusPx * 0.7);

    // Lift the body + weapon so the container origin (gx,gy — where the shadow and
    // the engine's collision footprint sit) lands near the feet rather than the
    // torso. The sprite then rises above the ground point, so via Y-sort it draws
    // over a pillar it stands against (design/01 fake-3D depth).
    const lift = radiusPx * BODY_LIFT_R;
    this.skin.view.y = -lift;
    this.weaponGfx.y = -lift;
  }

  // Swap the cosmetic weapon shape to match the engine's active weapon kind.
  setWeaponKind(kind: WeaponKind | null): void {
    if (kind === this.weaponKind) return;
    this.weaponKind = kind;
    this.drawWeapon(kind);
  }

  private drawWeapon(kind: WeaponKind | null): void {
    const g = this.weaponGfx;
    g.clear();
    const r = this.radiusPx;
    if (kind === 'ranged') {
      g.rect(r * 0.5, -2.5, r * 0.8, 5).fill({ color: CONFIG.colors.gun }); // barrel
    } else if (kind === 'melee') {
      g.moveTo(r * 0.3, 0)
        .lineTo(r * 1.5, 0)
        .stroke({ color: CONFIG.colors.sword, width: 3 }); // blade
    }
  }

  override interpolate(alpha: number, frameDt: number): void {
    super.interpolate(alpha, frameDt);
    this.skin.setFacing(this.facingRad);
    this.weaponGfx.rotation = this.facingRad;
  }
}
