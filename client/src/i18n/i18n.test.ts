import { describe, it, expect, beforeEach } from 'vitest';
import { t, getLocale, setLocale, resetLocaleForTests, LOCALES } from './index';
import { en } from './locales/en';
import { zh } from './locales/zh';

beforeEach(() => resetLocaleForTests());

describe('t()', () => {
  it('defaults to English', () => {
    expect(getLocale()).toBe('en');
    expect(t('mainMenu.title')).toBe('DAYDAYUP');
  });

  it('switches locale', () => {
    setLocale('zh');
    expect(t('mainMenu.play')).toBe(zh.mainMenu.play);
    expect(t('mainMenu.play')).not.toBe(en.mainMenu.play);
  });

  it('substitutes {name}-style placeholders', () => {
    expect(t('mainMenu.greeting', { username: 'alice' })).toBe('Hi, alice');
  });

  it('leaves an unknown placeholder untouched', () => {
    expect(t('results.scoreLine', {})).toBe('Score {score}');
  });

  it('resetLocaleForTests restores the default', () => {
    setLocale('zh');
    resetLocaleForTests();
    expect(getLocale()).toBe('en');
  });
});

describe('locale parity', () => {
  it('every declared locale actually resolves every key (no silent key-miss fallback)', () => {
    function leafPaths(node: unknown, prefix: string): string[] {
      if (typeof node === 'string') return [prefix];
      return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
        leafPaths(v, prefix ? `${prefix}.${k}` : k),
      );
    }
    const keys = leafPaths(en, '');
    for (const locale of LOCALES) {
      setLocale(locale);
      for (const key of keys) {
        expect(t(key as never)).not.toBe(key); // lookup() falls back to the raw key on a miss
      }
    }
  });
});
