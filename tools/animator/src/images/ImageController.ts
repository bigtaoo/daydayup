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

  // ── Variants ──────────────────────────────────────────────────────────────
  // A bone slot's LIVE texture (above) is always exactly one image — the
  // renderer/export code never needs to know about variants at all. A "variant"
  // (e.g. eye's `front`/`back` facing swap, design/12) is an alternate source
  // image for the same slot, held here as an inert Blob until `setActiveVariant`
  // promotes it into the live slot (demoting whatever was live into a variant in
  // exchange, so switching back and forth never loses data). Keyed by
  // `${slotId}::${variantId}` — slot/variant ids never contain "::" (bone ids
  // come from RigDef, variant ids are short user-typed labels), so this is an
  // unambiguous compound key, not a real delimiter concern.
  private readonly _variantBlobs   = new Map<string, Blob>();
  private readonly _variantNames   = new Map<string, string>();
  private readonly _activeVariantId = new Map<string, string>(); // slotId -> variant id of the current live texture

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

  // ── Variants ────────────────────────────────────────────────────────────────

  /** The variant id backing the slot's current LIVE texture ('default' if the
   *  slot has never been given an explicit variant label). */
  getActiveVariantId(slotId: string): string {
    return this._activeVariantId.get(slotId) ?? 'default';
  }

  /** Every variant id known for a slot — the active one first, then any stashed
   *  alternates. A slot with only ever one image returns `['default']`. */
  getVariantIds(slotId: string): string[] {
    const prefix = `${slotId}::`;
    const stored = [...this._variantBlobs.keys()]
      .filter(k => k.startsWith(prefix))
      .map(k => k.slice(prefix.length));
    return [this.getActiveVariantId(slotId), ...stored];
  }

  /** Record which variant id the slot's ALREADY-loaded live texture represents,
   *  without touching the texture itself. Used only when restoring a saved
   *  project (the live PNG is loaded via the ordinary `setBlob` path already;
   *  this just re-attaches its label). */
  setActiveVariantLabel(slotId: string, variantId: string): void {
    this._activeVariantId.set(slotId, variantId);
    this.bus.emit('images:change', slotId);
  }

  /** Add or replace a variant's source image WITHOUT displaying it — stored
   *  inert until `setActiveVariant` promotes it into the live slot. */
  setVariantBlob(slotId: string, variantId: string, blob: Blob, displayName: string): void {
    const key = `${slotId}::${variantId}`;
    this._variantBlobs.set(key, blob);
    this._variantNames.set(key, displayName);
    this.bus.emit('images:change', slotId);
  }

  getVariantBlob(slotId: string, variantId: string): Blob | undefined {
    if (variantId === this.getActiveVariantId(slotId)) return this._blobs.get(slotId);
    return this._variantBlobs.get(`${slotId}::${variantId}`);
  }

  /** Every variant of a slot with a REAL blob attached (active + stashed),
   *  for IOController's save/export loops — the active one always comes first. */
  getAllVariantEntries(slotId: string): Array<{ variantId: string; blob: Blob; displayName: string }> {
    const out: Array<{ variantId: string; blob: Blob; displayName: string }> = [];
    const activeBlob = this._blobs.get(slotId);
    if (activeBlob) {
      out.push({
        variantId:   this.getActiveVariantId(slotId),
        blob:        activeBlob,
        displayName: this._names.get(slotId) ?? `${slotId}.png`,
      });
    }
    const prefix = `${slotId}::`;
    for (const [key, blob] of this._variantBlobs) {
      if (!key.startsWith(prefix)) continue;
      const variantId = key.slice(prefix.length);
      out.push({ variantId, blob, displayName: this._variantNames.get(key) ?? `${variantId}.png` });
    }
    return out;
  }

  /** Remove a stashed (non-active) variant. No-op on the active variant —
   *  use `removeImage` to clear the whole slot instead. */
  removeVariant(slotId: string, variantId: string): void {
    if (variantId === this.getActiveVariantId(slotId)) return;
    const key = `${slotId}::${variantId}`;
    this._variantBlobs.delete(key);
    this._variantNames.delete(key);
    this.bus.emit('images:change', slotId);
  }

  /** Swap which variant is the slot's live texture: demotes the outgoing
   *  texture into a stashed variant (under its own current label) and promotes
   *  the target variant's blob into the live slot. No-op if the variant is
   *  already active or unknown. */
  async setActiveVariant(slotId: string, variantId: string): Promise<void> {
    if (variantId === this.getActiveVariantId(slotId)) return;
    const targetKey  = `${slotId}::${variantId}`;
    const targetBlob = this._variantBlobs.get(targetKey);
    if (!targetBlob) return;
    const targetName = this._variantNames.get(targetKey) ?? `${variantId}.png`;

    const curBlob = this._blobs.get(slotId);
    if (curBlob) {
      const curVariantId = this.getActiveVariantId(slotId);
      const curKey = `${slotId}::${curVariantId}`;
      this._variantBlobs.set(curKey, curBlob);
      this._variantNames.set(curKey, this._names.get(slotId) ?? `${curVariantId}.png`);
    }
    this._variantBlobs.delete(targetKey);
    this._variantNames.delete(targetKey);
    this._activeVariantId.set(slotId, variantId);

    await this.setBlob(slotId, targetBlob, targetName);
  }

  /** Clear every stashed variant (and the active-variant label) for a slot —
   *  used when the slot's image is removed entirely or a project resets. Does
   *  NOT touch the live texture; pair with `clearSlot`/`removeImage`. */
  private clearVariants(slotId: string): void {
    const prefix = `${slotId}::`;
    for (const key of [...this._variantBlobs.keys()]) {
      if (!key.startsWith(prefix)) continue;
      this._variantBlobs.delete(key);
      this._variantNames.delete(key);
    }
    this._activeVariantId.delete(slotId);
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
    this.clearVariants(slotId);
    this.bus.emit('images:change', slotId);
  }

  /** Remove every loaded image (used when switching / creating projects). */
  clearAll(): void {
    const slots = new Set([...this._textures.keys(), ...this._activeVariantId.keys()]);
    for (const key of this._variantBlobs.keys()) slots.add(key.split('::')[0]!);
    for (const slotId of slots) {
      this.clearSlot(slotId);
      this.clearVariants(slotId);
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
      this.clearVariants(slotId);
    }
  }
}
