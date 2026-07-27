import type { EventBus, AppEvents } from '../core/EventBus';
import type { IOController } from './IOController';
import { ProjectStore, type ProjectMeta } from './ProjectStore';

// ── AutoSaveController ────────────────────────────────────────────────────────
// Owns the "currently open project" and silently persists it to IndexedDB.
//
// • Listens for any state-mutating event and debounces a save into the active
//   project's record (no save dialog, no file picker).
// • Manages a library of named projects so the artist can keep many characters
//   and switch between them via the project dropdown.
// • Remembers the last-open project (localStorage) and restores it on startup.
//
// The manual "Save .editor" / "Load .editor" buttons remain for exporting a
// real file to disk — auto-save is the in-browser safety net on top of that.

const LS_ACTIVE_KEY = 'dd-animator:activeProject';
const DEBOUNCE_MS   = 1500;

/** Events whose firing means the project content changed and should be saved. */
export const DIRTY_EVENTS: ReadonlyArray<keyof AppEvents> = [
  'kf:change', 'binding:change', 'attachment:change', 'rig:change', 'anim:list', 'images:change',
];

function genId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `p_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export class AutoSaveController {
  private currentId:   string | null = null;
  private currentName  = 'Untitled';
  private loading      = false;   // true while a programmatic load is mutating state
  private dirty        = false;
  private saveTimer:   number | null = null;

  constructor(
    private readonly store: ProjectStore,
    private readonly io:    IOController,
    private readonly bus:   EventBus<AppEvents>,
    /** Resets app state to a blank default character (presets + default rig). */
    private readonly resetToDefaults: () => void,
    /** The RigDef this running app instance is fixed to (App.ts's `?rig=` picker,
     *  set once at page load and never changed at runtime) — every project this
     *  session touches is stamped/filtered against it, so a project authored for
     *  one rig's bone set can never silently load its bindings under another rig's
     *  Rig instance (bone ids that don't exist would just be dropped, quietly
     *  blanking the character). */
    private readonly rigId: string,
  ) {
    const schedule = () => this.scheduleSave();
    for (const ev of DIRTY_EVENTS) this.bus.on(ev, schedule);

    // Best-effort flush when the tab is hidden or closed — more reliable than
    // relying solely on the debounce timer surviving a page close.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void this.flushNow();
    });
    window.addEventListener('beforeunload', () => { void this.flushNow(); });
  }

  get activeId():   string | null { return this.currentId; }
  get activeName(): string        { return this.currentName; }

  // ── Startup ─────────────────────────────────────────────────────────────────

  /** Restore the last-open project, or adopt the current preset state as a new one.
   *  Only ever considers projects stamped for THIS session's rig — restoring a
   *  different-rig project by id would silently blank the character (its bindings
   *  reference bone ids this rig doesn't have). */
  async bootstrap(): Promise<void> {
    const metas  = await this.listMetaForCurrentRig();
    const lastId = localStorage.getItem(LS_ACTIVE_KEY);
    const target = metas.find(m => m.id === lastId) ?? metas[0];

    if (target) {
      await this.switchTo(target.id);
    } else {
      // Empty library (for this rig): persist whatever the app booted with as "Untitled".
      await this.runSuspended(() => this.resetToDefaults());
      await this.createFromCurrent('Untitled');
    }
    this.bus.emit('project:list');
  }

  // ── Library operations (called by ProjectPanel) ──────────────────────────────

  /** All saved projects whose `rigId` matches this session's rig (a missing
   *  `rigId` — a record saved before this field existed — is treated as
   *  'orb-core', the only rig any pre-existing project could have been saved
   *  under). Use this instead of `store.listMeta()` anywhere a project might get
   *  opened/restored, so a mismatched project is never even offered. */
  async listMetaForCurrentRig(): Promise<ProjectMeta[]> {
    const metas = await this.store.listMeta();
    return metas.filter(m => (m.rigId ?? 'orb-core') === this.rigId);
  }

  async switchTo(id: string): Promise<void> {
    if (id === this.currentId) return;

    const meta = (await this.store.listMeta()).find(m => m.id === id);
    if (!meta) { this.bus.emit('error', 'Project not found'); return; }
    const metaRigId = meta.rigId ?? 'orb-core';
    if (metaRigId !== this.rigId) {
      this.bus.emit(
        'error',
        `"${meta.name}" was authored for rig '${metaRigId}' — can't open it under this session's '${this.rigId}' rig.`,
      );
      return;
    }

    await this.flushNow();   // persist edits to the project we're leaving

    const blob = await this.store.getBlob(id);
    if (!blob) { this.bus.emit('error', 'Project not found'); return; }

    await this.runSuspended(() => this.io.loadEditorBlob(blob, meta.name));
    this.setActive(id, meta.name);
    this.bus.emit('autosave:state', 'saved');
  }

  async createNew(name: string): Promise<void> {
    await this.flushNow();
    await this.runSuspended(() => this.resetToDefaults());
    await this.createFromCurrent(name);
    this.bus.emit('project:list');
  }

  async duplicate(): Promise<void> {
    if (!this.currentId) return;
    await this.flushNow();
    await this.createFromCurrent(`${this.currentName} copy`);
    this.bus.emit('project:list');
  }

  async rename(name: string): Promise<void> {
    if (!this.currentId || !name) return;
    this.currentName = name;
    // Same `put`-replaces-the-record caveat as flush() above — re-stamp rigId.
    await this.store.putMeta({ id: this.currentId, name, updatedAt: Date.now(), rigId: this.rigId });
    this.bus.emit('project:active', { id: this.currentId, name });
    this.bus.emit('project:list');
  }

  async remove(): Promise<void> {
    if (!this.currentId) return;
    // Drop any pending save for the project being deleted.
    if (this.saveTimer !== null) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.dirty = false;

    await this.store.delete(this.currentId);
    this.currentId = null;

    const metas = await this.listMetaForCurrentRig();
    if (metas[0]) {
      await this.switchTo(metas[0].id);
    } else {
      await this.runSuspended(() => this.resetToDefaults());
      await this.createFromCurrent('Untitled');
    }
    this.bus.emit('project:list');
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async createFromCurrent(name: string): Promise<void> {
    const id   = genId();
    const blob = await this.io.buildEditorBlob();
    await this.store.put({ id, name, updatedAt: Date.now(), rigId: this.rigId }, blob);
    this.setActive(id, name);
  }

  private setActive(id: string, name: string): void {
    this.currentId   = id;
    this.currentName = name;
    this.dirty       = false;
    localStorage.setItem(LS_ACTIVE_KEY, id);
    this.bus.emit('project:active', { id, name });
  }

  private scheduleSave(): void {
    if (this.loading || !this.currentId) return;
    this.dirty = true;
    this.bus.emit('autosave:state', 'dirty');
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => { void this.flush(); }, DEBOUNCE_MS);
  }

  private async flush(): Promise<void> {
    this.saveTimer = null;
    if (!this.currentId || !this.dirty) return;
    this.bus.emit('autosave:state', 'saving');
    try {
      const blob = await this.io.buildEditorBlob();
      // `put` replaces the whole meta record (IndexedDB, not a partial merge) — rigId
      // must be re-stamped every save or it silently disappears on the next flush.
      await this.store.put({ id: this.currentId, name: this.currentName, updatedAt: Date.now(), rigId: this.rigId }, blob);
      this.dirty = false;
      this.bus.emit('autosave:state', 'saved');
      this.bus.emit('project:list');   // updatedAt changed → reorder dropdown
    } catch (err) {
      this.bus.emit('error', `Auto-save failed: ${(err as Error).message}`);
    }
  }

  /** Cancel the debounce and flush immediately if there are unsaved edits. */
  private async flushNow(): Promise<void> {
    if (this.saveTimer !== null) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (this.dirty) await this.flush();
  }

  /** Run a state-mutating block with auto-save scheduling suspended. */
  private async runSuspended(fn: () => void | Promise<void>): Promise<void> {
    this.loading = true;
    try { await fn(); } finally { this.loading = false; }
  }
}
