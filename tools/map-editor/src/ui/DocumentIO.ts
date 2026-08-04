// Browser-native file I/O, no backend — matches funny/tools/level-editor's exact
// precedent: File System Access API (showSaveFilePicker/showOpenFilePicker) on
// Chromium, Blob+<a download>/hidden <input type=file> fallback elsewhere.

// The File System Access API isn't in TS's default DOM lib yet; declare just the
// surface this module actually uses.
interface FileSystemFileHandleLike {
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
}
// Native file I/O bridge injected by tools/desktop-shell's preload.ts when this page
// runs inside the Electron shell; undefined when running standalone (`npm run dev`
// in a browser tab).
interface NwDesktopFsBridge {
  openFile(
    filters: Array<{ name: string; extensions: string[] }>,
  ): Promise<{ canceled: boolean; path?: string; data?: ArrayBuffer; error?: string }>;
  saveFileAs(
    opts: { defaultPath?: string; filters: Array<{ name: string; extensions: string[] }> },
    data: ArrayBuffer,
  ): Promise<{ canceled: boolean; path?: string; error?: string }>;
}
declare global {
  interface Window {
    showSaveFilePicker?(options?: {
      suggestedName?: string;
      types?: { description: string; accept: Record<string, string[]> }[];
    }): Promise<FileSystemFileHandleLike>;
    showOpenFilePicker?(options?: {
      types?: { description: string; accept: Record<string, string[]> }[];
    }): Promise<{ getFile(): Promise<File> }[]>;
    nwDesktop?: { fs: NwDesktopFsBridge };
  }
}

const JSON_TYPE = [{ description: 'JSON', accept: { 'application/json': ['.json'] } }];
const JSON_FILTER = [{ name: 'JSON', extensions: ['json'] }];

export async function saveJson(data: unknown, suggestedName: string): Promise<void> {
  const text = JSON.stringify(data, null, 2);
  if (window.nwDesktop?.fs) {
    const buf = new TextEncoder().encode(text).buffer;
    const result = await window.nwDesktop.fs.saveFileAs({ defaultPath: suggestedName, filters: JSON_FILTER }, buf);
    if (!result.canceled && result.error) throw new Error(result.error);
    return;
  }
  if (window.showSaveFilePicker) {
    const handle = await window.showSaveFilePicker({ suggestedName, types: JSON_TYPE });
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
    return;
  }
  // Fallback: Blob + <a download> (Firefox/Safari — no File System Access API).
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  a.click();
  URL.revokeObjectURL(url);
}

export async function openJson<T>(): Promise<{ name: string; data: T } | null> {
  if (window.nwDesktop?.fs) {
    const result = await window.nwDesktop.fs.openFile(JSON_FILTER);
    if (result.canceled || !result.data || !result.path) return null;
    const name = result.path.replace(/^.*[/\\]/, '');
    const text = new TextDecoder().decode(result.data);
    return { name, data: JSON.parse(text) as T };
  }
  if (window.showOpenFilePicker) {
    const [handle] = await window.showOpenFilePicker({ types: JSON_TYPE });
    if (!handle) return null;
    const file = await handle.getFile();
    const text = await file.text();
    return { name: file.name, data: JSON.parse(text) as T };
  }
  // Fallback: hidden <input type=file>.
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      const text = await file.text();
      resolve({ name: file.name, data: JSON.parse(text) as T });
    };
    input.click();
  });
}
