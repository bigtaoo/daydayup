/**
 * DungeonFloorDocument — in-memory DungeonFloorMap editing state + localStorage
 * autosave on every mutation, plus `loadAutosave`/`blank` statics. Mirrors
 * ArenaDocument's shape exactly (see ArenaDocument.test.ts and the class's own
 * doc-comment), just with a different map shape and autosave key.
 */
import { describe, it, expect } from 'vitest';
import { DungeonFloorDocument } from './DungeonFloorDocument';

// jsdom-free: this repo's plain-node vitest has no `localStorage` — same
// per-file shim convention as client/src/settings/store.test.ts.
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

describe('DungeonFloorDocument.blank', () => {
  it('produces the documented default shape', () => {
    expect(DungeonFloorDocument.blank('floor_1')).toEqual({
      id: 'floor_1',
      rooms: [],
      doors: [],
    });
  });
});

describe('DungeonFloorDocument — construction, mutate, on/off', () => {
  it('exposes the map it was constructed with', () => {
    const map = DungeonFloorDocument.blank('floor_1');
    const doc = new DungeonFloorDocument(map);
    expect(doc.map).toBe(map);
  });

  it('mutate runs the callback against the live map', () => {
    const doc = new DungeonFloorDocument(DungeonFloorDocument.blank('floor_1'));
    doc.mutate((map) => {
      map.rooms.push({ id: 'r1', pieceId: 'piece_a', offsetXGrid: 0, offsetYGrid: 0 });
    });
    expect(doc.map.rooms).toEqual([{ id: 'r1', pieceId: 'piece_a', offsetXGrid: 0, offsetYGrid: 0 }]);
  });

  it('notifies every registered listener on mutate', () => {
    const doc = new DungeonFloorDocument(DungeonFloorDocument.blank('floor_1'));
    let calls = 0;
    doc.on(() => {
      calls += 1;
    });
    doc.mutate(() => {});
    doc.mutate(() => {});
    expect(calls).toBe(2);
  });

  it('on() returns an unsubscribe function that stops further notifications', () => {
    const doc = new DungeonFloorDocument(DungeonFloorDocument.blank('floor_1'));
    let calls = 0;
    const off = doc.on(() => {
      calls += 1;
    });
    doc.mutate(() => {});
    off();
    doc.mutate(() => {});
    expect(calls).toBe(1);
  });
});

describe('DungeonFloorDocument — autosave on mutate', () => {
  it('writes the current map as JSON under the fixed dungeonFloor draft key', () => {
    withFakeLocalStorage(() => {
      const doc = new DungeonFloorDocument(DungeonFloorDocument.blank('floor_1'));
      doc.mutate((map) => {
        map.rooms.push({ id: 'r1', pieceId: 'piece_a', offsetXGrid: 1, offsetYGrid: 1 });
      });
      const raw = localStorage.getItem('ddu-mapeditor:dungeonFloor:draft');
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw!)).toEqual(doc.map);
    });
  });

  it('does not throw when localStorage.setItem fails (best-effort autosave)', () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded');
      },
      removeItem: () => {},
    };
    try {
      const doc = new DungeonFloorDocument(DungeonFloorDocument.blank('floor_1'));
      expect(() => doc.mutate(() => {})).not.toThrow();
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  it('still notifies listeners even when autosave fails', () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded');
      },
      removeItem: () => {},
    };
    try {
      const doc = new DungeonFloorDocument(DungeonFloorDocument.blank('floor_1'));
      let calls = 0;
      doc.on(() => {
        calls += 1;
      });
      doc.mutate(() => {});
      expect(calls).toBe(1);
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});

describe('DungeonFloorDocument.loadAutosave', () => {
  it('returns null when nothing has been saved yet', () => {
    withFakeLocalStorage(() => {
      expect(DungeonFloorDocument.loadAutosave()).toBeNull();
    });
  });

  it('round-trips a map saved via mutate', () => {
    withFakeLocalStorage(() => {
      const doc = new DungeonFloorDocument(DungeonFloorDocument.blank('floor_1'));
      doc.mutate((map) => {
        map.doors.push({ roomA: 'r1', roomB: 'r2', passageGrid: { x: 0, y: 0, w: 1, h: 1 } });
      });
      expect(DungeonFloorDocument.loadAutosave()).toEqual(doc.map);
    });
  });

  it('returns null (not a throw) for a corrupt saved value', () => {
    withFakeLocalStorage(() => {
      localStorage.setItem('ddu-mapeditor:dungeonFloor:draft', 'not json');
      expect(() => DungeonFloorDocument.loadAutosave()).not.toThrow();
      expect(DungeonFloorDocument.loadAutosave()).toBeNull();
    });
  });

  it('returns null (not a throw) when localStorage.getItem itself throws', () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {},
      removeItem: () => {},
    };
    try {
      expect(() => DungeonFloorDocument.loadAutosave()).not.toThrow();
      expect(DungeonFloorDocument.loadAutosave()).toBeNull();
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});
