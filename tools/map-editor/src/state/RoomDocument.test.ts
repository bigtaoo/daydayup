/**
 * RoomDocument — in-memory RoomPiece editing state + localStorage autosave on every
 * mutation, plus `loadAutosave`/`blank` statics. Mirrors this project's standing
 * "fails soft" convention for storage (see client/src/settings/store.test.ts) — a
 * broken/unavailable localStorage must never throw out of `mutate`/`loadAutosave`.
 */
import { describe, it, expect } from 'vitest';
import { RoomDocument } from './RoomDocument';

// jsdom-free: this repo's plain-node vitest has no `localStorage` — exercise the
// autosave/loadAutosave paths via an in-memory shim scoped to this file only, same
// convention as client/src/settings/store.test.ts's `withFakeLocalStorage`.
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

describe('RoomDocument.blank', () => {
  it('produces the documented default shape', () => {
    expect(RoomDocument.blank('room_1')).toEqual({
      id: 'room_1',
      sizeGrid: { w: 20, h: 20 },
      solids: [],
      spawns: { player: [], enemy: [] },
      exits: [],
    });
  });
});

describe('RoomDocument — construction, mutate, on/off', () => {
  it('exposes the piece it was constructed with', () => {
    const piece = RoomDocument.blank('room_1');
    const doc = new RoomDocument(piece);
    expect(doc.piece).toBe(piece);
  });

  it('mutate runs the callback against the live piece', () => {
    const doc = new RoomDocument(RoomDocument.blank('room_1'));
    doc.mutate((piece) => {
      piece.solids.push({ x: 0, y: 0, w: 1, h: 1 });
    });
    expect(doc.piece.solids).toEqual([{ x: 0, y: 0, w: 1, h: 1 }]);
  });

  it('notifies every registered listener on mutate', () => {
    const doc = new RoomDocument(RoomDocument.blank('room_1'));
    let calls = 0;
    doc.on(() => {
      calls += 1;
    });
    doc.mutate(() => {});
    doc.mutate(() => {});
    expect(calls).toBe(2);
  });

  it('on() returns an unsubscribe function that stops further notifications', () => {
    const doc = new RoomDocument(RoomDocument.blank('room_1'));
    let calls = 0;
    const off = doc.on(() => {
      calls += 1;
    });
    doc.mutate(() => {});
    off();
    doc.mutate(() => {});
    expect(calls).toBe(1);
  });

  it('supports multiple independent listeners', () => {
    const doc = new RoomDocument(RoomDocument.blank('room_1'));
    let a = 0;
    let b = 0;
    doc.on(() => {
      a += 1;
    });
    doc.on(() => {
      b += 1;
    });
    doc.mutate(() => {});
    expect(a).toBe(1);
    expect(b).toBe(1);
  });
});

describe('RoomDocument — autosave on mutate', () => {
  it('writes the current piece as JSON under the default draft key', () => {
    withFakeLocalStorage(() => {
      const piece = RoomDocument.blank('room_1');
      const doc = new RoomDocument(piece);
      doc.mutate((p) => {
        p.solids.push({ x: 1, y: 2, w: 3, h: 4 });
      });
      const raw = localStorage.getItem('ddu-mapeditor:room:draft');
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw!)).toEqual(doc.piece);
    });
  });

  it('uses a per-document autosave key when one is passed', () => {
    withFakeLocalStorage(() => {
      const doc = new RoomDocument(RoomDocument.blank('room_2'), 'room_2');
      doc.mutate(() => {});
      expect(localStorage.getItem('ddu-mapeditor:room:room_2')).not.toBeNull();
      expect(localStorage.getItem('ddu-mapeditor:room:draft')).toBeNull();
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
      const doc = new RoomDocument(RoomDocument.blank('room_1'));
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
      const doc = new RoomDocument(RoomDocument.blank('room_1'));
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

describe('RoomDocument.loadAutosave', () => {
  it('returns null when nothing has been saved yet', () => {
    withFakeLocalStorage(() => {
      expect(RoomDocument.loadAutosave()).toBeNull();
    });
  });

  it('round-trips a piece saved via mutate, under the default key', () => {
    withFakeLocalStorage(() => {
      const doc = new RoomDocument(RoomDocument.blank('room_1'));
      doc.mutate((p) => {
        p.solids.push({ x: 5, y: 5, w: 1, h: 1 });
      });
      expect(RoomDocument.loadAutosave()).toEqual(doc.piece);
    });
  });

  it('round-trips under a custom key, independent of the default key', () => {
    withFakeLocalStorage(() => {
      const doc = new RoomDocument(RoomDocument.blank('room_3'), 'room_3');
      doc.mutate(() => {});
      expect(RoomDocument.loadAutosave('room_3')).toEqual(doc.piece);
      expect(RoomDocument.loadAutosave()).toBeNull();
    });
  });

  it('returns null (not a throw) for a corrupt saved value', () => {
    withFakeLocalStorage(() => {
      localStorage.setItem('ddu-mapeditor:room:draft', 'not json');
      expect(() => RoomDocument.loadAutosave()).not.toThrow();
      expect(RoomDocument.loadAutosave()).toBeNull();
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
      expect(() => RoomDocument.loadAutosave()).not.toThrow();
      expect(RoomDocument.loadAutosave()).toBeNull();
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});
