import { CONFIG } from './config';
import { Entity } from './Entity';
import { Skin } from './Skin';
import type { Weapon } from './weapons/Weapon';

export type Faction = 'player' | 'enemy';

// Logical entity. Gameplay stats live here and on Weapon, not on Skin (character = skin, see design/02).
export class Actor extends Entity {
  vz = 0; // jump / gravity velocity
  facing = 0; // radians
  hp: number;
  maxHp: number;
  faction: Faction;
  radius: number;

  skin: Skin;
  weapon: Weapon | null = null;

  constructor(faction: Faction, skin: Skin, radius: number, maxHp: number) {
    super();
    this.faction = faction;
    this.skin = skin;
    this.radius = radius;
    this.maxHp = maxHp;
    this.hp = maxHp;

    // The actor container also sorts by zIndex to support the weapon's local front/back switch
    this.sortableChildren = true;
    this.addChild(skin.view);
    this.makeShadow(radius);
  }

  equip(weapon: Weapon) {
    if (this.weapon) {
      this.weapon.onUnequip();
      this.removeChild(this.weapon.view);
    }
    this.weapon = weapon;
    weapon.onEquip(this);
    this.addChild(weapon.view);
  }

  // Jump (demonstrates height/shadow separation)
  jump() {
    if (this.z <= 0.01) this.vz = CONFIG.jumpVelocity;
  }

  updatePhysics(dt: number) {
    if (this.z > 0 || this.vz > 0) {
      this.vz -= CONFIG.gravity * dt;
      this.z += this.vz * dt;
      if (this.z < 0) {
        this.z = 0;
        this.vz = 0;
      }
    }
    this.skin.setFacing(this.facing);
  }

  takeDamage(n: number) {
    this.hp = Math.max(0, this.hp - n);
    if (this.hp <= 0) this.alive = false;
  }
}
