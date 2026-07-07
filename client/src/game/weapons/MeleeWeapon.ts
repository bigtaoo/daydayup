import { Graphics } from 'pixi.js';
import { CONFIG } from '../config';
import { Weapon, type WeaponContext, type BlockArc } from './Weapon';

export interface MeleeSpec {
  swingRate: number;
  damage: number;
  arc: number; // swing angle
  range: number;
  blockHalf: number; // block half-angle
  blockRange: number;
}

// Melee weapon. Core ability: block/deflect bullets (see design/03).
export class MeleeWeapon extends Weapon {
  readonly name = 'Saber';
  readonly kind = 'melee' as const;
  private spec: MeleeSpec;
  private blade: Graphics;
  private swingT = 0; // swing animation timer
  private blocking = false;
  private blockShield: Graphics;

  constructor(spec: MeleeSpec = {
    swingRate: 22, damage: 2, arc: Math.PI * 0.9, range: 46,
    blockHalf: Math.PI * 0.42, blockRange: 54,
  }) {
    super();
    this.spec = spec;

    this.blade = new Graphics();
    this.blade.roundRect(8, -3, 40, 6, 3).fill({ color: CONFIG.colors.sword });
    this.blade.roundRect(4, -7, 8, 14, 2).fill({ color: 0x718096 });

    // Block shield arc shown while blocking (fx look, additive blend)
    this.blockShield = new Graphics();
    this.blockShield.moveTo(0, 0)
      .arc(0, 0, this.spec.blockRange, -this.spec.blockHalf, this.spec.blockHalf)
      .closePath()
      .fill({ color: CONFIG.colors.blockArc, alpha: 0.18 });
    this.blockShield.blendMode = 'add';
    this.blockShield.visible = false;

    this.view.addChild(this.blockShield, this.blade);
  }

  protected onUpdate(dt: number): void {
    // Swing recoil animation: the blade swings around the hand
    if (this.swingT > 0) {
      this.swingT -= dt;
      const p = Math.max(0, this.swingT) / this.spec.swingRate;
      this.blade.rotation = -this.spec.arc * 0.5 + this.spec.arc * (1 - p);
    } else {
      this.blade.rotation = 0;
    }
    this.blockShield.visible = this.blocking;
  }

  use(ctx: WeaponContext, firing: boolean): void {
    if (!firing || !this.owner || this.cooldown > 0) return;
    this.cooldown = this.spec.swingRate;
    this.swingT = this.spec.swingRate;
    // The melee hit test is resolved by Game (it needs the enemy list); here we only play fx
    const a = this.owner.facing;
    ctx.flash(this.owner.gx + Math.cos(a) * this.spec.range, this.owner.gy + Math.sin(a) * this.spec.range,
      CONFIG.colors.swordGlow, 20);
  }

  setBlocking(on: boolean): void {
    this.blocking = on;
  }

  blockArc(): BlockArc {
    return { active: this.blocking, half: this.spec.blockHalf, range: this.spec.blockRange };
  }

  get meleeArc(): number { return this.spec.arc; }
  get meleeRange(): number { return this.spec.range; }
  get meleeDamage(): number { return this.spec.damage; }
  get isSwinging(): boolean { return this.swingT > 0; }
}
