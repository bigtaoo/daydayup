import { Graphics } from 'pixi.js';
import type { StatusState } from '@dd/engine';
import { CONFIG } from './config';
import { Entity } from './Entity';
import { Skin } from './Skin';

export type Faction = 'player' | 'enemy';
export type WeaponKind = 'ranged' | 'melee';

// How far (× body radius) to lift the sprite so the ground anchor sits at the feet.
// Bigger → more of the body rises above the anchor → more it can overlap a pillar.
const BODY_LIFT_R = 0.7;

// Lingering status auras (design/03/07): a concentric glowing ring per active
// on-hit effect, so a burning / chilled / poisoned actor reads while the DoT lasts —
// not just a one-frame flash on the hit. Lightning has no lingering status (the
// chain is instant), so it deliberately has no aura. Bit index = ring order.
const AURAS: ReadonlyArray<{ bit: number; color: number; active: (s: StatusState) => boolean }> = [
  { bit: 1, color: CONFIG.colors.statusBurn, active: (s) => s.burnTicks > 0 },
  { bit: 2, color: CONFIG.colors.statusChill, active: (s) => s.chillTicks > 0 },
  { bit: 4, color: CONFIG.colors.statusPoison, active: (s) => s.poison.length > 0 },
];

// Actor view (player / enemy). Pure presentation: body skin, a soft shadow, and a
// cosmetic weapon graphic that swaps shape by the engine weapon's kind (Stage D:
// no weapon logic lives here — the engine owns firing, cooldowns, and the loadout).
export class Actor extends Entity {
  private skin: Skin;
  private weaponGfx = new Graphics();
  private statusAura = new Graphics(); // lingering elemental aura, behind the body
  private auraMask = 0; // bitmask of the effects currently drawn (skip redraw if same)
  private auraT = 0; // aura pulse clock (render-only, ms)
  private healthBar: Graphics | null = null; // boss only; null for regular mobs
  private hpRatio = -1; // last-drawn hp fraction (skip redraw if unchanged)
  private weaponKind: WeaponKind | null | undefined = undefined;
  private radiusPx: number;

  constructor(faction: Faction, radiusPx: number, tint?: number, boss = false) {
    super();
    this.radiusPx = radiusPx;
    // The actor container sorts children so the weapon can sit in front of / behind.
    this.sortableChildren = true;

    // Aura sits behind everything (zIndex -1) and glows additively.
    this.statusAura.zIndex = -1;
    this.statusAura.blendMode = 'add';
    this.addChild(this.statusAura);

    const [body, front] =
      faction === 'player'
        ? [CONFIG.colors.player, CONFIG.colors.playerFront]
        : [CONFIG.colors.enemy, 0xffd6d6];
    // An enemy blueprint tint (elemental variant) overrides the default body colour.
    // Only the player has a real preloaded rig skin today (art/units' orb-core,
    // design/12); enemies fall back to the Graphics placeholder until a rigged
    // critter skin exists (still-open item, see design/12's "further boss atlas
    // art remain real-art-production work").
    this.skin = new Skin(tint ?? body, front, radiusPx, faction === 'player' ? 'orb-core' : undefined);
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
    this.statusAura.y = -lift;

    // A boss carries a floating health bar above its head so the poison melt reads.
    if (boss) {
      this.healthBar = new Graphics();
      this.healthBar.y = -lift - radiusPx * 1.7;
      this.addChild(this.healthBar);
    }
  }

  // Swap the cosmetic weapon shape to match the engine's active weapon kind.
  setWeaponKind(kind: WeaponKind | null): void {
    if (kind === this.weaponKind) return;
    this.weaponKind = kind;
    this.drawWeapon(kind);
  }

  // Update the boss health bar from the engine actor's hp (no-op for non-bosses).
  // Colour ramps green → amber → red as it drains; redraws only when the fraction
  // changes, so a boss sitting at full hp costs nothing per tick.
  setHealth(hp: number, maxHp: number): void {
    if (!this.healthBar || maxHp <= 0) return;
    const ratio = Math.max(0, Math.min(1, hp / maxHp));
    if (ratio === this.hpRatio) return;
    this.hpRatio = ratio;

    const w = this.radiusPx * 2.2;
    const h = 6;
    const g = this.healthBar;
    g.clear();
    g.roundRect(-w / 2, -h / 2, w, h, 2).fill({ color: 0x1a1d26, alpha: 0.85 });
    if (ratio > 0) {
      const color = ratio > 0.5 ? 0x66bb6a : ratio > 0.25 ? 0xffca28 : 0xef5350;
      g.roundRect(-w / 2, -h / 2, w * ratio, h, 2).fill({ color });
    }
    g.roundRect(-w / 2, -h / 2, w, h, 2).stroke({ color: 0x0c0e14, width: 1, alpha: 0.9 });
  }

  // Mirror the engine actor's lingering status (design/03/07). Draws one glowing
  // ring per active effect; redraws only when the active set changes (the pulse is
  // an alpha animation in interpolate, so a steady burn doesn't rebuild geometry).
  setStatus(status: StatusState): void {
    let mask = 0;
    for (const a of AURAS) if (a.active(status)) mask |= a.bit;
    if (mask === this.auraMask) return;
    this.auraMask = mask;

    const g = this.statusAura;
    g.clear();
    if (mask === 0) return;
    const r = this.radiusPx;
    let ring = 0;
    for (const a of AURAS) {
      if (!(mask & a.bit)) continue;
      const rad = r * (1.15 + ring * 0.22);
      g.circle(0, 0, rad).stroke({ color: a.color, width: 3, alpha: 0.55 });
      ring++;
    }
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
    // Cheap idle/move clip pick straight from Entity's own interpolation buffers —
    // attack/hurt/death need real GameState signals Actor doesn't receive yet.
    const moving = Math.hypot(this.curX - this.prevX, this.curY - this.prevY) > 0.01;
    this.skin.setFacing(this.facingRad, frameDt, moving ? 'move' : 'idle');
    this.weaponGfx.rotation = this.facingRad;
    // Gentle breathing pulse so an active aura reads as a live effect, not an outline.
    if (this.auraMask !== 0) {
      this.auraT += frameDt;
      this.statusAura.alpha = 0.75 + 0.25 * Math.sin(this.auraT * 0.008);
    }
  }
}
