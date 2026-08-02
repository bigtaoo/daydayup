/**
 * i18n (design/17-i18n.md) — English (`en.ts`) is the canonical/source-of-truth
 * locale; every other locale is a `Translations<typeof en>`, which makes a missing or
 * extra key a compile error rather than a silent runtime fallback. Keys are semantic
 * dotted paths (`t('forge.title')`), not raw English sentences, so editing the English
 * copy never breaks another locale's key.
 *
 * `currentLocale` is a live, in-process mirror of `SettingsState.locale` (the
 * persisted value) — Game.ts calls `setLocale()` once at boot after loading settings,
 * then again on every language change, so every `t()` call site doesn't need a
 * SettingsState threaded through it.
 */
import { en } from './locales/en';
import { zh } from './locales/zh';

export type Locale = 'en' | 'zh';
export const LOCALES: readonly Locale[] = ['en', 'zh'];
export const DEFAULT_LOCALE: Locale = 'en';

type DotPaths<T> = T extends string
  ? never
  : { [K in keyof T & string]: T[K] extends string ? K : `${K}.${DotPaths<T[K]>}` }[keyof T & string];

/** Every valid `t()` key — a compile-time union of `en.ts`'s dotted leaf paths. */
export type TranslationKey = DotPaths<typeof en>;

/** The shape a translation locale must have: `en.ts`'s exact nested keys, string leaves. */
export type Translations<T> = { [K in keyof T]: T[K] extends string ? string : Translations<T[K]> };

const MESSAGES: Record<Locale, Translations<typeof en>> = { en, zh };

let currentLocale: Locale = DEFAULT_LOCALE;

export function getLocale(): Locale {
  return currentLocale;
}

/** Call once at boot (after `SettingsStore.load()`) and again on every language change. */
export function setLocale(locale: Locale): void {
  currentLocale = locale;
}

/** Test-only: reset to the default locale so a test that calls `setLocale` doesn't leak
 * into the next one (same convention as `net/session.ts`'s `resetSessionCacheForTests`). */
export function resetLocaleForTests(): void {
  currentLocale = DEFAULT_LOCALE;
}

function lookup(key: TranslationKey, locale: Locale): string {
  let node: unknown = MESSAGES[locale];
  for (const part of key.split('.')) {
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : key;
}

/** Translate `key` in the active locale, substituting `{name}`-style placeholders from
 * `vars`. `key` is checked at compile time against `en.ts`'s own shape — a typo is a
 * build error, not a blank string at runtime. */
export function t(key: TranslationKey, vars?: Record<string, string | number>): string {
  const template = lookup(key, currentLocale);
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}
