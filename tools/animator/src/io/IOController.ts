import type { AppState } from '../core/AppState';
import type { AnimationController } from '../animation/AnimationController';
import type { ImageController } from '../images/ImageController';
import type { CommandManager } from '../core/CommandManager';
import type { EventBus, AppEvents } from '../core/EventBus';
import type { Rig } from '../skeleton/Rig';
import { EditorProjectIO } from './EditorProjectIO';
import { TaoExporter } from './TaoExporter';
import { hasDesktopBridge, openViaDesktopBridge } from './ioUtils';

const TAO_TYPES = [{ description: 'Tao Animation', accept: { 'application/octet-stream': ['.tao'] } }];
const EDITORTAO_TYPES = [{ description: 'Tao Editor Project', accept: { 'application/octet-stream': ['.editortao'] } }];

/**
 * Wires the save/load/export/import DOM buttons and owns the two format-specific
 * helpers: EditorProjectIO (`.editortao`, the full-fidelity project format) and
 * TaoExporter (`.tao`, the baked runtime bundle) — split out of one 700+ line file
 * 2026-07-28. Kept as a thin façade (not inlined at call sites) because `window.__io`
 * is a debug hook a headless driver calls `buildTaoBlob()`/`buildEditorBlob()` on
 * directly (see App.ts), and AutoSaveController holds a reference typed `IOController`.
 */
export class IOController {
  private readonly editorIO: EditorProjectIO;
  private readonly taoExporter: TaoExporter;

  constructor(
    state:      AppState,
    animCtrl:   AnimationController,
    imageCtrl:  ImageController,
    cmdManager: CommandManager,
    bus:        EventBus<AppEvents>,
    rig:        Rig,
  ) {
    this.editorIO = new EditorProjectIO(state, animCtrl, imageCtrl, cmdManager, bus);
    this.taoExporter = new TaoExporter(state, animCtrl, imageCtrl, cmdManager, bus, rig);

    document.getElementById('btn-export')?.addEventListener('click', () => this.exportTao());
    document.getElementById('btn-import')?.addEventListener('click', () => this.triggerImport());
    document.getElementById('file-input')?.addEventListener('change', e => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) this.importTao(file, file.name);
      (e.target as HTMLInputElement).value = '';
    });

    document.getElementById('btn-save-editor')?.addEventListener('click', () => this.saveEditorProject());
    document.getElementById('btn-load-editor')?.addEventListener('click', () => this.triggerLoadEditor());
    document.getElementById('editor-file-input')?.addEventListener('change', e => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) this.loadEditorProject(file);
      (e.target as HTMLInputElement).value = '';
    });
  }

  // ── Editor save / load (EditorProjectIO) ─────────────────────────────────────

  buildEditorBlob(): Promise<Blob> {
    return this.editorIO.buildEditorBlob();
  }

  saveEditorProject(): Promise<void> {
    return this.editorIO.saveEditorProject();
  }

  loadEditorProject(file: File): Promise<void> {
    return this.editorIO.loadEditorProject(file);
  }

  loadEditorBlob(data: Blob, label: string): Promise<void> {
    return this.editorIO.loadEditorBlob(data, label);
  }

  // ── .tao export / import (TaoExporter) ───────────────────────────────────────

  buildTaoBlob(): Promise<Blob> {
    return this.taoExporter.buildTaoBlob();
  }

  exportTao(): Promise<void> {
    return this.taoExporter.exportTao();
  }

  importTao(file: Blob, name?: string): Promise<void> {
    return this.taoExporter.importTao(file, name);
  }

  private async triggerImport(): Promise<void> {
    if (hasDesktopBridge()) {
      const opened = await openViaDesktopBridge(TAO_TYPES);
      if (opened) await this.importTao(opened.blob, opened.name);
      return;
    }
    (document.getElementById('file-input') as HTMLInputElement | null)?.click();
  }

  private async triggerLoadEditor(): Promise<void> {
    if (hasDesktopBridge()) {
      const opened = await openViaDesktopBridge(EDITORTAO_TYPES);
      if (opened) await this.loadEditorBlob(opened.blob, opened.name);
      return;
    }
    (document.getElementById('editor-file-input') as HTMLInputElement | null)?.click();
  }
}
