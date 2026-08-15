/**
 * `WeaponCard` caches its whole redraw behind one key, so the things worth pinning are
 * the invalidation boundaries: which spec changes must repaint (name/rarity/element/
 * damage, and the active locale), and which must not (a cooldown tick, which happens
 * 30x a second). Plus the unarmed fallback, which was the one branch a `''` cache key
 * silently swallowed the first time this was written.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { WeaponSimSpec } from '@dd/engine';
import { WEAPON_SIM_BY_ID } from '@dd/engine';
import { WeaponCard } from './WeaponCard';
import { rarityColor } from '../theme';
import { setLocale, resetLocaleForTests, tName } from '../../i18n';

afterEach(() => resetLocaleForTests());

const BLASTER = WEAPON_SIM_BY_ID.blaster!;
const SABER = WEAPON_SIM_BY_ID.saber!;

function variant(base: WeaponSimSpec, over: Partial<WeaponSimSpec>): WeaponSimSpec {
  return { ...base, ...over } as WeaponSimSpec;
}

describe('WeaponCard — equipped weapon', () => {
  it('names the weapon and states rarity, kind and element in the subtitle', () => {
    const card = new WeaponCard();
    card.set(BLASTER, 0, 10);
    // Translated display name (tName(nameKey)), not the raw catalog id (.name is now
    // the render/texture-lookup key only).
    expect(card.nameText).toBe(tName(BLASTER.nameKey));
    expect(card.nameText).not.toBe(BLASTER.name);
    expect(card.subText).toContain(BLASTER.rarity);
    expect(card.subText).toContain(BLASTER.kind);
    expect(card.subText).toContain(BLASTER.damageType);
  });

  it('puts the damage number in the badge, not the subtitle', () => {
    const card = new WeaponCard();
    card.set(variant(BLASTER, { damage: 42 }), 0, 10);
    expect(card.damageText).toContain('42');
    expect(card.subText).not.toContain('42');
  });

  it('shows a melee weapon as melee', () => {
    const card = new WeaponCard();
    card.set(SABER, 0, 10);
    expect(card.subText).toContain('melee');
  });

  it('repaints when the weapon is swapped', () => {
    const card = new WeaponCard();
    card.set(BLASTER, 0, 10);
    card.set(SABER, 0, 10);
    expect(card.nameText).toBe(tName(SABER.nameKey));
    expect(card.subText).toContain('melee');
  });

  it('repaints when only the rarity changes (same weapon id)', () => {
    const card = new WeaponCard();
    card.set(variant(BLASTER, { rarity: 'common' }), 0, 10);
    expect(card.subText).toContain('common');
    card.set(variant(BLASTER, { rarity: 'legendary' }), 0, 10);
    expect(card.subText).toContain('legendary');
  });

  it('repaints when only the element changes (same weapon id)', () => {
    const card = new WeaponCard();
    card.set(variant(BLASTER, { damageType: 'physical' }), 0, 10);
    expect(card.subText).toContain('physical');
    card.set(variant(BLASTER, { damageType: 'fire' }), 0, 10);
    expect(card.subText).toContain('fire');
    expect(card.subText).not.toContain('physical');
  });

  it('repaints when only the damage changes (a run buff, same weapon)', () => {
    const card = new WeaponCard();
    card.set(variant(BLASTER, { damage: 1 }), 0, 10);
    card.set(variant(BLASTER, { damage: 7 }), 0, 10);
    expect(card.damageText).toContain('7');
  });

  it('does not repaint for a cooldown tick alone (this runs every frame)', () => {
    const card = new WeaponCard();
    card.set(BLASTER, 0, 10);
    const width = card.estimatedWidth();
    for (let t = 0; t <= 10; t++) card.set(BLASTER, t, 10);
    expect(card.estimatedWidth()).toBe(width);
    expect(card.nameText).toBe(tName(BLASTER.nameKey));
  });
});

describe('WeaponCard — unarmed fallback', () => {
  it('draws a real card, not an empty one, when there is no weapon', () => {
    const card = new WeaponCard();
    card.set(null, 0, 1);
    expect(card.nameText).toBe('NO WEAPON');
    expect(card.subText).toBe('unarmed');
    expect(card.damageText).toBe('');
  });

  it('reaches the unarmed branch even as the very first set() (empty-key regression)', () => {
    const card = new WeaponCard();
    card.set(null, 0, 1); // nothing drawn before this — the cache must not swallow it
    expect(card.nameText).not.toBe('');
  });

  it('recovers the real card after picking a weapon up, and drops it again on loss', () => {
    const card = new WeaponCard();
    card.set(null, 0, 1);
    card.set(BLASTER, 0, 10);
    expect(card.nameText).toBe(tName(BLASTER.nameKey));
    card.set(null, 0, 1);
    expect(card.nameText).toBe('NO WEAPON');
    expect(card.damageText).toBe('');
  });

  it('hides the cooldown bar while unarmed and shows it again once armed', () => {
    const card = new WeaponCard();
    const cdBar = card.view.children[card.view.children.length - 1]!;
    card.set(BLASTER, 0, 10);
    expect(cdBar.visible).toBe(true);
    card.set(null, 0, 1);
    expect(cdBar.visible).toBe(false);
  });
});

describe('WeaponCard — i18n', () => {
  it('re-translates on a locale change even though the weapon did not move', () => {
    const card = new WeaponCard();
    card.set(BLASTER, 0, 10);
    expect(card.subText).toContain('ranged');

    setLocale('zh');
    card.set(BLASTER, 0, 10); // identical spec — only the locale changed
    expect(card.subText).toContain('远程');
    expect(card.damageText).toContain('伤害');

    setLocale('en');
    card.set(BLASTER, 0, 10);
    expect(card.subText).toContain('ranged');
  });

  it('translates every rarity tier the engine can hand it', () => {
    setLocale('zh');
    const card = new WeaponCard();
    const expected: Record<string, string> = {
      common: '普通',
      fine: '精良',
      epic: '史诗',
      legend: '传说',
      legendary: '传奇',
    };
    for (const [tier, zh] of Object.entries(expected)) {
      card.set(variant(BLASTER, { rarity: tier as WeaponSimSpec['rarity'] }), 0, 10);
      expect(card.subText).toContain(zh);
    }
  });

  it('translates every damage type the engine can hand it', () => {
    setLocale('zh');
    const card = new WeaponCard();
    const expected: Record<string, string> = {
      physical: '物理',
      fire: '火',
      ice: '冰',
      lightning: '雷',
      poison: '毒',
    };
    for (const [element, zh] of Object.entries(expected)) {
      card.set(variant(BLASTER, { damageType: element as WeaponSimSpec['damageType'] }), 0, 10);
      expect(card.subText).toContain(zh);
    }
  });
});

describe('WeaponCard — layout width', () => {
  it('never reports narrower than the cooldown bar it draws', () => {
    const card = new WeaponCard();
    // `nameKey`, not `name` — the card displays `tName(spec.nameKey)`; `.name` is now
    // the render/texture-lookup id only (see WeaponCard.ts). An uncatalogued nameKey
    // (no dot, matches nothing) falls back to being echoed back raw by `tName()`,
    // same as this test's old `.name` override used to be echoed directly.
    card.set(variant(BLASTER, { nameKey: 'x' }), 0, 10);
    expect(card.estimatedWidth()).toBeGreaterThanOrEqual(150);
  });

  it('grows for a name long enough to push the damage badge past the bar', () => {
    const card = new WeaponCard();
    card.set(variant(BLASTER, { nameKey: 'x' }), 0, 10);
    const narrow = card.estimatedWidth();
    card.set(variant(BLASTER, { nameKey: 'a-truly-preposterous-weapon-name' }), 0, 10);
    expect(card.estimatedWidth()).toBeGreaterThan(narrow);
  });
});

describe('rarityColor — the border hue the card passes through (design/14)', () => {
  it('gives every tier a distinct colour', () => {
    const tiers: Array<WeaponSimSpec['rarity']> = ['common', 'fine', 'epic', 'legend', 'legendary'];
    const colors = tiers.map((r) => rarityColor(variant(BLASTER, { rarity: r })));
    expect(new Set(colors).size).toBe(tiers.length);
  });
});
