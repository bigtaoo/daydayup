// SettingsStore — persistence port for SettingsState, symmetric to ../meta/store.ts.
import { defaultSettingsState, type ControlLayout, type SettingsState } from './SettingsState';
import { LOCALES, detectBrowserLocale, type Locale } from '../i18n';

export interface SettingsStore {
  load(): SettingsState;
  save(s: SettingsState): void;
}

export class MemorySettingsStore implements SettingsStore {
  private state: SettingsState;
  constructor(initial: SettingsState = defaultSettingsState()) {
    this.state = initial;
  }
  load(): SettingsState {
    return this.state;
  }
  save(s: SettingsState): void {
    this.state = s;
  }
}

const DEFAULT_KEY = 'daydayup.settings.v1';

export interface SettingsStoreDeps {
  /** Overrides `navigator.languages`/`navigator.language` for first-boot locale
   * detection — tests inject a fixed list instead of depending on a real `navigator`. */
  languages?: readonly string[];
}

function browserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages && navigator.languages.length > 0 ? navigator.languages : [navigator.language];
}

/** localStorage-backed store for the web build. Fails soft, same convention as
 * ../meta/store.ts's createWebMetaStore: a corrupt/missing save falls back to
 * defaults rather than throwing.
 *
 * First boot (no save at ALL, `raw === null`) auto-selects a locale from the
 * browser/system language via `detectBrowserLocale` — falls back to English if
 * nothing matches. This deliberately does NOT apply to a save that merely predates
 * `locale` (a pre-i18n save, or a corrupt one) — that's a RETURNING player, whose
 * existing choice of "never touched the language setting" should never be
 * silently overridden after the fact; `migrate()`'s own `en` fallback (below)
 * already covers that case correctly. */
export function createWebSettingsStore(key: string = DEFAULT_KEY, deps: SettingsStoreDeps = {}): SettingsStore {
  const available = typeof localStorage !== 'undefined';
  const languages = deps.languages ?? browserLanguages();
  return {
    load(): SettingsState {
      if (!available) return defaultSettingsState();
      try {
        const raw = localStorage.getItem(key);
        if (raw === null) return { ...defaultSettingsState(), locale: detectBrowserLocale(languages) };
        return migrate(JSON.parse(raw));
      } catch {
        return defaultSettingsState();
      }
    },
    save(s: SettingsState): void {
      if (!available) return;
      try {
        localStorage.setItem(key, JSON.stringify(s));
      } catch {
        /* quota / private-mode — a lost save is acceptable, a crash is not */
      }
    },
  };
}

function migrate(parsed: unknown): SettingsState {
  const d = defaultSettingsState();
  if (!parsed || typeof parsed !== 'object') return d;
  const p = parsed as Partial<SettingsState>;
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fallback);
  const locale = (v: unknown, fallback: Locale) => (LOCALES.includes(v as Locale) ? (v as Locale) : fallback);
  const controlLayout = (v: unknown, fallback: ControlLayout): ControlLayout =>
    v === 'standard' || v === 'mirrored' ? v : fallback;
  return {
    master: num(p.master, d.master),
    sfx: num(p.sfx, d.sfx),
    music: num(p.music, d.music),
    muted: typeof p.muted === 'boolean' ? p.muted : d.muted,
    locale: locale(p.locale, d.locale),
    controlLayout: controlLayout(p.controlLayout, d.controlLayout),
  };
}
