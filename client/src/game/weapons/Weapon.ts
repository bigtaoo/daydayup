import { Container } from 'pixi.js';
import type { Actor } from '../Actor';

// Weapon context: callbacks a weapon uses to produce world effects (spawn bullets, play fx).
export interface WeaponContext {
  spawnBullet(gx: number, gy: number, dirX: number, dirY: number, faction: 'player' | 'enemy'): void;
  flash(gx: number, gy: number, color: number, radius: number): void;
}

// Block-arc description (melee).
export interface BlockArc {
  active: boolean;
  half: number; // half-angle (radians)
  range: number;
}

// Abstract weapon base (see design/02, 03). Weapons are first-class and carry gameplay.
export abstract class Weapon {
  abstract readonly name: string;
  abstract readonly kind: 'ranged' | 'melee';
  readonly view = new Container();

  protected owner: Actor | null = null;
  protected cooldown = 0;

  onEquip(owner: Actor) {
    this.owner = owner;
    this.view.visible = true;
  }
  onUnequip() {
    this.view.visible = false;
  }

  // Each frame: place the weapon at the hand anchor and facing, and switch local z by facing
  // (see the local z-order section in design/01).
  update(dt: number) {
    if (!this.owner) return;
    if (this.cooldown > 0) this.cooldown -= dt;

    const hand = this.owner.skin.handAnchor();
    this.view.x = hand.x;
    this.view.y = hand.y;
    this.view.rotation = this.owner.facing;

    // Facing up → weapon behind the body; otherwise in front
    const facingUp = Math.sin(this.owner.facing) < -0.35;
    this.view.zIndex = facingUp ? -1 : 1;

    this.onUpdate(dt);
  }

  protected onUpdate(_dt: number) {}

  // Fire / use. firing = whether the attack key is currently held.
  abstract use(ctx: WeaponContext, firing: boolean): void;

  // Blocking state (overridden by melee).
  setBlocking(_on: boolean) {}
  blockArc(): BlockArc {
    return { active: false, half: 0, range: 0 };
  }
}
