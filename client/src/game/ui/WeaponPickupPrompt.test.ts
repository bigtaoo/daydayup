import { describe, it, expect, afterEach } from 'vitest';
import type { PickupItem, Fp } from '@dd/engine';
import { WeaponPickupPrompt } from './WeaponPickupPrompt';
import { setLocale, resetLocaleForTests } from '../../i18n';

afterEach(() => resetLocaleForTests());

const fp = (n: number) => n as Fp;

function pickup(id: number, weaponId: string): PickupItem {
  return { id, kind: 'weapon', gx: fp(0), gy: fp(0), spawnTick: 0, alive: true, weaponId };
}

function privateOf(p: WeaponPickupPrompt) {
  return p as unknown as { titleText: { text: string }; rows: Array<{ onTap: (() => void) | null }> };
}

describe('WeaponPickupPrompt — visibility follows the nearby list', () => {
  it('is hidden with no nearby weapons', () => {
    const prompt = new WeaponPickupPrompt();
    prompt.update([]);
    expect(prompt.view.visible).toBe(false);
    expect(prompt.isOpen).toBe(false);
  });

  it('becomes visible with one row per nearby weapon', () => {
    const prompt = new WeaponPickupPrompt();
    prompt.update([pickup(1, 'blaster'), pickup(2, 'saber')]);
    expect(prompt.isOpen).toBe(true);
    expect(privateOf(prompt).rows.length).toBe(2);
  });

  it('hides again once the list goes empty', () => {
    const prompt = new WeaponPickupPrompt();
    prompt.update([pickup(1, 'blaster')]);
    expect(prompt.isOpen).toBe(true);
    prompt.update([]);
    expect(prompt.isOpen).toBe(false);
  });
});

describe('WeaponPickupPrompt — click-to-collect', () => {
  it('tapping a row reports that item\'s id, not another one\'s', () => {
    const prompt = new WeaponPickupPrompt();
    prompt.update([pickup(11, 'blaster'), pickup(22, 'saber')]);
    const picked: number[] = [];
    prompt.onPick = (id) => picked.push(id);

    const rows = privateOf(prompt).rows;
    rows[1]!.onTap?.();
    rows[0]!.onTap?.();

    expect(picked).toEqual([22, 11]);
  });
});

describe('WeaponPickupPrompt — close behavior (stays hidden until the set changes)', () => {
  it('close() hides the panel even though the same weapons are still nearby', () => {
    const prompt = new WeaponPickupPrompt();
    const list = [pickup(1, 'blaster')];
    prompt.update(list);
    expect(prompt.isOpen).toBe(true);

    (prompt as unknown as { closeBtn: { onTap: () => void } }).closeBtn.onTap();
    expect(prompt.isOpen).toBe(false);

    prompt.update(list); // identical set — stays closed
    expect(prompt.isOpen).toBe(false);
  });

  it('reopens once the nearby set actually changes', () => {
    const prompt = new WeaponPickupPrompt();
    prompt.update([pickup(1, 'blaster')]);
    (prompt as unknown as { closeBtn: { onTap: () => void } }).closeBtn.onTap();
    expect(prompt.isOpen).toBe(false);

    prompt.update([pickup(1, 'blaster'), pickup(2, 'saber')]); // a second weapon entered range
    expect(prompt.isOpen).toBe(true);
  });

  it('reopens after leaving the area and coming back to the same set', () => {
    const prompt = new WeaponPickupPrompt();
    const list = [pickup(1, 'blaster')];
    prompt.update(list);
    (prompt as unknown as { closeBtn: { onTap: () => void } }).closeBtn.onTap();

    prompt.update([]); // walked away
    prompt.update(list); // walked back to the same weapon
    expect(prompt.isOpen).toBe(true);
  });
});

describe('WeaponPickupPrompt — i18n (design/17-i18n.md)', () => {
  it('translates the title under zh and reverts under en', () => {
    const prompt = new WeaponPickupPrompt();
    setLocale('zh');
    prompt.update([pickup(1, 'blaster')]);
    const zhTitle = privateOf(prompt).titleText.text;
    setLocale('en');
    prompt.update([pickup(2, 'saber')]); // different id set so rebuild actually re-runs
    const enTitle = privateOf(prompt).titleText.text;
    expect(zhTitle).not.toBe(enTitle);
  });
});
