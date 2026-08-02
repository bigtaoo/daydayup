import { Container, Graphics, Sprite, Text } from 'pixi.js';
import type { DamageType, RarityTier, WeaponSimSpec } from '@dd/engine';
import { getWeaponTexture } from '../../render/weaponSkins';
import { elementColor, rarityColor } from '../theme';
import { Bar } from './widgets';
import { estimateMonoWidth } from './textWidth';
import { getLocale, t, type TranslationKey } from '../../i18n';

// Explicit key maps rather than a `hud.rarity.${tier}` template cast: the whole point of
// `TranslationKey` being a compile-time union (design/17-i18n) is that a renamed or
// missing key is a build error, and a template literal cast throws that away. `satisfies`
// also makes a new engine-side rarity tier / damage type fail the build here until it has
// a HUD label, instead of silently rendering the raw key at runtime.
const RARITY_KEY = {
  common: 'hud.rarity.common',
  fine: 'hud.rarity.fine',
  epic: 'hud.rarity.epic',
  legend: 'hud.rarity.legend',
  legendary: 'hud.rarity.legendary',
} as const satisfies Record<RarityTier, TranslationKey>;

const KIND_KEY = {
  ranged: 'hud.kind.ranged',
  melee: 'hud.kind.melee',
} as const satisfies Record<WeaponSimSpec['kind'], TranslationKey>;

const ELEMENT_KEY = {
  physical: 'hud.element.physical',
  fire: 'hud.element.fire',
  ice: 'hud.element.ice',
  lightning: 'hud.element.lightning',
  poison: 'hud.element.poison',
} as const satisfies Record<DamageType, TranslationKey>;

/**
 * The equipped weapon, as an item card (design/10 HUD, design/14's border-not-hue
 * rarity convention): the weapon's own business-end art on a rarity-bordered chip, its
 * name, a rarity/kind/element subtitle, an element-tinted damage badge, and the
 * cooldown sweep. This is the same art the in-world rig mounts (`render/weaponSkins`)
 * and the same art the Forge rows use, so "the thing in my hand" and "the thing in my
 * HUD" are visibly the same object — which a line of text never established.
 *
 * Pure presentation: it reads a `WeaponSimSpec` plus already-computed cooldown ticks;
 * it never touches engine state itself.
 */
export class WeaponCard {
  readonly view = new Container();
  static readonly HEIGHT = 38;
  private static readonly CHIP = 34;
  private static readonly TEXT_X = 42;
  private static readonly NAME_SIZE = 13;
  private static readonly SUB_SIZE = 10;
  private static readonly BADGE_SIZE = 11;
  private static readonly CD_W = 150;

  private readonly chip = new Graphics();
  private readonly badge = new Graphics();
  private icon: Sprite | null = null;
  private readonly name: Text;
  private readonly sub: Text;
  private readonly badgeValue: Text;
  private readonly cdBar = new Bar({ w: WeaponCard.CD_W, h: 5, fillColor: 0x63b3ed, label: false });
  private lastKey = '';
  private badgeRight = 0;

  constructor() {
    this.name = new Text({
      text: '',
      style: { fill: 0xe2e8f0, fontSize: WeaponCard.NAME_SIZE, fontFamily: 'monospace', fontWeight: 'bold', padding: 8 },
    });
    this.name.position.set(WeaponCard.TEXT_X, 0);
    this.sub = new Text({
      text: '',
      style: { fill: 0x94a3b8, fontSize: WeaponCard.SUB_SIZE, fontFamily: 'monospace', padding: 6 },
    });
    this.sub.position.set(WeaponCard.TEXT_X, 16);
    this.badgeValue = new Text({
      text: '',
      style: { fill: 0xe2e8f0, fontSize: WeaponCard.BADGE_SIZE, fontFamily: 'monospace', fontWeight: 'bold', padding: 6 },
    });
    this.cdBar.view.position.set(WeaponCard.TEXT_X, 31);
    this.view.addChild(this.chip, this.name, this.sub, this.badge, this.badgeValue, this.cdBar.view);
  }

  /** `readyTicks/maxCdTicks` drive the recovery sweep — the caller already resolves the
   *  ranged/melee cadence field, since only it knows which one this spec uses. */
  set(spec: WeaponSimSpec | null, readyTicks: number, maxCdTicks: number): void {
    // The active locale is part of the key: this card's strings are translated, so a
    // language change has to invalidate the cache even though the weapon didn't move.
    // (The unarmed state carries a real key too — `''` was the uninitialized value, so
    // starting a run with no weapon would otherwise never draw its own fallback card.)
    const key = `${getLocale()}|${spec ? `${spec.name}|${spec.rarity}|${spec.damageType}|${spec.damage}` : 'unarmed'}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.redraw(spec);
    }
    this.cdBar.view.visible = spec !== null;
    if (spec) this.cdBar.set(readyTicks, maxCdTicks);
  }

  /** Advance the cooldown bar's flash. Call once per render frame (dt in ms). */
  update(dt: number): void {
    if (this.cdBar.view.visible) this.cdBar.update(dt);
  }

  estimatedWidth(): number {
    return Math.max(
      this.badgeRight,
      WeaponCard.TEXT_X + estimateMonoWidth(this.sub.text, WeaponCard.SUB_SIZE),
      WeaponCard.TEXT_X + WeaponCard.CD_W,
    );
  }

  /** Test seams — see StatChip's own. */
  get nameText(): string {
    return this.name.text;
  }
  get subText(): string {
    return this.sub.text;
  }
  get damageText(): string {
    return this.badgeValue.text;
  }

  private redraw(spec: WeaponSimSpec | null): void {
    const box = WeaponCard.CHIP;
    const border = spec ? rarityColor(spec) : 0x4c566a;
    this.chip
      .clear()
      .roundRect(0, 2, box, box, 7)
      .fill({ color: 0x18202f, alpha: 0.92 })
      .roundRect(0.5, 2.5, box - 1, box - 1, 7)
      .stroke({ color: border, alpha: 0.85, width: 1.5 });

    this.name.text = spec ? spec.name : t('hud.weapon.none');
    this.name.style.fill = border;
    this.sub.text = spec
      ? t('hud.weapon.sub', {
          rarity: t(RARITY_KEY[spec.rarity]),
          kind: t(KIND_KEY[spec.kind]),
          element: t(ELEMENT_KEY[spec.damageType]),
        })
      : t('hud.weapon.unarmed');

    this.bindIcon(spec);
    this.layoutBadge(spec);
  }

  // Art is best-effort (design/02/12) — an unloaded weapon texture just leaves the
  // rarity-bordered chip empty rather than blocking the card.
  private bindIcon(spec: WeaponSimSpec | null): void {
    const texture = spec ? getWeaponTexture(spec.name, spec.kind) : undefined;
    if (!texture) {
      this.icon?.destroy();
      this.icon = null;
      return;
    }
    if (!this.icon) {
      this.icon = new Sprite();
      this.icon.anchor.set(0.5);
      this.view.addChildAt(this.icon, 1); // above the chip, below the text
    }
    this.icon.texture = texture;
    // Contain — weapon art is a wide "socket-to-tip" silhouette, so a stretch to the
    // square chip would squash it (same fit `Button.setIcon` uses for the Forge rows).
    const inner = WeaponCard.CHIP - 8;
    this.icon.scale.set(Math.min(inner / texture.width, inner / texture.height));
    this.icon.position.set(WeaponCard.CHIP / 2, 2 + WeaponCard.CHIP / 2);
  }

  // The damage badge sits immediately right of the weapon name and is tinted by damage
  // type, so the element named in the subtitle and the number it modifies read as one
  // unit (design/13's element palette is locked, so the hue is meaningful, not decor).
  private layoutBadge(spec: WeaponSimSpec | null): void {
    this.badge.clear();
    if (!spec) {
      this.badgeValue.text = '';
      this.badgeValue.visible = false;
      this.badgeRight = WeaponCard.TEXT_X + estimateMonoWidth(this.name.text, WeaponCard.NAME_SIZE);
      return;
    }
    const tint = elementColor(spec.damageType);
    this.badgeValue.visible = true;
    this.badgeValue.text = t('hud.weapon.damage', { damage: spec.damage });
    this.badgeValue.style.fill = tint;
    const x = WeaponCard.TEXT_X + Math.ceil(estimateMonoWidth(this.name.text, WeaponCard.NAME_SIZE)) + 8;
    const w = Math.ceil(estimateMonoWidth(this.badgeValue.text, WeaponCard.BADGE_SIZE)) + 12;
    this.badge
      .roundRect(x, 0, w, 16, 8)
      .fill({ color: tint, alpha: 0.18 })
      .roundRect(x + 0.5, 0.5, w - 1, 15, 8)
      .stroke({ color: tint, alpha: 0.7, width: 1 });
    this.badgeValue.position.set(x + 6, 2);
    this.badgeRight = x + w;
  }
}
