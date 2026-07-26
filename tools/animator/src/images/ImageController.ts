import * as PIXI from 'pixi.js';
import type { EventBus, AppEvents } from '../core/EventBus';
import type { Rig } from '../skeleton/Rig';

// ── Filename → slot auto-detection ───────────────────────────────────────────

function normalize(name: string): string {
  return name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[-\s]/g, '_');
}

// ── ImageController ───────────────────────────────────────────────────────────
// One image slot per bone (root excluded — it has no sprite). The shadow is
// never authored as an image: it's a unified soft ellipse the runtime draws
// procedurally from the shadow attachment point's shadowW/H (see Renderer).
// Slot ids and default z-order both derive from the active Rig, so a different
// rig (a crystal-critter, a boss-core) needs no changes here — only new data.

export class ImageController {
  private readonly _textures     = new Map<string, PIXI.Texture>();
  private readonly _baseTextures = new Map<string, PIXI.BaseTexture>();
  private readonly _blobs        = new Map<string, Blob>();    // for export
  private readonly _names        = new Map<string, string>();  // display filename

  constructor(
    private readonly bus: EventBus<AppEvents>,
    private readonly rig: Rig,
  ) {}

  /** All image slots (every bone but root). */
  get allSlots(): readonly string[] { return this.rig.selectableBones; }

  /** Default render layer order for bone sprites (higher = in front), derived
   *  from the rig's drawOrder — the first entry renders furthest back. */
  get defaultZOrder(): Record<string, number> {
    const order: Record<string, number> = {};
    this.rig.drawOrder.forEach((id, i) => { order[id] = i; });
    return order;
  }

  private guessSlot(filename: string): string | null {
    const base = normalize(filename);
    for (const slot of this.allSlots) {
      if (base === slot) return slot;
    }
    return null;
  }

  // ── Accessors ───────────────────────────────────────────────────────────────

  getTexture(slotId: string): PIXI.Texture | undefined {
    return this._textures.get(slotId);
  }

  getFilename(slotId: string): string | undefined {
    return this._names.get(slotId);
  }

  getBlob(slotId: string): Blob | undefined {
    return this._blobs.get(slotId);
  }

  /** True when every bone slot has a texture loaded. */
  hasAllBoneImages(): boolean {
    return this.allSlots.every(s => this._textures.has(s));
  }

  // ── Load individual file ────────────────────────────────────────────────────

  async setImage(slotId: string, file: File): Promise<void> {
    return this.setBlob(slotId, file, file.name);
  }

  /** Load a Blob (File or extracted sub-image) into a slot. */
  async setBlob(slotId: string, blob: Blob, displayName: string): Promise<void> {
    this.clearSlot(slotId);

    const url  = URL.createObjectURL(blob);
    const base = PIXI.BaseTexture.from(url);
    const tex  = new PIXI.Texture(base);

    this._blobs.set(slotId, blob);
    this._names.set(slotId, displayName);
    this._textures.set(slotId, tex);
    this._baseTextures.set(slotId, base);

    // Wait for texture to load so width/height are available for export
    await new Promise<void>(resolve => {
      if (base.valid) { resolve(); return; }
      base.on('loaded', () => resolve());
      base.on('error',  () => resolve()); // resolve anyway, export will skip
    });

    this.bus.emit('images:change', slotId);
    this.bus.emit('status', `Loaded ${displayName} → ${slotId}`);
  }

  // ── Bulk import from FileList ───────────────────────────────────────────────

  async importFiles(files: FileList | File[]): Promise<void> {
    const arr = Array.from(files);
    for (const file of arr) {
      const slot = this.guessSlot(file.name);
      if (slot) {
        await this.setImage(slot, file);
      } else {
        this.bus.emit('error', `Cannot auto-detect slot for "${file.name}" — assign manually`);
      }
    }
  }

  // ── Remove ──────────────────────────────────────────────────────────────────

  removeImage(slotId: string): void {
    if (!this._textures.has(slotId)) return;
    this.clearSlot(slotId);
    this.bus.emit('images:change', slotId);
  }

  /** Remove every loaded image (used when switching / creating projects). */
  clearAll(): void {
    for (const slotId of [...this._textures.keys()]) {
      this.clearSlot(slotId);
      this.bus.emit('images:change', slotId);
    }
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private clearSlot(slotId: string): void {
    const tex  = this._textures.get(slotId);
    const base = this._baseTextures.get(slotId);
    if (tex)  { tex.destroy(false);  this._textures.delete(slotId); }
    if (base) { base.destroy();      this._baseTextures.delete(slotId); }

    const blob = this._blobs.get(slotId);
    if (blob) {
      // If it's an object-URL-backed blob, revoke; File objects don't need this
      // but revoking a File's URL is harmless
      this._blobs.delete(slotId);
    }
    this._names.delete(slotId);
  }

  destroy(): void {
    for (const slotId of [...this._textures.keys()]) {
      this.clearSlot(slotId);
    }
  }
}
