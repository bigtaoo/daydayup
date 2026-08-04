import JSZip from 'jszip';
import type { AppState } from '../core/AppState';
import type { AnimationController } from '../animation/AnimationController';
import type { ImageController } from '../images/ImageController';
import type { CommandManager } from '../core/CommandManager';
import type { EventBus, AppEvents } from '../core/EventBus';
import type { AttachmentPoint, SpriteBinding } from '../core/types';
import type { Rig } from '../skeleton/Rig';
import { TARGET_SCREEN_PX, SUPERSAMPLE, type SizeTierKey } from './unitSize';
import { serializeClip, deserializeClip, type SerializedClip } from './clipSerialization';
import { clamp01, loadImageFromBlob, canvasToBlob, saveWithPicker } from './ioUtils';

// ── Serialization format (version 2) ─────────────────────────────────────────

interface SerializedProject {
  version:           number;
  bindings:          Record<string, SpriteBinding>;
  animations:        Record<string, SerializedClip>;
  attachmentPoints?: AttachmentPoint[];
  boneLengthScales?: Record<string, number>;
  /**
   * Size-tier the textures were baked for. Informational / self-documenting —
   * the runtime sizes units from its own unitSize.ts by UnitType, not from this
   * block. `naturalHeight` is H_nat (animator px) at export time. Absent in
   * pre-bake bundles.
   */
  unitHeight?: {
    tier:           SizeTierKey;
    targetScreenPx: number;
    naturalHeight:  number;
    supersample:    number;
  };
}

// ── Spritesheet types ─────────────────────────────────────────────────────────

interface SpritesheetFrame {
  frame:      { x: number; y: number; w: number; h: number };
  sourceSize: { w: number; h: number };
}

interface SpritesheetJson {
  frames: Record<string, SpritesheetFrame>;
  meta:   { size: { w: number; h: number } };
}

/**
 * `.tao` runtime bundle export/import — split out of IOController.ts 2026-07-28. Owns
 * the baked spritesheet + animation.json format the game runtime actually loads;
 * EditorProjectIO owns the separate `.editortao` full-fidelity project format.
 */
export class TaoExporter {
  constructor(
    private readonly state:      AppState,
    private readonly animCtrl:   AnimationController,
    private readonly imageCtrl:  ImageController,
    private readonly cmdManager: CommandManager,
    private readonly bus:        EventBus<AppEvents>,
    private readonly rig:        Rig,
  ) {}

  // ── Export ────────────────────────────────────────────────────────────────

  /** Build the `.tao` runtime bundle (animation.json + optional spritesheet) as a
   *  Blob, WITHOUT triggering a download. Shared by `exportTao()` (download) and
   *  any future upload path — nothing else in this project can rebuild the
   *  spritesheet, so the browser-built `.tao` must be the single artifact. */
  async buildTaoBlob(): Promise<Blob> {
    // Size tier (export panel) + the rig's natural FK height drive the bake-down to an
    // absolute target resolution rather than the artist's canvas size.
    const tier = this.readExportTier();
    const hNat = this.computeNaturalHeight();
    const animJson = this.buildAnimationJson(tier, hNat);

    // Bake each image down to the resolution it is actually displayed at (target
    // screen height × supersample), then rewrite binding.scaleX/Y to compensate.
    // The game renders sprite.scale = keyframe.scale × binding.scale, so pre-scaling
    // the pixels and dividing binding.scale by the same factor is visually identical
    // while shrinking the spritesheet — no runtime change needed.
    const items = await this.buildExportImages(animJson, tier, hNat);

    const zip = new JSZip();
    zip.file('animation.json', JSON.stringify(animJson, null, 2));

    if (items.length > 0) {
      const { canvas, rects } = await this.buildSpritesheet(items);
      const ssJson = this.buildSpritesheetJson(rects, canvas.width, canvas.height);
      const pngBlob = await canvasToBlob(canvas);

      zip.file('spritesheet.json', JSON.stringify(ssJson, null, 2));
      zip.file('spritesheet.png',  pngBlob);
    }

    return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  }

  async exportTao(): Promise<void> {
    this.bus.emit('status', 'Building .tao…');

    try {
      const blob = await this.buildTaoBlob();
      await saveWithPicker(blob, 'animation', [
        { description: 'Tao Animation', accept: { 'application/octet-stream': ['.tao'] } },
      ]);
      this.bus.emit('status', 'Exported .tao');
    } catch (err) {
      this.bus.emit('error', `Export failed: ${(err as Error).message}`);
    }
  }

  // ── Import ────────────────────────────────────────────────────────────────

  async importTao(file: Blob, name = 'animation.tao'): Promise<void> {
    try {
      const zip = await JSZip.loadAsync(file);

      const animFile = zip.file('animation.json');
      if (!animFile) throw new Error('animation.json missing from archive');
      const project = JSON.parse(await animFile.async('string')) as SerializedProject;

      if (project.version !== 2) {
        this.bus.emit('error', `Unsupported version ${project.version} (expected 2)`);
        return;
      }

      // Restore animation data
      this.restoreAnimationData(project);

      // Restore the export tier dropdown from the bundle's meta (if present) so a
      // round-trip re-export keeps the same tier.
      const tier = project.unitHeight?.tier;
      if (tier) {
        const sel = document.getElementById('sel-export-tier') as HTMLSelectElement | null;
        if (sel) sel.value = tier;
      }

      // Restore images from spritesheet if present
      const ssJsonFile = zip.file('spritesheet.json');
      const ssPngFile  = zip.file('spritesheet.png');

      if (ssJsonFile && ssPngFile) {
        const ssJson = JSON.parse(await ssJsonFile.async('string')) as SpritesheetJson;
        const ssBlob = await ssPngFile.async('blob');
        await this.restoreImagesFromSpritesheet(ssBlob, ssJson);
      }

      this.cmdManager.clear();
      this.bus.emit('anim:list');
      const first = [...this.animCtrl.store.keys()][0];
      if (first) this.animCtrl.selectClip(first);

      this.bus.emit('status', `Loaded ${name}`);
    } catch (err) {
      this.bus.emit('error', `Import failed: ${(err as Error).message}`);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private buildAnimationJson(tier: SizeTierKey, hNat: number): SerializedProject {
    const bindings: Record<string, SpriteBinding> = {};
    this.state.boneBindings.forEach((b, id) => { bindings[id] = { ...b }; });

    const animations: Record<string, SerializedClip> = {};
    this.animCtrl.store.forEach((clip, name) => {
      animations[name] = serializeClip(clip);
    });

    const attachmentPoints: AttachmentPoint[] = [];
    this.state.attachmentPoints.forEach(pt => attachmentPoints.push({ ...pt }));

    const boneLengthScales: Record<string, number> = {};
    this.state.boneLengthScales.forEach((v, k) => { boneLengthScales[k] = v; });

    return {
      version: 2, bindings, animations, attachmentPoints,
      ...(Object.keys(boneLengthScales).length > 0 && { boneLengthScales }),
      unitHeight: {
        tier,
        targetScreenPx: TARGET_SCREEN_PX[tier],
        naturalHeight:  Math.round(hNat),
        supersample:    SUPERSAMPLE,
      },
    };
  }

  private restoreAnimationData(project: SerializedProject): void {
    for (const [boneId, binding] of Object.entries(project.bindings)) {
      this.state.setBinding(boneId, binding);
    }
    if (Array.isArray(project.attachmentPoints) && project.attachmentPoints.length > 0) {
      this.state.setAllAttachmentPoints(project.attachmentPoints);
    }
    for (const [name, clip] of Object.entries(project.animations)) {
      this.animCtrl.loadClip(name, deserializeClip(clip));
    }
  }

  private async restoreImagesFromSpritesheet(
    ssBlob: Blob,
    ssJson: SpritesheetJson,
  ): Promise<void> {
    const img = await loadImageFromBlob(ssBlob);

    // Frame ids follow buildExportImages' naming: bare slotId = the active
    // variant, `${slotId}__${variantId}` = a stashed alternate.
    for (const [frameId, entry] of Object.entries(ssJson.frames)) {
      const { x, y, w, h } = entry.frame;
      const canvas = document.createElement('canvas');
      canvas.width  = w;
      canvas.height = h;
      canvas.getContext('2d')!.drawImage(img, x, y, w, h, 0, 0, w, h);
      const blob = await canvasToBlob(canvas);

      const variantMatch = frameId.match(/^(.+)__(.+)$/);
      if (variantMatch) {
        const [, slotId, variantId] = variantMatch;
        this.imageCtrl.setVariantBlob(slotId!, variantId!, blob, frameId);
      } else {
        await this.imageCtrl.setBlob(frameId, blob, frameId);
      }
    }
  }

  /** Selected export size tier (export panel dropdown), default M. */
  private readExportTier(): SizeTierKey {
    const sel = document.getElementById('sel-export-tier') as HTMLSelectElement | null;
    const v = sel?.value as SizeTierKey | undefined;
    return (v === 'S' || v === 'M' || v === 'L' || v === 'XL') ? v : 'M';
  }

  /** H_nat — the rig's natural FK height (animator px) over rest pose + all keyframes. */
  private computeNaturalHeight(): number {
    return this.rig.computeNaturalHeight(this.animCtrl.store.values(), this.state.boneLengthScales);
  }

  // ── Spritesheet building ──────────────────────────────────────────────────

  /** Fallback bake headroom, used only when H_nat is unknown (no clips → can't anchor
   *  to an absolute target). Bakes at 1.5× the largest displayed size for DPI/animation
   *  headroom — the legacy behaviour before per-tier absolute baking. */
  private static readonly EXPORT_HEADROOM = 1.5;

  /** Bake each loaded image down to the resolution it actually needs, and rewrite the
   *  corresponding binding.scaleX/Y in `animJson` so the on-screen result is unchanged.
   *  The shadow is not packed — it is drawn procedurally by the runtime from the shadow
   *  attachment point's shadowW/H.
   *
   *  The bake is anchored to the ABSOLUTE target display size, not the artist's canvas.
   *  Global factor G = SUPERSAMPLE × TARGET_SCREEN_PX[tier] / H_nat, which folds in BOTH
   *  (1) the unit's real on-screen height and (2) the supersample headroom that replaces
   *  the old guessed 1.5 — so the figure's baked texture footprint becomes exactly
   *  TARGET_SCREEN_PX × SUPERSAMPLE px. Per-bone we still multiply by |binding.scaleX| ×
   *  max-keyframe-scale (a bone shown small / scaled up needs proportionally fewer / more
   *  texels), then compensate binding.scaleX /= bake so the runtime render is
   *  pixel-identical. (Uses SCREEN px, not authoring px: the runtime scales the rig to
   *  TARGET_SCREEN_PX, so anchoring the texture to the same number is what makes
   *  ~SUPERSAMPLE texels land per screen px.) */
  private async buildExportImages(
    animJson: SerializedProject,
    tier: SizeTierKey,
    hNat: number,
  ): Promise<Array<{ id: string; src: CanvasImageSource; w: number; h: number }>> {
    // G replaces the old flat headroom: absolute target resolution per tier.
    const G = hNat > 0
      ? (SUPERSAMPLE * TARGET_SCREEN_PX[tier]) / hNat
      : TaoExporter.EXPORT_HEADROOM;
    const maxKf = this.computeMaxKeyframeScale();
    const out: Array<{ id: string; src: CanvasImageSource; w: number; h: number }> = [];

    // Shadow is no longer packed: it's a unified soft ellipse the runtime draws
    // procedurally from the shadow attachment point's shadowW/H.
    //
    // A slot's binding (anchor/scale/rotation) is shared across ALL of its
    // variants (design/12: a facing swap keeps "the same size and silhouette
    // footprint" specifically so it drops into the identical socket/binding) —
    // so bakeX/Y and the binding.scaleX/Y compensation are computed ONCE per
    // slot, then applied to every variant's own pixel dimensions. The active
    // variant's frame keeps the bare slot id (byte-identical to the pre-variant
    // behaviour when a slot has only ever had one image); a stashed variant's
    // frame is `${slotId}__${variantId}`, for the runtime to pick between at
    // render time (not built yet — see design/12's "deliberately out of this
    // pass" note on the eye front/back swap).
    for (const slotId of this.state.boneBindings.keys()) {
      const entries = this.imageCtrl.getAllVariantEntries(slotId);
      if (entries.length === 0) continue;

      let bakeX = 1, bakeY = 1;
      const binding = animJson.bindings[slotId];
      if (binding) {
        const kf = maxKf.get(slotId) ?? { x: 1, y: 1 };
        bakeX = clamp01(Math.abs(binding.scaleX) * kf.x * G);
        bakeY = clamp01(Math.abs(binding.scaleY) * kf.y * G);
        // Compensate so keyframe.scale × binding.scale renders identical pixels.
        binding.scaleX /= bakeX;
        binding.scaleY /= bakeY;
      }

      const activeVariantId = this.imageCtrl.getActiveVariantId(slotId);
      for (const { variantId, blob } of entries) {
        const img = await loadImageFromBlob(blob);
        const sw  = img.naturalWidth;
        const sh  = img.naturalHeight;
        const frameId = variantId === activeVariantId ? slotId : `${slotId}__${variantId}`;

        if (bakeX > 0.999 && bakeY > 0.999) {
          out.push({ id: frameId, src: img, w: sw, h: sh });
        } else {
          const dw     = Math.max(1, Math.round(sw * bakeX));
          const dh     = Math.max(1, Math.round(sh * bakeY));
          const canvas = document.createElement('canvas');
          canvas.width  = dw;
          canvas.height = dh;
          const ctx = canvas.getContext('2d')!;
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, dw, dh);
          out.push({ id: frameId, src: canvas, w: dw, h: dh });
        }
      }
    }

    return out;
  }

  /** Largest per-axis keyframe scale each bone reaches across all clips (default 1). */
  private computeMaxKeyframeScale(): Map<string, { x: number; y: number }> {
    const max = new Map<string, { x: number; y: number }>();
    this.animCtrl.store.forEach(clip => {
      for (const kf of clip.keyframes) {
        kf.bones.forEach((bkf, boneId) => {
          const cur = max.get(boneId) ?? { x: 1, y: 1 };
          cur.x = Math.max(cur.x, Math.abs(bkf.scaleX ?? 1));
          cur.y = Math.max(cur.y, Math.abs(bkf.scaleY ?? 1));
          max.set(boneId, cur);
        });
      }
    });
    return max;
  }

  private async buildSpritesheet(
    loaded: Array<{ id: string; src: CanvasImageSource; w: number; h: number }>,
  ): Promise<{ canvas: HTMLCanvasElement; rects: Map<string, { x: number; y: number; w: number; h: number }> }> {
    // Simple shelf-packing (sort by height descending for better fill)
    const PADDING  = 2;
    const MAX_W    = 1024;
    const sorted   = [...loaded].sort((a, b) => b.h - a.h);
    const rects    = new Map<string, { x: number; y: number; w: number; h: number }>();
    let curX = 0, curY = 0, rowH = 0;

    for (const item of sorted) {
      if (curX + item.w > MAX_W && curX > 0) {
        curX = 0;
        curY += rowH + PADDING;
        rowH  = 0;
      }
      rects.set(item.id, { x: curX, y: curY, w: item.w, h: item.h });
      curX += item.w + PADDING;
      rowH  = Math.max(rowH, item.h);
    }

    const totalH = curY + rowH;
    const canvas = document.createElement('canvas');
    canvas.width  = MAX_W;
    canvas.height = totalH;
    const ctx = canvas.getContext('2d')!;

    for (const item of loaded) {
      const r = rects.get(item.id)!;
      ctx.drawImage(item.src, r.x, r.y);
    }

    return { canvas, rects };
  }

  private buildSpritesheetJson(
    rects: Map<string, { x: number; y: number; w: number; h: number }>,
    totalW: number,
    totalH: number,
  ): SpritesheetJson {
    const frames: Record<string, SpritesheetFrame> = {};
    rects.forEach((r, id) => {
      frames[id] = { frame: { ...r }, sourceSize: { w: r.w, h: r.h } };
    });
    return { frames, meta: { size: { w: totalW, h: totalH } } };
  }
}
