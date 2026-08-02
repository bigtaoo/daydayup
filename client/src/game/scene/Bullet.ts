import { Graphics } from 'pixi.js';
import type { DamageType } from '@dd/engine';
import { THEME, ELEMENT_COLORS } from '../theme';
import { Entity } from './Entity';
import type { Faction } from './Actor';

// Bullet view. Pure presentation: a coloured dot with a shadow, positioned by the
// engine each tick. The engine may flip a bullet's faction (melee deflect: enemy →
// player); the view re-reads faction each reconcile and recolours to match.
//
// Per-element polish (design/03/07): an elemental bullet is drawn in its element
// hue with a soft additive glow halo, so a fire/ice/lightning/poison shot reads at a
// glance — distinct from a plain (faction-coloured) physical round. The world-space
// motion trail is spawned by Game (fx layer), keyed off the same element colour.
export class Bullet extends Entity {
  private glow = new Graphics(); // additive halo, behind the core (elemental only)
  private gfx = new Graphics();
  private radiusPx: number;
  private faction: Faction | null = null;
  private damageType: DamageType = 'physical';

  constructor(radiusPx: number) {
    super();
    this.radiusPx = radiusPx;
    this.glow.blendMode = 'add';
    this.addChild(this.glow, this.gfx);
    this.makeShadow(radiusPx * 0.8);
  }

  setFaction(faction: Faction): void {
    if (faction === this.faction) return;
    this.faction = faction;
    this.redraw();
  }

  setElement(type: DamageType): void {
    if (type === this.damageType) return;
    this.damageType = type;
    this.redraw();
  }

  /** The bullet's fx colour: its element hue, or the faction colour if physical. */
  get color(): number {
    return (
      ELEMENT_COLORS[this.damageType] ??
      (this.faction === 'enemy' ? THEME.colors.bulletEnemy : THEME.colors.bulletPlayer)
    );
  }

  private redraw(): void {
    const color = this.color;
    const r = this.radiusPx;
    this.gfx.clear();
    this.gfx.circle(0, 0, r).fill({ color });

    // Elemental rounds get a halo; physical rounds stay a clean dot.
    this.glow.clear();
    if (ELEMENT_COLORS[this.damageType] !== undefined) {
      for (let i = 3; i >= 1; i--) {
        this.glow.circle(0, 0, r * (1 + i * 0.5)).fill({ color, alpha: 0.12 });
      }
    }
  }
}
