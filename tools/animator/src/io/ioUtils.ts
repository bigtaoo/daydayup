/** Small file/blob/canvas helpers shared by EditorProjectIO and TaoExporter, split out
 *  of IOController.ts 2026-07-28 — pure utility functions, no app state. */

/** Clamp a bake factor to (0, 1]: never upscale the source, never produce a zero-size image. */
export function clamp01(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 1;
  return Math.min(1, v);
}

export function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image load failed')); };
    img.src = url;
  });
}

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => {
      if (b) resolve(b);
      else   reject(new Error('canvas.toBlob returned null'));
    }, 'image/png');
  });
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** First accepted extension declared in `types` (e.g. ".editortao"), or '' if none. */
function primaryExt(types: Array<{ accept: Record<string, string[]> }>): string {
  for (const t of types) {
    for (const exts of Object.values(t.accept)) {
      if (exts[0]) return exts[0];
    }
  }
  return '';
}

/** Guarantee `name` ends with exactly one `ext`. Collapses an accidentally
 *  doubled extension (e.g. "x.editortao.editortao" → "x.editortao") and appends
 *  `ext` when missing. `.editortao` is deliberately a single dot-segment, not
 *  the old compound `.tao.editor` — Windows/macOS both treat a multi-dot
 *  extension as "unrecognized" (double-clicking it, or some save dialogs,
 *  wouldn't reliably round-trip both segments), and Chrome's File System
 *  Access picker used to re-append the whole compound extension when the
 *  chosen name didn't already end with it, producing a doubled
 *  ".tao.editor.tao.editor". This guard still matters for the single-segment
 *  form (a user retyping ".editortao" by hand), just for a narrower reason. */
function ensureSingleExt(name: string, ext: string): string {
  if (!ext) return name;
  const lower = ext.toLowerCase();
  let n = name;
  while (n.toLowerCase().endsWith(lower + lower)) n = n.slice(0, -ext.length);
  if (!n.toLowerCase().endsWith(lower)) n += ext;
  return n;
}

/** Save blob via the File System Access API (native save dialog with folder + filename).
 *  Falls back to a filename prompt + triggerDownload for browsers without the API (e.g. Firefox). */
export async function saveWithPicker(
  blob: Blob,
  suggestedName: string,
  types: Array<{ description?: string; accept: Record<string, string[]> }>,
): Promise<void> {
  // Pass a name that already carries exactly one canonical extension so neither
  // the native picker nor the user prompt can produce a doubled ".editortao".
  const ext       = primaryExt(types);
  const suggested = ensureSingleExt(suggestedName, ext);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const picker = (window as any).showSaveFilePicker;
  if (typeof picker === 'function') {
    let handle: { createWritable(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void> }> };
    try {
      handle = await picker({ suggestedName: suggested, types });
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return;  // user cancelled
      throw e;
    }
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
  } else {
    // Firefox / Safari fallback: prompt for filename, then trigger download.
    // The save path is controlled by the browser's download settings
    // (Firefox: Settings → Downloads → "Always ask you where to save files").
    const name = window.prompt('Save as:', suggested);
    if (name === null) return;  // user cancelled
    triggerDownload(blob, ensureSingleExt(name.trim() || suggested, ext));
  }
}
