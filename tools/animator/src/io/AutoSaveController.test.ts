import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventBus, type AppEvents } from '../core/EventBus';
import type { IOController } from './IOController';
import type { ProjectStore, ProjectMeta } from './ProjectStore';
import { AutoSaveController, DIRTY_EVENTS } from './AutoSaveController';

const LS_ACTIVE_KEY = 'dd-animator:activeProject';
const RIG_ID = 'orb-core';

// ── Fakes ─────────────────────────────────────────────────────────────────────
// AutoSaveController only ever calls io.buildEditorBlob()/io.loadEditorBlob() — the
// real EditorProjectIO/PIXI machinery behind those is exercised by
// EditorProjectIO.test.ts, so a plain duck-typed spy pair is enough here (mirrors
// IOController.test.ts's own approach of faking one layer below the class under test).

function makeFakeIO() {
  return {
    buildEditorBlob: vi.fn(async () => new Blob(['editortao-bytes'])),
    loadEditorBlob:  vi.fn(async (_blob: Blob, _label: string) => undefined),
  };
}

/** In-memory stand-in for ProjectStore's public surface — real IndexedDB semantics
 *  (transactions, upgrades) are covered by ProjectStore.test.ts; this file only
 *  needs the plain CRUD contract AutoSaveController actually calls. */
class FakeProjectStore {
  metas = new Map<string, ProjectMeta>();
  blobs = new Map<string, Blob>();

  async listMeta(): Promise<ProjectMeta[]> {
    return [...this.metas.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async getBlob(id: string): Promise<Blob | undefined> { return this.blobs.get(id); }
  async put(meta: ProjectMeta, blob: Blob): Promise<void> { this.metas.set(meta.id, meta); this.blobs.set(meta.id, blob); }
  async putMeta(meta: ProjectMeta): Promise<void> { this.metas.set(meta.id, meta); }
  async delete(id: string): Promise<void> { this.metas.delete(id); this.blobs.delete(id); }
}

/** Manual per-test localStorage shim — mirrors client/src/settings/store.test.ts's
 *  convention for this jsdom-free workspace. */
function makeFakeLocalStorage() {
  const data = new Map<string, string>();
  return {
    getItem:    (k: string) => data.get(k) ?? null,
    setItem:    (k: string, v: string) => { data.set(k, v); },
    removeItem: (k: string) => { data.delete(k); },
  };
}

let docListeners: Map<string, Array<() => void>>;
let winListeners: Map<string, Array<() => void>>;
let visibilityState: 'visible' | 'hidden';

function fireDoc(event: string): void { (docListeners.get(event) ?? []).forEach(cb => cb()); }
function fireWin(event: string): void { (winListeners.get(event) ?? []).forEach(cb => cb()); }

beforeEach(() => {
  vi.useFakeTimers();
  docListeners = new Map();
  winListeners = new Map();
  visibilityState = 'visible';

  vi.stubGlobal('localStorage', makeFakeLocalStorage());
  vi.stubGlobal('document', {
    addEventListener: (event: string, cb: () => void) => {
      const arr = docListeners.get(event) ?? [];
      arr.push(cb);
      docListeners.set(event, arr);
    },
    get visibilityState() { return visibilityState; },
  });
  vi.stubGlobal('window', {
    addEventListener: (event: string, cb: () => void) => {
      const arr = winListeners.get(event) ?? [];
      arr.push(cb);
      winListeners.set(event, arr);
    },
    // Referencing the bare identifier at call time means this always resolves to
    // whatever setTimeout is currently installed (real or, here, vitest's fake).
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function build(overrides: { metas?: ProjectMeta[] } = {}) {
  const bus = new EventBus<AppEvents>();
  const store = new FakeProjectStore();
  // A meta record with no matching blob is what ProjectStore.test.ts calls an
  // "orphan" (putMeta() only, no put()) — switchTo() correctly refuses to open
  // one (getBlob() → undefined → "Project not found"), so every seeded project
  // here needs its own blob too, mirroring the real store.put(meta, blob) pairing.
  for (const m of overrides.metas ?? []) {
    store.metas.set(m.id, m);
    store.blobs.set(m.id, new Blob([`seed-bytes-${m.id}`]));
  }
  const io = makeFakeIO();
  const resetToDefaults = vi.fn();
  const ctrl = new AutoSaveController(
    store as unknown as ProjectStore,
    io as unknown as IOController,
    bus,
    resetToDefaults,
    RIG_ID,
  );
  return { bus, store, io, resetToDefaults, ctrl };
}

function meta(overrides: Partial<ProjectMeta> = {}): ProjectMeta {
  return { id: 'p1', name: 'Untitled', updatedAt: 1000, rigId: RIG_ID, ...overrides };
}

function collect(bus: EventBus<AppEvents>, event: keyof AppEvents): unknown[] {
  const out: unknown[] = [];
  bus.on(event, (payload: unknown) => out.push(payload));
  return out;
}

// ── bootstrap ─────────────────────────────────────────────────────────────────

describe('AutoSaveController.bootstrap', () => {
  it('adopts the current preset state as a new "Untitled" project when the library is empty', async () => {
    const { store, io, resetToDefaults, ctrl } = build();

    await ctrl.bootstrap();

    expect(resetToDefaults).toHaveBeenCalledTimes(1);
    expect(io.buildEditorBlob).toHaveBeenCalledTimes(1);
    expect(store.metas.size).toBe(1);
    expect(ctrl.activeName).toBe('Untitled');
    expect(ctrl.activeId).not.toBeNull();
    expect(localStorage.getItem(LS_ACTIVE_KEY)).toBe(ctrl.activeId);
  });

  it('restores the last-active project recorded in localStorage', async () => {
    localStorage.setItem(LS_ACTIVE_KEY, 'p2');
    const { io, ctrl } = build({ metas: [meta({ id: 'p1', name: 'First', updatedAt: 100 }), meta({ id: 'p2', name: 'Second', updatedAt: 200 })] });

    await ctrl.bootstrap();

    expect(io.loadEditorBlob).toHaveBeenCalledWith(expect.any(Blob), 'Second');
    expect(ctrl.activeId).toBe('p2');
    expect(ctrl.activeName).toBe('Second');
  });

  it('falls back to the most-recently-updated project when the stored last-active id is not found', async () => {
    const { ctrl } = build({ metas: [meta({ id: 'old', updatedAt: 100 }), meta({ id: 'new', updatedAt: 999 })] });
    localStorage.setItem(LS_ACTIVE_KEY, 'does-not-exist');

    await ctrl.bootstrap();

    expect(ctrl.activeId).toBe('new');
  });

  it('ignores projects saved under a different rig', async () => {
    const { ctrl, resetToDefaults } = build({ metas: [meta({ id: 'other-rig', rigId: 'critter-core', updatedAt: 999 })] });

    await ctrl.bootstrap();

    // The only saved project is for a different rig, so the library looks empty
    // for THIS rig and a fresh Untitled is created instead of adopting it.
    expect(resetToDefaults).toHaveBeenCalledTimes(1);
    expect(ctrl.activeId).not.toBe('other-rig');
  });

  it('treats a project with no rigId as belonging to orb-core (pre-existing records)', async () => {
    const legacyMeta = { id: 'legacy', name: 'Legacy', updatedAt: 500 } as ProjectMeta; // no rigId field at all
    const { ctrl } = build({ metas: [legacyMeta] });

    await ctrl.bootstrap();

    expect(ctrl.activeId).toBe('legacy');
  });
});

// ── switchTo ──────────────────────────────────────────────────────────────────

describe('AutoSaveController.switchTo', () => {
  it('is a no-op when switching to the already-active project', async () => {
    const { ctrl, io } = build({ metas: [meta({ id: 'p1' })] });
    await ctrl.bootstrap(); // activates p1
    io.loadEditorBlob.mockClear();

    await ctrl.switchTo('p1');

    expect(io.loadEditorBlob).not.toHaveBeenCalled();
  });

  it('emits an error when the target project does not exist', async () => {
    const { ctrl, bus } = build();
    await ctrl.bootstrap();
    const errors = collect(bus, 'error');

    await ctrl.switchTo('missing');

    expect(errors).toEqual(['Project not found']);
  });

  it('refuses to load a project authored for a different rig', async () => {
    const { ctrl, bus, store, io } = build({ metas: [meta({ id: 'p1' })] });
    await ctrl.bootstrap();
    store.metas.set('other', meta({ id: 'other', name: 'Boss', rigId: 'critter-core' }));
    const errors = collect(bus, 'error');
    io.loadEditorBlob.mockClear();

    await ctrl.switchTo('other');

    expect(errors).toEqual(["\"Boss\" was authored for rig 'critter-core' — can't open it under this session's 'orb-core' rig."]);
    expect(io.loadEditorBlob).not.toHaveBeenCalled();
  });

  it('flushes pending edits on the outgoing project before loading the new one', async () => {
    const { ctrl, bus, store, io } = build({ metas: [meta({ id: 'p1' }), meta({ id: 'p2', name: 'Two' })] });
    await ctrl.bootstrap(); // activates p1
    bus.emit('kf:change'); // dirty p1
    io.buildEditorBlob.mockClear();

    await ctrl.switchTo('p2');

    expect(io.buildEditorBlob).toHaveBeenCalledTimes(1); // the flush's save
    expect(store.blobs.get('p1')).toBeInstanceOf(Blob);
    expect(ctrl.activeId).toBe('p2');
  });

  it('sets autosave:state to "saved" after a successful switch', async () => {
    const { ctrl, bus } = build({ metas: [meta({ id: 'p1' }), meta({ id: 'p2', name: 'Two' })] });
    await ctrl.bootstrap();
    const states = collect(bus, 'autosave:state');

    await ctrl.switchTo('p2');

    expect(states).toContain('saved');
  });
});

// ── createNew / duplicate / rename / remove ───────────────────────────────────

describe('AutoSaveController.createNew', () => {
  it('resets to defaults and persists a brand-new project under the given name', async () => {
    const { ctrl, bus, resetToDefaults, store } = build({ metas: [meta({ id: 'p1' })] });
    await ctrl.bootstrap();
    resetToDefaults.mockClear();
    const lists = collect(bus, 'project:list');

    await ctrl.createNew('Second Character');

    expect(resetToDefaults).toHaveBeenCalledTimes(1);
    expect(ctrl.activeName).toBe('Second Character');
    expect(store.metas.size).toBe(2);
    expect(lists.length).toBeGreaterThan(0);
  });
});

describe('AutoSaveController.duplicate', () => {
  it('does nothing when there is no active project', async () => {
    const { ctrl, io } = build();
    // Deliberately never call bootstrap(), so currentId stays null.
    await ctrl.duplicate();
    expect(io.buildEditorBlob).not.toHaveBeenCalled();
  });

  it('creates a copy named "<name> copy" from the current project', async () => {
    const { ctrl, store } = build({ metas: [meta({ id: 'p1', name: 'Hero' })] });
    await ctrl.bootstrap();

    await ctrl.duplicate();

    expect(ctrl.activeName).toBe('Hero copy');
    expect(store.metas.size).toBe(2);
  });
});

describe('AutoSaveController.rename', () => {
  it('does nothing when there is no active project', async () => {
    const { ctrl, store } = build();
    await ctrl.rename('New Name');
    expect(store.metas.size).toBe(0);
  });

  it('does nothing when the name is empty', async () => {
    const { ctrl } = build({ metas: [meta({ id: 'p1', name: 'Hero' })] });
    await ctrl.bootstrap();

    await ctrl.rename('');

    expect(ctrl.activeName).toBe('Hero');
  });

  it('updates the active project\'s name and re-stamps rigId', async () => {
    const { ctrl, bus, store } = build({ metas: [meta({ id: 'p1', name: 'Hero' })] });
    await ctrl.bootstrap();
    const actives = collect(bus, 'project:active');

    await ctrl.rename('Champion');

    expect(ctrl.activeName).toBe('Champion');
    expect(store.metas.get('p1')?.name).toBe('Champion');
    expect(store.metas.get('p1')?.rigId).toBe(RIG_ID);
    expect(actives).toEqual([{ id: 'p1', name: 'Champion' }]);
  });
});

describe('AutoSaveController.remove', () => {
  it('does nothing when there is no active project', async () => {
    const { ctrl, store } = build();
    await ctrl.remove();
    expect(store.metas.size).toBe(0);
  });

  it('deletes the active project and switches to another one for this rig if available', async () => {
    const { ctrl, store } = build({ metas: [meta({ id: 'p1', name: 'First' }), meta({ id: 'p2', name: 'Second' })] });
    await ctrl.bootstrap();
    await ctrl.switchTo('p1'); // make sure p1 (not p2) ends up active, regardless of tie-break order



    await ctrl.remove();

    expect(store.metas.has('p1')).toBe(false);
    expect(ctrl.activeId).toBe('p2');
  });

  it('falls back to a fresh Untitled project when removing the last one for this rig', async () => {
    const { ctrl, store, resetToDefaults } = build({ metas: [meta({ id: 'p1', name: 'Only' })] });
    await ctrl.bootstrap();
    resetToDefaults.mockClear();

    await ctrl.remove();

    expect(store.metas.has('p1')).toBe(false);
    expect(resetToDefaults).toHaveBeenCalledTimes(1);
    expect(ctrl.activeName).toBe('Untitled');
  });

  it('cancels any pending debounced save for the project being removed', async () => {
    // Two projects so remove() switches to the other one (io.loadEditorBlob) rather
    // than falling back to "create a fresh Untitled" (which would itself call
    // io.buildEditorBlob and be indistinguishable from a leaked debounce timer).
    const { ctrl, bus, io } = build({ metas: [meta({ id: 'p1' }), meta({ id: 'p2', name: 'Two' })] });
    await ctrl.bootstrap();
    await ctrl.switchTo('p1');
    bus.emit('kf:change'); // schedules a debounced save for p1
    io.buildEditorBlob.mockClear();

    await ctrl.remove();
    await vi.advanceTimersByTimeAsync(2000); // past the debounce window

    // The pending timer for the removed project must not have fired a save.
    expect(io.buildEditorBlob).not.toHaveBeenCalled();
    expect(ctrl.activeId).toBe('p2');
  });
});

// ── Dirty-event debounce ──────────────────────────────────────────────────────

describe('AutoSaveController — debounced auto-save', () => {
  it('DIRTY_EVENTS lists every event that should trigger a save', () => {
    expect(DIRTY_EVENTS).toEqual(
      expect.arrayContaining(['kf:change', 'binding:change', 'attachment:change', 'rig:change', 'anim:list', 'images:change']),
    );
  });

  it('marks the project dirty immediately, then flushes after the debounce window', async () => {
    const { ctrl, bus, store, io } = build({ metas: [meta({ id: 'p1' })] });
    await ctrl.bootstrap();
    io.buildEditorBlob.mockClear();
    const states = collect(bus, 'autosave:state');

    bus.emit('binding:change', 'shell');

    expect(states).toEqual(['dirty']);
    expect(io.buildEditorBlob).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1500);

    expect(io.buildEditorBlob).toHaveBeenCalledTimes(1);
    expect(store.blobs.get('p1')).toBeInstanceOf(Blob);
    expect(states).toEqual(['dirty', 'saving', 'saved']);
  });

  it('coalesces rapid-fire dirty events into a single debounced save', async () => {
    const { ctrl, bus, io } = build({ metas: [meta({ id: 'p1' })] });
    await ctrl.bootstrap();
    io.buildEditorBlob.mockClear();

    bus.emit('kf:change');
    await vi.advanceTimersByTimeAsync(1000);
    bus.emit('kf:change'); // resets the debounce timer before it fires
    await vi.advanceTimersByTimeAsync(1000);
    bus.emit('kf:change');
    await vi.advanceTimersByTimeAsync(1500);

    expect(io.buildEditorBlob).toHaveBeenCalledTimes(1);
  });

  it('does not schedule a save while a programmatic load is in progress', async () => {
    const { ctrl, bus, io } = build({ metas: [meta({ id: 'p1' }), meta({ id: 'p2', name: 'Two' })] });
    await ctrl.bootstrap();
    io.buildEditorBlob.mockClear();

    // switchTo() runs io.loadEditorBlob inside runSuspended(); any dirty events the
    // load itself fires (e.g. anim:list) must not schedule an auto-save.
    io.loadEditorBlob.mockImplementation(async () => { bus.emit('anim:list'); });
    await ctrl.switchTo('p2');
    io.buildEditorBlob.mockClear();
    await vi.advanceTimersByTimeAsync(2000);

    expect(io.buildEditorBlob).not.toHaveBeenCalled();
  });

  it('emits an error and leaves the project dirty when the save itself fails', async () => {
    const { ctrl, bus, io } = build({ metas: [meta({ id: 'p1' })] });
    await ctrl.bootstrap();
    const errors = collect(bus, 'error');
    io.buildEditorBlob.mockRejectedValueOnce(new Error('quota exceeded'));

    bus.emit('kf:change');
    await vi.advanceTimersByTimeAsync(1500);

    expect(errors).toEqual(['Auto-save failed: quota exceeded']);
  });
});

// ── Best-effort flush on tab hide / page close ────────────────────────────────

describe('AutoSaveController — flush on visibilitychange/beforeunload', () => {
  it('flushes immediately when the tab becomes hidden', async () => {
    const { ctrl, bus, io } = build({ metas: [meta({ id: 'p1' })] });
    await ctrl.bootstrap();
    io.buildEditorBlob.mockClear();
    bus.emit('kf:change');

    visibilityState = 'hidden';
    fireDoc('visibilitychange');
    await Promise.resolve(); // let the fire-and-forget flushNow() promise settle

    expect(io.buildEditorBlob).toHaveBeenCalledTimes(1);
  });

  it('does not flush on visibilitychange when the tab becomes visible again', async () => {
    const { ctrl, io } = build({ metas: [meta({ id: 'p1' })] });
    await ctrl.bootstrap();
    io.buildEditorBlob.mockClear();

    visibilityState = 'visible';
    fireDoc('visibilitychange');
    await Promise.resolve();

    expect(io.buildEditorBlob).not.toHaveBeenCalled();
  });

  it('flushes on beforeunload', async () => {
    const { ctrl, bus, io } = build({ metas: [meta({ id: 'p1' })] });
    await ctrl.bootstrap();
    io.buildEditorBlob.mockClear();
    bus.emit('rig:change');

    fireWin('beforeunload');
    await Promise.resolve();

    expect(io.buildEditorBlob).toHaveBeenCalledTimes(1);
  });
});
