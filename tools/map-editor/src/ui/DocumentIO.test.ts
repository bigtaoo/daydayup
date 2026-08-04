import { describe, it, expect, vi, afterEach } from 'vitest';
import { saveJson, openJson } from './DocumentIO';

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Doc { id: string; value: number }
const DOC: Doc = { id: 'room_1', value: 42 };
const DOC_TEXT = JSON.stringify(DOC, null, 2);

describe('saveJson — desktop bridge branch', () => {
  it('writes the JSON text as bytes and resolves on success', async () => {
    const saveFileAs = vi.fn().mockResolvedValue({ canceled: false, path: 'C:/x/room_1.json' });
    vi.stubGlobal('window', { nwDesktop: { fs: { saveFileAs } } });

    await saveJson(DOC, 'room_1.json');

    expect(saveFileAs).toHaveBeenCalledTimes(1);
    const [opts, buf] = saveFileAs.mock.calls[0];
    expect(opts).toEqual({ defaultPath: 'room_1.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    expect(new TextDecoder().decode(buf)).toBe(DOC_TEXT);
  });

  it('throws when the bridge reports a real error', async () => {
    const saveFileAs = vi.fn().mockResolvedValue({ canceled: false, error: 'EPERM' });
    vi.stubGlobal('window', { nwDesktop: { fs: { saveFileAs } } });

    await expect(saveJson(DOC, 'room_1.json')).rejects.toThrow('EPERM');
  });

  it('does not throw when the user cancels (even if an error field is also set)', async () => {
    const saveFileAs = vi.fn().mockResolvedValue({ canceled: true, error: 'ignored' });
    vi.stubGlobal('window', { nwDesktop: { fs: { saveFileAs } } });

    await expect(saveJson(DOC, 'room_1.json')).resolves.toBeUndefined();
  });
});

describe('saveJson — File System Access API branch (no bridge)', () => {
  it('writes the JSON text through the picked file handle', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const showSaveFilePicker = vi.fn().mockResolvedValue({ createWritable: () => Promise.resolve({ write, close }) });
    vi.stubGlobal('window', { showSaveFilePicker });

    await saveJson(DOC, 'room_1.json');

    expect(showSaveFilePicker).toHaveBeenCalledWith({
      suggestedName: 'room_1.json',
      types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
    });
    expect(write).toHaveBeenCalledWith(DOC_TEXT);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('saveJson — download fallback (no bridge, no FSA API)', () => {
  it('creates a Blob + <a download> and triggers a click', async () => {
    const click = vi.fn();
    const revoke = vi.fn();
    let downloadedAs = '';
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {
      createElement: vi.fn(() => ({
        click,
        set href(_v: string) {},
        set download(v: string) { downloadedAs = v; },
      })),
    });
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:fake'), revokeObjectURL: revoke });

    await saveJson(DOC, 'room_1.json');

    expect(click).toHaveBeenCalledTimes(1);
    expect(downloadedAs).toBe('room_1.json');
    expect(revoke).toHaveBeenCalledWith('blob:fake');
  });
});

describe('openJson — desktop bridge branch', () => {
  it('returns null when the user cancels', async () => {
    const openFile = vi.fn().mockResolvedValue({ canceled: true });
    vi.stubGlobal('window', { nwDesktop: { fs: { openFile } } });

    expect(await openJson()).toBeNull();
  });

  it('returns null when the bridge reports success but omits data/path', async () => {
    const openFile = vi.fn().mockResolvedValue({ canceled: false });
    vi.stubGlobal('window', { nwDesktop: { fs: { openFile } } });

    expect(await openJson()).toBeNull();
  });

  it('parses the picked JSON file and derives the name from a Windows path', async () => {
    const data = new TextEncoder().encode(DOC_TEXT).buffer;
    const openFile = vi.fn().mockResolvedValue({ canceled: false, path: 'C:\\rooms\\room_1.json', data });
    vi.stubGlobal('window', { nwDesktop: { fs: { openFile } } });

    const result = await openJson<Doc>();

    expect(result).toEqual({ name: 'room_1.json', data: DOC });
    expect(openFile).toHaveBeenCalledWith([{ name: 'JSON', extensions: ['json'] }]);
  });

  it('derives the name from a POSIX-style path too', async () => {
    const data = new TextEncoder().encode(DOC_TEXT).buffer;
    const openFile = vi.fn().mockResolvedValue({ canceled: false, path: '/home/tao/rooms/room_1.json', data });
    vi.stubGlobal('window', { nwDesktop: { fs: { openFile } } });

    const result = await openJson<Doc>();
    expect(result!.name).toBe('room_1.json');
  });
});

describe('openJson — File System Access API branch (no bridge)', () => {
  it('returns null when no handle is picked', async () => {
    const showOpenFilePicker = vi.fn().mockResolvedValue([]);
    vi.stubGlobal('window', { showOpenFilePicker });

    expect(await openJson()).toBeNull();
  });

  it('parses the picked file via its handle', async () => {
    const file = { name: 'room_1.json', text: () => Promise.resolve(DOC_TEXT) };
    const showOpenFilePicker = vi.fn().mockResolvedValue([{ getFile: () => Promise.resolve(file) }]);
    vi.stubGlobal('window', { showOpenFilePicker });

    const result = await openJson<Doc>();

    expect(showOpenFilePicker).toHaveBeenCalledWith({
      types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
    });
    expect(result).toEqual({ name: 'room_1.json', data: DOC });
  });
});

describe('openJson — hidden <input type=file> fallback (no bridge, no FSA API)', () => {
  it('resolves with the parsed file once one is chosen', async () => {
    const file = { name: 'room_1.json', text: () => Promise.resolve(DOC_TEXT) };
    let inputEl: { type: string; accept: string; onchange: (() => void) | null; files: unknown[]; click: () => void } | null = null;
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {
      createElement: vi.fn(() => {
        inputEl = { type: '', accept: '', onchange: null, files: [], click: vi.fn() };
        return inputEl;
      }),
    });

    const pending = openJson<Doc>();
    inputEl!.files = [file];
    inputEl!.onchange!();

    expect(await pending).toEqual({ name: 'room_1.json', data: DOC });
    expect(inputEl!.click).toHaveBeenCalledTimes(1);
    expect(inputEl!.accept).toBe('application/json,.json');
  });

  it('resolves null when the change event fires with no file', async () => {
    let inputEl: { onchange: (() => void) | null; files: unknown[]; click: () => void } | null = null;
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {
      createElement: vi.fn(() => {
        inputEl = { onchange: null, files: [], click: vi.fn() };
        return inputEl;
      }),
    });

    const pending = openJson<Doc>();
    inputEl!.onchange!();

    expect(await pending).toBeNull();
  });
});
