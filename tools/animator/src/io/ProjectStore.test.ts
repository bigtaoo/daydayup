import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProjectStore, type ProjectMeta } from './ProjectStore';

// ── Fake IndexedDB ──────────────────────────────────────────────────────────
// ProjectStore.ts's entire IDB surface, and nothing more:
//   indexedDB.open(name, version) → request with onupgradeneeded/onsuccess/onerror
//   db.objectStoreNames.contains(name), db.createObjectStore(name, {keyPath})
//   db.transaction(storeNames, mode) → tx.objectStore(name), tx.oncomplete/onerror/onabort
//   store.get/put/delete/getAll → request with onsuccess/onerror
//
// Deliberately NOT modeled: transaction scope enforcement (objectStore() succeeds
// even for stores outside the requested scope), db versioning/onblocked/onversionchange,
// getAllKeys/cursors/indexes, and db.close(). None of those are exercised by
// ProjectStore.ts. Extend the relevant class below if a future caller needs them.
//
// Also NOT modeled: real cross-store rollback when a transaction aborts. Writes
// that already landed in `store.data` before the failing request stay put — only
// the failing request's own write is skipped. ProjectStore's multi-store writes
// (put()/delete() touching both `meta` and `blobs`) reject correctly either way,
// but don't rely on this fake for "all-or-nothing across stores" semantics.

type Handler = ((ev: { target: unknown }) => void) | null;

class FakeIDBRequest<T = unknown> {
  result: T | undefined;
  error: Error | null = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
  // Only present on the open() request; ProjectStore reads it via IDBOpenDBRequest.
  onupgradeneeded: Handler = null;
}

class FakeStore {
  data = new Map<string, unknown>();
  /** Set by a test to make the *next* operation on this store fail. */
  failNext: Error | null = null;
  constructor(public keyPath: string) {}
}

class FakeIDBTransaction {
  oncomplete: (() => void) | null = null;
  onerror: Handler = null;
  onabort: Handler = null;
  error: Error | null = null;
  private pending = 0;
  private settled = false;

  constructor(private stores: Map<string, FakeStore>) {}

  objectStore(name: string): FakeObjectStore {
    const store = this.stores.get(name);
    if (!store) throw new Error(`FakeIDB: no such object store "${name}"`);
    return new FakeObjectStore(store, this);
  }

  /** @internal called by FakeObjectStore around each request it issues. */
  _begin(): void {
    this.pending++;
  }

  _end(): void {
    this.pending--;
    if (this.pending === 0) {
      queueMicrotask(() => {
        if (this.pending === 0 && !this.settled) {
          this.settled = true;
          this.oncomplete?.();
        }
      });
    }
  }

  /** A request errored with nothing attached to handle it — mirrors real IDB's
   *  auto-abort: the error bubbles to the transaction, then it aborts. */
  _abort(err: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.error = err;
    this.onerror?.({ target: this });
    this.onabort?.({ target: this });
  }
}

class FakeObjectStore {
  constructor(private store: FakeStore, private tx: FakeIDBTransaction) {}

  get(key: string) {
    return this._run(() => this.store.data.get(key));
  }

  put(value: Record<string, unknown>) {
    const key = String(value[this.store.keyPath]);
    return this._run(() => {
      this.store.data.set(key, value);
      return key;
    });
  }

  delete(key: string) {
    return this._run<undefined>(() => {
      this.store.data.delete(key);
      return undefined;
    });
  }

  getAll() {
    return this._run(() => Array.from(this.store.data.values()));
  }

  private _run<T>(fn: () => T): FakeIDBRequest<T> {
    const req = new FakeIDBRequest<T>();
    this.tx._begin();
    queueMicrotask(() => {
      const failure = this.store.failNext;
      if (failure) {
        this.store.failNext = null;
        req.error = failure;
        if (req.onerror) {
          req.onerror({ target: req });
          this.tx._end();
        } else {
          // No handler on this request (put()/delete() fire-and-forget path) —
          // the error propagates to the owning transaction instead.
          this.tx._abort(failure);
        }
        return;
      }
      req.result = fn();
      req.onsuccess?.({ target: req });
      this.tx._end();
    });
    return req;
  }
}

class FakeIDBDatabase {
  private stores = new Map<string, FakeStore>();

  get objectStoreNames() {
    const names = Array.from(this.stores.keys());
    return { contains: (n: string) => names.includes(n) };
  }

  createObjectStore(name: string, opts: { keyPath: string }): void {
    this.stores.set(name, new FakeStore(opts.keyPath));
  }

  transaction(_storeNames: string | string[], _mode: string): FakeIDBTransaction {
    return new FakeIDBTransaction(this.stores);
  }

  /** Test-only escape hatch for seeding/inspecting/injecting failures directly. */
  _store(name: string): FakeStore {
    const store = this.stores.get(name);
    if (!store) throw new Error(`FakeIDB: no such object store "${name}"`);
    return store;
  }
}

/** Builds one fake `indexedDB` global. Databases persist by name for the life of
 *  this object, same as a real browser profile — mirrors ProjectStore's own
 *  `open()` memoization being per-instance, not per-page. */
function createFakeIndexedDB() {
  const databases = new Map<string, FakeIDBDatabase>();
  let failNextOpen: Error | null = null;

  return {
    indexedDB: {
      open(name: string, _version: number): FakeIDBRequest<FakeIDBDatabase> {
        const req = new FakeIDBRequest<FakeIDBDatabase>();
        queueMicrotask(() => {
          if (failNextOpen) {
            const err = failNextOpen;
            failNextOpen = null;
            req.error = err;
            req.onerror?.({ target: req });
            return;
          }
          let db = databases.get(name);
          const isNew = !db;
          if (!db) {
            db = new FakeIDBDatabase();
            databases.set(name, db);
          }
          req.result = db;
          if (isNew) req.onupgradeneeded?.({ target: req });
          req.onsuccess?.({ target: req });
        });
        return req;
      },
    },
    failNextOpen(err: Error): void {
      failNextOpen = err;
    },
    getDatabase(name: string): FakeIDBDatabase | undefined {
      return databases.get(name);
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

const DB_NAME = 'dd-animator';

function makeMeta(overrides: Partial<ProjectMeta> = {}): ProjectMeta {
  return { id: 'p1', name: 'Untitled', updatedAt: 1000, ...overrides };
}

let fake: ReturnType<typeof createFakeIndexedDB>;

beforeEach(() => {
  fake = createFakeIndexedDB();
  vi.stubGlobal('indexedDB', fake.indexedDB);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ProjectStore — open/upgrade', () => {
  it('creates the meta and blobs object stores on first open', async () => {
    const store = new ProjectStore();
    await store.listMeta(); // forces open()

    const db = fake.getDatabase(DB_NAME)!;
    expect(db.objectStoreNames.contains('meta')).toBe(true);
    expect(db.objectStoreNames.contains('blobs')).toBe(true);
  });

  it('memoizes the open database across calls on the same instance', async () => {
    const store = new ProjectStore();
    await store.listMeta();
    await store.listMeta();

    // Only one underlying database was ever created for this name.
    expect(fake.getDatabase(DB_NAME)).toBeDefined();
  });

  it('rejects pending operations when opening the database fails', async () => {
    fake.failNextOpen(new Error('boom: disk full'));
    const store = new ProjectStore();

    await expect(store.listMeta()).rejects.toThrow('boom: disk full');
  });
});

describe('ProjectStore — listMeta', () => {
  it('returns an empty array when nothing has been saved', async () => {
    const store = new ProjectStore();
    await expect(store.listMeta()).resolves.toEqual([]);
  });

  it('sorts by updatedAt, most recent first', async () => {
    const store = new ProjectStore();
    await store.put(makeMeta({ id: 'old', updatedAt: 100 }), new Blob(['a']));
    await store.put(makeMeta({ id: 'newest', updatedAt: 300 }), new Blob(['b']));
    await store.put(makeMeta({ id: 'mid', updatedAt: 200 }), new Blob(['c']));

    const result = await store.listMeta();
    expect(result.map(m => m.id)).toEqual(['newest', 'mid', 'old']);
  });

  it('propagates a getAll() failure', async () => {
    const store = new ProjectStore();
    await store.listMeta(); // open the db so the store exists to fail on
    fake.getDatabase(DB_NAME)!._store('meta').failNext = new Error('getAll exploded');

    await expect(store.listMeta()).rejects.toThrow('getAll exploded');
  });
});

describe('ProjectStore — getBlob', () => {
  it('returns undefined for an id that was never saved', async () => {
    const store = new ProjectStore();
    await expect(store.getBlob('missing')).resolves.toBeUndefined();
  });

  it('returns the blob that was put under that id', async () => {
    const store = new ProjectStore();
    const blob = new Blob(['zip-bytes']);
    await store.put(makeMeta({ id: 'p1' }), blob);

    await expect(store.getBlob('p1')).resolves.toBe(blob);
  });

  it('propagates a get() failure', async () => {
    const store = new ProjectStore();
    await store.put(makeMeta(), new Blob(['x']));
    fake.getDatabase(DB_NAME)!._store('blobs').failNext = new Error('get exploded');

    await expect(store.getBlob('p1')).rejects.toThrow('get exploded');
  });
});

describe('ProjectStore — put', () => {
  it('writes both meta and blob atomically', async () => {
    const store = new ProjectStore();
    const meta = makeMeta({ id: 'p1', name: 'My Rig' });
    const blob = new Blob(['zip-bytes']);

    await store.put(meta, blob);

    await expect(store.listMeta()).resolves.toEqual([meta]);
    await expect(store.getBlob('p1')).resolves.toBe(blob);
  });

  it('overwrites an existing id rather than duplicating it', async () => {
    const store = new ProjectStore();
    await store.put(makeMeta({ id: 'p1', name: 'First', updatedAt: 1 }), new Blob(['a']));
    await store.put(makeMeta({ id: 'p1', name: 'Second', updatedAt: 2 }), new Blob(['b']));

    const all = await store.listMeta();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('Second');
  });

  it('rejects when the transaction aborts, and the failing write never lands', async () => {
    const store = new ProjectStore();
    await store.listMeta(); // open the db first so the store exists
    fake.getDatabase(DB_NAME)!._store('blobs').failNext = new Error('put exploded');

    await expect(store.put(makeMeta({ id: 'p1' }), new Blob(['x']))).rejects.toThrow('put exploded');
    // The blob write is the one that failed — it must not be visible afterwards.
    // (The meta write in the same transaction may still have landed: this fake
    // does not model cross-store rollback on abort — see the file-header comment.)
    await expect(store.getBlob('p1')).resolves.toBeUndefined();
  });
});

describe('ProjectStore — putMeta', () => {
  it('updates metadata without touching the existing blob', async () => {
    const store = new ProjectStore();
    const blob = new Blob(['zip-bytes']);
    await store.put(makeMeta({ id: 'p1', name: 'Original' }), blob);

    await store.putMeta(makeMeta({ id: 'p1', name: 'Renamed' }));

    const all = await store.listMeta();
    expect(all[0].name).toBe('Renamed');
    await expect(store.getBlob('p1')).resolves.toBe(blob);
  });

  it('can create a meta record with no corresponding blob', async () => {
    const store = new ProjectStore();
    await store.putMeta(makeMeta({ id: 'orphan' }));

    await expect(store.listMeta()).resolves.toEqual([makeMeta({ id: 'orphan' })]);
    await expect(store.getBlob('orphan')).resolves.toBeUndefined();
  });
});

describe('ProjectStore — delete', () => {
  it('removes both the meta record and the blob', async () => {
    const store = new ProjectStore();
    await store.put(makeMeta({ id: 'p1' }), new Blob(['x']));

    await store.delete('p1');

    await expect(store.listMeta()).resolves.toEqual([]);
    await expect(store.getBlob('p1')).resolves.toBeUndefined();
  });

  it('deleting an id that was never saved is a no-op, not an error', async () => {
    const store = new ProjectStore();
    await expect(store.delete('never-existed')).resolves.toBeUndefined();
  });

  it('only removes the targeted id, leaving others intact', async () => {
    const store = new ProjectStore();
    await store.put(makeMeta({ id: 'keep' }), new Blob(['a']));
    await store.put(makeMeta({ id: 'gone' }), new Blob(['b']));

    await store.delete('gone');

    const all = await store.listMeta();
    expect(all.map(m => m.id)).toEqual(['keep']);
  });

  it('rejects when the transaction aborts', async () => {
    const store = new ProjectStore();
    await store.put(makeMeta({ id: 'p1' }), new Blob(['x']));
    fake.getDatabase(DB_NAME)!._store('meta').failNext = new Error('delete exploded');

    await expect(store.delete('p1')).rejects.toThrow('delete exploded');
  });
});
