import { Container, Graphics, Sprite } from 'pixi.js';
import type { WeaponSimSpec } from '@dd/engine';
import { getWeaponTexture } from '../../render/weaponSkins';
import { rarityColor } from '../theme';

/**
 * The OTHER carried weapon slot (design/10 HUD follow-up, user report 2026-08-12:
 * "show my other weapon next to the active one, let me tap it to switch") — a small
 * tappable icon chip meant to sit immediately right of the active `WeaponCard`. Pure
 * presentation, same "icon on a rarity-bordered chip" look as `WeaponCard`'s own icon,
 * just dimmer (`alpha` on fill/stroke) so it reads as "idle" next to the active card.
 *
 * Tapping it doesn't target a slot directly — a player carries at most two weapons
 * (`PlayerActor.weapons`, engine/state/entities.ts), so "tap the other weapon" and
 * "cycle the active slot" (`ApplyInputSystem.swap`) are the same action. `onTap` is
 * wired by the caller straight to the same `CommandBuilder.requestSwap()` the keyboard
 * (1/2) and touch corner buttons already use.
 */
export class WeaponSlotChip {
  readonly view = new Container();
  static readonly SIZE = 34;

  private readonly chip = new Graphics();
  private icon: Sprite | null = null;
  private lastKey = '';
  onTap: (() => void) | null = null;

  constructor() {
    this.view.addChild(this.chip);
    this.view.eventMode = 'static';
    this.view.cursor = 'pointer';
    this.view.on('pointertap', () => this.onTap?.());
    // Same double-fire guard Button uses (widgets.ts) — harmless here since nothing
    // else currently sits under the HUD panel, but keeps the convention consistent.
    this.view.on('pointerdown', (e) => e.stopPropagation());
  }

  /** `spec` is the OTHER slot's weapon — null while the loadout has fewer than two
   *  weapons, in which case the caller hides `view` entirely (same convention as
   *  AllyRow/DownedBanner: an inapplicable widget is hidden, not drawn empty). */
  set(spec: WeaponSimSpec | null): void {
    const key = spec ? `${spec.name}|${spec.rarity}|${spec.kind}` : 'empty';
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.redraw(spec);
  }

  private redraw(spec: WeaponSimSpec | null): void {
    const box = WeaponSlotChip.SIZE;
    const border = spec ? rarityColor(spec) : 0x4c566a;
    this.chip
      .clear()
      .roundRect(0, 0, box, box, 7)
      .fill({ color: 0x18202f, alpha: 0.55 })
      .roundRect(0.5, 0.5, box - 1, box - 1, 7)
      .stroke({ color: border, alpha: 0.5, width: 1.5 });

    const texture = spec ? getWeaponTexture(spec.name, spec.kind) : undefined;
    if (!texture) {
      this.icon?.destroy();
      this.icon = null;
      return;
    }
    if (!this.icon) {
      this.icon = new Sprite();
      this.icon.anchor.set(0.5);
      this.icon.alpha = 0.75; // dimmer than the active card's icon — reads as "idle"
      this.view.addChildAt(this.icon, 1);
    }
    this.icon.texture = texture;
    const inner = box - 8;
    this.icon.scale.set(Math.min(inner / texture.width, inner / texture.height));
    this.icon.position.set(box / 2, box / 2);
  }
}
