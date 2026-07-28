import JSZip from 'jszip';
import type { AppState } from '../core/AppState';
import type { AnimationController } from '../animation/AnimationController';
import type { ImageController } from '../images/ImageController';
import type { CommandManager } from '../core/CommandManager';
import type { EventBus, AppEvents } from '../core/EventBus';
import type { AttachmentPoint, SpriteBinding } from '../core/types';
import { serializeClip, deserializeClip, type SerializedClip } from './clipSerialization';
import { saveWithPicker } from './ioUtils';

// ── Editor project format (version 1) ────────────────────────────────────────

interface EditorProject {
  version:          1;
  selectedClip:     string | null;
  previewMode:      'skeleton' | 'sprite';
  bindings:         Record<string, SpriteBinding>;
  animations:       Record<string, SerializedClip>;
  attachmentPoints: AttachmentPoint[];
  boneLengthScales?: Record<string, number>;   // per-bone length multipliers; absent = all 1.0
  /** Which variant id each slot's `images/<slotId>.png` file represents (e.g.
   *  eye's `front`/`back` facing swap, design/12) — absent or missing entry
   *  defaults to 'default'. Extra (non-active) variants ride in the same
   *  images/ folder as `images/<slotId>__<variantId>.png`. */
  activeVariantIds?: Record<string, string>;
}

/**
 * `.editortao` project save/load — split out of IOController.ts 2026-07-28. Owns the
 * editor-only project format (full animator state: bindings, clips, attachments, every
 * loaded image variant); TaoExporter owns the separate `.tao` runtime bundle format.
 */
export class EditorProjectIO {
  constructor(
    private readonly state:      AppState,
    private readonly animCtrl:   AnimationController,
    private readonly imageCtrl:  ImageController,
    private readonly cmdManager: CommandManager,
    private readonly bus:        EventBus<AppEvents>,
  ) {}

  /** Build the `.editortao` archive (editor.json + per-slot PNGs) as a Blob.
   *  Shared by the manual "Save .editor" button and the IndexedDB auto-save. */
  async buildEditorBlob(): Promise<Blob> {
    const zip = new JSZip();

    // editor.json — all project data + editor state
    const animations: Record<string, SerializedClip> = {};
    this.animCtrl.store.forEach((clip, name) => {
      animations[name] = serializeClip(clip);
    });

    const bindings: Record<string, SpriteBinding> = {};
    this.state.boneBindings.forEach((b, id) => { bindings[id] = { ...b }; });

    const attachmentPoints: AttachmentPoint[] = [];
    this.state.attachmentPoints.forEach(pt => attachmentPoints.push({ ...pt }));

    const boneLengthScales: Record<string, number> = {};
    this.state.boneLengthScales.forEach((v, k) => { boneLengthScales[k] = v; });

    // images/ — one PNG per loaded slot variant (lossless, no spritesheet
    // packing): the active variant as `<slotId>.png` (unchanged shape for a
    // single-variant slot — a project with no variants round-trips byte-for-byte
    // like before), any stashed alternates as `<slotId>__<variantId>.png`.
    const activeVariantIds: Record<string, string> = {};
    const imgFolder = zip.folder('images')!;
    for (const slotId of this.state.boneBindings.keys()) {
      const entries = this.imageCtrl.getAllVariantEntries(slotId);
      if (entries.length === 0) continue;
      activeVariantIds[slotId] = this.imageCtrl.getActiveVariantId(slotId);
      for (const { variantId, blob } of entries) {
        const filename = variantId === activeVariantIds[slotId] ? `${slotId}.png` : `${slotId}__${variantId}.png`;
        imgFolder.file(filename, blob);
      }
    }

    const editorJson: EditorProject = {
      version:          1,
      selectedClip:     this.animCtrl.currentName,
      previewMode:      this.state.previewMode,
      bindings,
      animations,
      attachmentPoints,
      ...(Object.keys(boneLengthScales).length > 0 && { boneLengthScales }),
      ...(Object.keys(activeVariantIds).length > 0 && { activeVariantIds }),
    };
    zip.file('editor.json', JSON.stringify(editorJson, null, 2));

    return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  }

  async saveEditorProject(): Promise<void> {
    this.bus.emit('status', 'Saving .editortao…');
    try {
      const blob = await this.buildEditorBlob();
      await saveWithPicker(blob, 'project', [
        { description: 'Tao Editor Project', accept: { 'application/octet-stream': ['.editortao'] } },
      ]);
      this.bus.emit('status', 'Project saved');
    } catch (err) {
      this.bus.emit('error', `Save failed: ${(err as Error).message}`);
    }
  }

  loadEditorProject(file: File): Promise<void> {
    return this.loadEditorBlob(file, file.name);
  }

  /** Restore editor state from a `.editortao` archive (File or Blob).
   *  Used by both the manual "Load .editor" button and project switching. */
  async loadEditorBlob(data: Blob, label: string): Promise<void> {
    this.bus.emit('status', `Loading ${label}…`);
    try {
      const zip = await JSZip.loadAsync(data);

      const jsonFile = zip.file('editor.json');
      if (!jsonFile) throw new Error('editor.json missing from archive');
      const project = JSON.parse(await jsonFile.async('string')) as EditorProject;

      if (project.version !== 1) {
        this.bus.emit('error', `Unsupported editor version ${project.version}`);
        return;
      }

      // Clear existing state. imageCtrl.clearAll() matters even though every
      // image gets overwritten below by slotId — a slot the NEW project never
      // binds (or a variant it never mentions) would otherwise leak forward
      // from whatever project was loaded before this one (pre-existing gap,
      // surfaced by variant bookkeeping which has no per-slot "this project
      // doesn't use this slot" signal otherwise).
      this.animCtrl.clearAll();
      [...this.state.boneBindings.keys()].forEach(id => this.state.removeBinding(id));
      this.imageCtrl.clearAll();

      // Restore animations + bindings + attachments + rig
      for (const [boneId, binding] of Object.entries(project.bindings)) {
        this.state.setBinding(boneId, binding);
      }
      if (Array.isArray(project.attachmentPoints) && project.attachmentPoints.length > 0) {
        this.state.setAllAttachmentPoints(project.attachmentPoints);
      }
      this.state.setAllLengthScales(project.boneLengthScales ?? {});
      for (const [name, clip] of Object.entries(project.animations)) {
        this.animCtrl.loadClip(name, deserializeClip(clip));
      }

      // Restore individual images — `<slotId>.png` is the active variant,
      // `<slotId>__<variantId>.png` is a stashed alternate (see EditorProject
      // doc comment). "::" is ImageController's internal key delimiter; "__"
      // (double underscore) is this on-disk filename's delimiter — kept
      // distinct so a bug in one representation can't silently corrupt the
      // other. Variants must be loaded via setVariantBlob (not setBlob), and
      // the active-variant labels applied AFTER every image loads, so load
      // order can never clobber which one is "the" live texture.
      const imgFolder = zip.folder('images');
      if (imgFolder) {
        const imagePromises: Promise<void>[] = [];
        imgFolder.forEach((relativePath, zipEntry) => {
          if (zipEntry.dir) return;
          const variantMatch = relativePath.match(/^(.+)__(.+)\.png$/i);
          if (variantMatch) {
            const [, slotId, variantId] = variantMatch;
            imagePromises.push(
              zipEntry.async('blob').then(blob => this.imageCtrl.setVariantBlob(slotId!, variantId!, blob, relativePath)),
            );
          } else {
            const slotId = relativePath.replace(/\.png$/i, '');
            imagePromises.push(
              zipEntry.async('blob').then(blob => this.imageCtrl.setBlob(slotId, blob, `${slotId}.png`)),
            );
          }
        });
        await Promise.all(imagePromises);
        for (const [slotId, variantId] of Object.entries(project.activeVariantIds ?? {})) {
          this.imageCtrl.setActiveVariantLabel(slotId, variantId);
        }
      }

      // Restore editor state
      this.state.setPreviewMode(project.previewMode ?? 'skeleton');
      this.cmdManager.clear();
      this.bus.emit('anim:list');

      const clipToSelect = project.selectedClip ?? [...this.animCtrl.store.keys()][0];
      if (clipToSelect) this.animCtrl.selectClip(clipToSelect);

      this.bus.emit('status', `Loaded ${label}`);
    } catch (err) {
      this.bus.emit('error', `Load failed: ${(err as Error).message}`);
    }
  }
}
