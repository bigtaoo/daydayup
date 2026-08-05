/**
 * ArenaDocument — in-memory ArenaMap editing state + localStorage autosave on every
 * mutation, plus `loadAutosave`/`blank` statics. Same shape as RoomDocument (see
 * RoomDocument.test.ts) minus the per-document key — ArenaDocument is a single,
 * per-plan document so its autosave key is fixed.
 */
import { describe, it, expect } from 'vitest';
import { ArenaDocument } from './ArenaDocument';

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

describe('ArenaDocument.blank', () => {
  it('produces the documented default shape', () => {
    expect(ArenaDocument.blank('arena_1')).toEqual({
      id: 'arena_1',
      sizeGrid: { w: 200, h: 200 },
      rooms: [],
      doors: [],
      spawns: [],
      eyeCandidates: [],
    });
  });
});

describe('ArenaDocument — construction, mutate, on/off', () => {
  it('exposes the map it was constructed with', () => {
    const map = ArenaDocument.blank('arena_1');
    const doc = new ArenaDocument(map);
    expect(doc.map).toBe(map);
  });

  it('mutate runs the callback against the live map', () => {
    const doc = new ArenaDocument(ArenaDocument.blank('arena_1'));
    doc.mutate((map) => {
      map.spawns.push({ x: 1, y: 2 });
    });
    expect(doc.map.spawns).toEqual([{ x: 1, y: 2 }]);
  });

  it('notifies every registered listener on mutate', () => {
    const doc = new ArenaDocument(ArenaDocument.blank('arena_1'));
    let calls = 0;
    doc.on(() => {
      calls += 1;
    });
    doc.mutate(() => {});
    doc.mutate(() => {});
    expect(calls).toBe(2);
  });

  it('on() returns an unsubscribe function that stops further notifications', () => {
    const doc = new ArenaDocument(ArenaDocument.blank('arena_1'));
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

describe('ArenaDocument — autosave on mutate', () => {
  it('writes the current map as JSON under the fixed arena draft key', () => {
    withFakeLocalStorage(() => {
      const doc = new ArenaDocument(ArenaDocument.blank('arena_1'));
      doc.mutate((map) => {
        map.spawns.push({ x: 3, y: 4 });
      });
      const raw = localStorage.getItem('ddu-mapeditor:arena:draft');
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
      const doc = new ArenaDocument(ArenaDocument.blank('arena_1'));
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
      const doc = new ArenaDocument(ArenaDocument.blank('arena_1'));
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

describe('ArenaDocument.loadAutosave', () => {
  it('returns null when nothing has been saved yet', () => {
    withFakeLocalStorage(() => {
      expect(ArenaDocument.loadAutosave()).toBeNull();
    });
  });

  it('round-trips a map saved via mutate', () => {
    withFakeLocalStorage(() => {
      const doc = new ArenaDocument(ArenaDocument.blank('arena_1'));
      doc.mutate((map) => {
        map.spawns.push({ x: 9, y: 9 });
      });
      expect(ArenaDocument.loadAutosave()).toEqual(doc.map);
    });
  });

  it('returns null (not a throw) for a corrupt saved value', () => {
    withFakeLocalStorage(() => {
      localStorage.setItem('ddu-mapeditor:arena:draft', 'not json');
      expect(() => ArenaDocument.loadAutosave()).not.toThrow();
      expect(ArenaDocument.loadAutosave()).toBeNull();
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
      expect(() => ArenaDocument.loadAutosave()).not.toThrow();
      expect(ArenaDocument.loadAutosave()).toBeNull();
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});
