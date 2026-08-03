import { describe, it, expect, beforeEach } from 'vitest';
import { t, getLocale, setLocale, resetLocaleForTests, LOCALES, detectBrowserLocale } from './index';
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

describe('detectBrowserLocale', () => {
  it('matches the first supported language in preference order', () => {
    expect(detectBrowserLocale(['fr-FR', 'en-US'])).toBe('fr');
  });

  it('strips a region/script subtag before comparing', () => {
    expect(detectBrowserLocale(['zh-CN'])).toBe('zh');
    expect(detectBrowserLocale(['zh-Hans-CN'])).toBe('zh');
  });

  it('skips an unsupported language and matches a later one', () => {
    expect(detectBrowserLocale(['pt-BR', 'de-DE'])).toBe('de');
  });

  it('falls back to the default locale when nothing matches', () => {
    expect(detectBrowserLocale(['pt-BR', 'nl-NL'])).toBe('en');
  });

  it('falls back to the default locale for an empty list', () => {
    expect(detectBrowserLocale([])).toBe('en');
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
