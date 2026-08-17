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
// How long a bullet takes to ease from its shooter's drawn muzzle onto its true sim
// line (setMuzzleOrigin). ~3.6 sim ticks — long enough that the correction is a smooth
// departure rather than a one-frame jump, short enough that it is all spent within the
// first ~40 world px of flight, well before the bullet is anywhere near a target.
const MUZZLE_EASE_MS = 120;

export class Bullet extends Entity {
  private glow = new Graphics(); // additive halo, behind the core (elemental only)
  private gfx = new Graphics();
  private radiusPx: number;
  private faction: Faction | null = null;
  private damageType: DamageType = 'physical';
  private originDx = 0; // muzzle-origin correction (see setMuzzleOrigin)
  private originDy = 0;
  private originMs = 0; // remaining ease time; 0 = drawn exactly at the sim position

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

  /**
   * Draw this bullet leaving the shooter's actual barrel tip (`Scene` supplies the
   * offset from the engine's spawn point to the drawn muzzle) and ease onto the
   * authoritative sim line over `MUZZLE_EASE_MS`. Render-only, applied on top of the
   * interpolated sim position — nothing here is ever read back into the sim.
   *
   * A decaying offset rather than just a different starting point, because the two
   * lines are PARALLEL, not merely offset at their origins: the sim places its muzzle
   * `muzzleOffset` along the aim ray on the GROUND plane and then lifts it by `bulletZ`,
   * while the rig rotates the gun in screen space at the socket bone's own height. Aim
   * downward and the sim's spawn slides "south" across the floor while the drawn barrel
   * swings down the screen — so a bullet that merely STARTED at the muzzle would still
   * fly along a visibly separate line below it (~16 world px, and this camera zooms 4x).
   * Easing the offset out instead lets the shot leave the barrel and rejoin its true
   * path within the first ~40 px of flight, by which point the gap is invisible.
   *
   * The shadow is deliberately left on the un-offset ground point: it marks where the
   * bullet actually is in the world, which is the sim position, not the drawn one.
   */
  setMuzzleOrigin(dx: number, dy: number): void {
    this.originDx = dx;
    this.originDy = dy;
    this.originMs = MUZZLE_EASE_MS;
  }

  override interpolate(alpha: number, frameDt: number): void {
    super.interpolate(alpha, frameDt);
    if (this.originMs <= 0) return;
    this.originMs = Math.max(0, this.originMs - frameDt);
    const k = this.originMs / MUZZLE_EASE_MS;
    const ease = k * k; // ease-out: most of the correction is spent in the first frames
    this.x += this.originDx * ease;
    this.y += this.originDy * ease;
  }
}
