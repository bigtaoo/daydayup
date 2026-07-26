// SettingsStore — persistence port for SettingsState, symmetric to ../meta/store.ts.
import { defaultSettingsState, type SettingsState } from './SettingsState';

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

/** localStorage-backed store for the web build. Fails soft, same convention as
 * ../meta/store.ts's createWebMetaStore: a corrupt/missing save falls back to
 * defaults rather than throwing. */
export function createWebSettingsStore(key: string = DEFAULT_KEY): SettingsStore {
  const available = typeof localStorage !== 'undefined';
  return {
    load(): SettingsState {
      if (!available) return defaultSettingsState();
      try {
        const raw = localStorage.getItem(key);
        return raw ? migrate(JSON.parse(raw)) : defaultSettingsState();
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
  return {
    master: num(p.master, d.master),
    sfx: num(p.sfx, d.sfx),
    music: num(p.music, d.music),
    muted: typeof p.muted === 'boolean' ? p.muted : d.muted,
  };
}
