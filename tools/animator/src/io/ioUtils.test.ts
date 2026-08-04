import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  clamp01,
  loadImageFromBlob,
  canvasToBlob,
  hasDesktopBridge,
  openViaDesktopBridge,
  saveWithPicker,
} from './ioUtils';

const EDITORTAO_TYPES = [{ description: 'Tao Editor Project', accept: { 'application/octet-stream': ['.editortao'] } }];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('clamp01', () => {
  it.each([
    [0, 1], [-5, 1], [NaN, 1], [Infinity, 1], [-Infinity, 1],
    [0.5, 0.5], [1, 1], [2, 1], [0.0001, 0.0001],
  ])('clamp01(%p) === %p', (input, expected) => {
    expect(clamp01(input)).toBe(expected);
  });
});

describe('loadImageFromBlob', () => {
  it('resolves with the Image once it loads, and revokes the object URL', async () => {
    const revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:fake'), revokeObjectURL: revoke });
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      _src = '';
      set src(v: string) { this._src = v; queueMicrotask(() => this.onload?.()); }
      get src() { return this._src; }
    }
    vi.stubGlobal('Image', FakeImage);

    const img = await loadImageFromBlob(new Blob(['x']));

    expect(img).toBeInstanceOf(FakeImage);
    expect(revoke).toHaveBeenCalledWith('blob:fake');
  });

  it('rejects if the image fails to load, and still revokes the object URL', async () => {
    const revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:fake'), revokeObjectURL: revoke });
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_v: string) { queueMicrotask(() => this.onerror?.()); }
    }
    vi.stubGlobal('Image', FakeImage);

    await expect(loadImageFromBlob(new Blob(['x']))).rejects.toThrow('Image load failed');
    expect(revoke).toHaveBeenCalledWith('blob:fake');
  });
});

describe('canvasToBlob', () => {
  it('resolves with the blob toBlob() produces', async () => {
    const producedBlob = new Blob(['png-bytes']);
    const canvas = { toBlob: (cb: (b: Blob | null) => void) => cb(producedBlob) } as unknown as HTMLCanvasElement;

    await expect(canvasToBlob(canvas)).resolves.toBe(producedBlob);
  });

  it('rejects when toBlob() produces null', async () => {
    const canvas = { toBlob: (cb: (b: Blob | null) => void) => cb(null) } as unknown as HTMLCanvasElement;

    await expect(canvasToBlob(canvas)).rejects.toThrow('canvas.toBlob returned null');
  });
});

describe('hasDesktopBridge', () => {
  it('is false with no window.nwDesktop at all', () => {
    vi.stubGlobal('window', {});
    expect(hasDesktopBridge()).toBe(false);
  });

  it('is false when nwDesktop exists but fs does not', () => {
    vi.stubGlobal('window', { nwDesktop: {} });
    expect(hasDesktopBridge()).toBe(false);
  });

  it('is true when nwDesktop.fs is present', () => {
    vi.stubGlobal('window', { nwDesktop: { fs: {} } });
    expect(hasDesktopBridge()).toBe(true);
  });
});

describe('openViaDesktopBridge', () => {
  it('returns null when there is no bridge', async () => {
    vi.stubGlobal('window', {});
    expect(await openViaDesktopBridge(EDITORTAO_TYPES)).toBeNull();
  });

  it('returns null when the user cancels the native picker', async () => {
    const openFile = vi.fn().mockResolvedValue({ canceled: true });
    vi.stubGlobal('window', { nwDesktop: { fs: { openFile } } });

    expect(await openViaDesktopBridge(EDITORTAO_TYPES)).toBeNull();
  });

  it('returns null when the bridge reports success but omits data/path', async () => {
    const openFile = vi.fn().mockResolvedValue({ canceled: false });
    vi.stubGlobal('window', { nwDesktop: { fs: { openFile } } });

    expect(await openViaDesktopBridge(EDITORTAO_TYPES)).toBeNull();
  });

  it('resolves {name, blob} from the picked file, deriving name from a Windows path', async () => {
    const data = new TextEncoder().encode('hello').buffer;
    const openFile = vi.fn().mockResolvedValue({ canceled: false, path: 'C:\\projects\\Untitled.editortao', data });
    vi.stubGlobal('window', { nwDesktop: { fs: { openFile } } });

    const result = await openViaDesktopBridge(EDITORTAO_TYPES);

    expect(result!.name).toBe('Untitled.editortao');
    expect(await result!.blob.arrayBuffer()).toEqual(data);
  });

  it('derives name from a POSIX-style path too', async () => {
    const data = new ArrayBuffer(0);
    const openFile = vi.fn().mockResolvedValue({ canceled: false, path: '/home/tao/proj.editortao', data });
    vi.stubGlobal('window', { nwDesktop: { fs: { openFile } } });

    const result = await openViaDesktopBridge(EDITORTAO_TYPES);
    expect(result!.name).toBe('proj.editortao');
  });

  it('converts File System Access `types` into Electron filters (no leading dot, description as name)', async () => {
    const openFile = vi.fn().mockResolvedValue({ canceled: true });
    vi.stubGlobal('window', { nwDesktop: { fs: { openFile } } });

    await openViaDesktopBridge(EDITORTAO_TYPES);

    expect(openFile).toHaveBeenCalledWith([{ name: 'Tao Editor Project', extensions: ['editortao'] }]);
  });

  it('falls back to "Type N" when a filter has no description', async () => {
    const openFile = vi.fn().mockResolvedValue({ canceled: true });
    vi.stubGlobal('window', { nwDesktop: { fs: { openFile } } });

    await openViaDesktopBridge([{ accept: { 'application/json': ['.json'] } }]);

    expect(openFile).toHaveBeenCalledWith([{ name: 'Type 1', extensions: ['json'] }]);
  });
});

describe('saveWithPicker — desktop bridge branch', () => {
  it('sends the blob bytes and a single-extension default path, and resolves on success', async () => {
    const saveFileAs = vi.fn().mockResolvedValue({ canceled: false, path: 'C:/x/project.editortao' });
    vi.stubGlobal('window', { nwDesktop: { fs: { saveFileAs } } });

    await saveWithPicker(new Blob(['data']), 'project', EDITORTAO_TYPES);

    expect(saveFileAs).toHaveBeenCalledTimes(1);
    const [opts, data] = saveFileAs.mock.calls[0];
    expect(opts).toEqual({ defaultPath: 'project.editortao', filters: [{ name: 'Tao Editor Project', extensions: ['editortao'] }] });
    expect(new TextDecoder().decode(data)).toBe('data');
  });

  it('collapses an already-doubled extension in the suggested name', async () => {
    const saveFileAs = vi.fn().mockResolvedValue({ canceled: false });
    vi.stubGlobal('window', { nwDesktop: { fs: { saveFileAs } } });

    await saveWithPicker(new Blob(['x']), 'project.editortao.editortao', EDITORTAO_TYPES);

    expect(saveFileAs.mock.calls[0][0].defaultPath).toBe('project.editortao');
  });

  it('throws when the bridge reports a real error', async () => {
    const saveFileAs = vi.fn().mockResolvedValue({ canceled: false, error: 'EPERM' });
    vi.stubGlobal('window', { nwDesktop: { fs: { saveFileAs } } });

    await expect(saveWithPicker(new Blob(['x']), 'project', EDITORTAO_TYPES)).rejects.toThrow('EPERM');
  });

  it('does not throw when the user simply cancels (even if an error field is also set)', async () => {
    const saveFileAs = vi.fn().mockResolvedValue({ canceled: true, error: 'ignored' });
    vi.stubGlobal('window', { nwDesktop: { fs: { saveFileAs } } });

    await expect(saveWithPicker(new Blob(['x']), 'project', EDITORTAO_TYPES)).resolves.toBeUndefined();
  });
});

describe('saveWithPicker — File System Access API branch (no desktop bridge)', () => {
  it('writes the blob through the picked file handle', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const showSaveFilePicker = vi.fn().mockResolvedValue({ createWritable: () => Promise.resolve({ write, close }) });
    vi.stubGlobal('window', { showSaveFilePicker });

    const blob = new Blob(['x']);
    await saveWithPicker(blob, 'project', EDITORTAO_TYPES);

    expect(showSaveFilePicker).toHaveBeenCalledWith({ suggestedName: 'project.editortao', types: EDITORTAO_TYPES });
    expect(write).toHaveBeenCalledWith(blob);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('resolves quietly when the user cancels the native picker (AbortError)', async () => {
    const abortError = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    const showSaveFilePicker = vi.fn().mockRejectedValue(abortError);
    vi.stubGlobal('window', { showSaveFilePicker });

    await expect(saveWithPicker(new Blob(['x']), 'project', EDITORTAO_TYPES)).resolves.toBeUndefined();
  });

  it('rethrows a non-cancellation picker error', async () => {
    const showSaveFilePicker = vi.fn().mockRejectedValue(new Error('disk full'));
    vi.stubGlobal('window', { showSaveFilePicker });

    await expect(saveWithPicker(new Blob(['x']), 'project', EDITORTAO_TYPES)).rejects.toThrow('disk full');
  });
});

describe('saveWithPicker — Firefox/Safari download fallback (no bridge, no FSA API)', () => {
  it('prompts for a filename and triggers a download with a single canonical extension', async () => {
    const click = vi.fn();
    const revoke = vi.fn();
    vi.stubGlobal('window', { prompt: vi.fn(() => 'myproj') });
    vi.stubGlobal('document', { createElement: vi.fn(() => ({ click, set href(_v: string) {}, set download(_v: string) {} })) });
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:fake'), revokeObjectURL: revoke });

    await saveWithPicker(new Blob(['x']), 'project', EDITORTAO_TYPES);

    expect(click).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith('blob:fake');
  });

  it('does nothing when the user cancels the filename prompt', async () => {
    const createElement = vi.fn();
    vi.stubGlobal('window', { prompt: vi.fn(() => null) });
    vi.stubGlobal('document', { createElement });

    await saveWithPicker(new Blob(['x']), 'project', EDITORTAO_TYPES);

    expect(createElement).not.toHaveBeenCalled();
  });

  it('falls back to the suggested name when the prompt is submitted blank', async () => {
    let downloadedAs = '';
    vi.stubGlobal('window', { prompt: vi.fn(() => '   ') });
    vi.stubGlobal('document', {
      createElement: vi.fn(() => ({
        click: vi.fn(),
        set href(_v: string) {},
        set download(v: string) { downloadedAs = v; },
      })),
    });
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:fake'), revokeObjectURL: vi.fn() });

    await saveWithPicker(new Blob(['x']), 'project', EDITORTAO_TYPES);

    expect(downloadedAs).toBe('project.editortao');
  });
});
