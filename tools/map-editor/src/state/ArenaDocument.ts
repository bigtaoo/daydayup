import type { ArenaMap } from '@dd/engine/content/arenas';

const AUTOSAVE_KEY = 'ddu-mapeditor:arena:draft';

/** In-memory editing state for the (single, per plan) open ArenaMap document,
 * plus a localStorage autosave on every mutation. */
export class ArenaDocument {
  map: ArenaMap;
  private listeners = new Set<() => void>();

  constructor(map: ArenaMap) {
    this.map = map;
  }

  on(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  mutate(fn: (map: ArenaMap) => void): void {
    fn(this.map);
    this.autosave();
    this.emit();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private autosave(): void {
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(this.map));
    } catch {
      // best-effort
    }
  }

  static loadAutosave(): ArenaMap | null {
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY);
      return raw ? (JSON.parse(raw) as ArenaMap) : null;
    } catch {
      return null;
    }
  }

  static blank(id: string): ArenaMap {
    return { id, sizeGrid: { w: 200, h: 200 }, rooms: [], doors: [], spawns: [], eyeCandidates: [] };
  }
}
