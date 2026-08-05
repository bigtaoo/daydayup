import type { DungeonFloorMap } from '@dd/engine';

const AUTOSAVE_KEY = 'ddu-mapeditor:dungeonFloor:draft';

/** In-memory editing state for the (single, per plan) open `DungeonFloorMap`
 * document (design/05 "Hand-authored PvE floors", 2026-08-05) — mirrors
 * `ArenaDocument`'s shape exactly (autosave-on-every-mutation, no undo/redo in
 * v1), since a hand-authored PvE floor is the same "explicit rooms + explicit
 * doors" content shape PvP's `ArenaMap` already is. */
export class DungeonFloorDocument {
  map: DungeonFloorMap;
  private listeners = new Set<() => void>();

  constructor(map: DungeonFloorMap) {
    this.map = map;
  }

  on(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  mutate(fn: (map: DungeonFloorMap) => void): void {
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
      // localStorage unavailable/full — autosave is best-effort insurance only.
    }
  }

  static loadAutosave(): DungeonFloorMap | null {
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY);
      return raw ? (JSON.parse(raw) as DungeonFloorMap) : null;
    } catch {
      return null;
    }
  }

  static blank(id: string): DungeonFloorMap {
    return { id, rooms: [], doors: [] };
  }
}
