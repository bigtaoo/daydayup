/**
 * SettingsStore (design/10 volume persistence; `locale` added by design/17-i18n.md).
 * Mirrors this project's standing "fails soft, migrate() defends against a corrupt or
 * pre-existing-shape save" convention (see meta/store.ts, net/session.ts).
 */
import { describe, it, expect } from 'vitest';
import { createWebSettingsStore, MemorySettingsStore } from './store';
import { defaultSettingsState } from './SettingsState';

// jsdom-free: this repo's plain-node vitest has no `localStorage`, so exercise the
// migrate()/fails-soft path directly the way store.ts itself falls back — via an
// in-memory `localStorage` shim scoped to this file only.
function withFakeLocalStorage<T>(fn: () => T): T {
  const data = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => data.set(k, v),
    removeItem: (k: string) => data.delete(k),
  };
  try {
    return fn();
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
}

describe('defaultSettingsState', () => {
  it('defaults to English', () => {
    expect(defaultSettingsState().locale).toBe('en');
  });
});

describe('MemorySettingsStore', () => {
  it('round-trips a locale change', () => {
    const store = new MemorySettingsStore();
    const next = { ...defaultSettingsState(), locale: 'zh' as const };
    store.save(next);
    expect(store.load().locale).toBe('zh');
  });
});

describe('createWebSettingsStore — locale migration', () => {
  it('round-trips a valid saved locale', () => {
    withFakeLocalStorage(() => {
      const store = createWebSettingsStore('t.settings.1');
      store.save({ ...defaultSettingsState(), locale: 'zh' });
      expect(createWebSettingsStore('t.settings.1').load().locale).toBe('zh');
    });
  });

  it('falls back to English for a saved locale that is no longer valid', () => {
    withFakeLocalStorage(() => {
      localStorage.setItem('t.settings.2', JSON.stringify({ ...defaultSettingsState(), locale: 'fr' }));
      expect(createWebSettingsStore('t.settings.2').load().locale).toBe('en');
    });
  });

  it('falls back to English when locale is missing entirely (pre-i18n saved state)', () => {
    withFakeLocalStorage(() => {
      const { locale, ...preI18n } = defaultSettingsState();
      void locale;
      localStorage.setItem('t.settings.3', JSON.stringify(preI18n));
      expect(createWebSettingsStore('t.settings.3').load().locale).toBe('en');
    });
  });

  it('a corrupt saved value still yields a fully-defaulted (English) state, not a throw', () => {
    withFakeLocalStorage(() => {
      localStorage.setItem('t.settings.4', 'not json');
      expect(() => createWebSettingsStore('t.settings.4').load()).not.toThrow();
      expect(createWebSettingsStore('t.settings.4').load().locale).toBe('en');
    });
  });
});
