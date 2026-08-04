import { describe, it, expect, vi, beforeEach } from 'vitest';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const dialogMock = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
  dialog: dialogMock,
}));

const fsMock = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));
vi.mock('fs/promises', () => fsMock);

import { registerFsHandlers } from './fsBridge';

const FAKE_WINDOW = {};
const FILTERS = [{ name: 'JSON', extensions: ['json'] }];

describe('fsBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    registerFsHandlers(() => FAKE_WINDOW as never);
  });

  it('registers the three expected IPC channels', () => {
    expect([...handlers.keys()].sort()).toEqual(
      ['fs:openFile', 'fs:saveFileAs', 'fs:writeFile'].sort(),
    );
  });

  describe('fs:openFile', () => {
    it('returns canceled:true with no main window', async () => {
      registerFsHandlers(() => null);
      const result = await handlers.get('fs:openFile')!(null, FILTERS);
      expect(result).toEqual({ canceled: true });
    });

    it('returns canceled:true when the user cancels the native dialog', async () => {
      dialogMock.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
      const result = await handlers.get('fs:openFile')!(null, FILTERS);
      expect(result).toEqual({ canceled: true });
    });

    it('reads the picked file and returns its path + contents', async () => {
      dialogMock.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['C:/x/doc.json'] });
      const buf = Buffer.from('{"a":1}');
      fsMock.readFile.mockResolvedValue(buf);
      const result = await handlers.get('fs:openFile')!(null, FILTERS) as {
        canceled: boolean; path?: string; data?: ArrayBuffer;
      };
      expect(result.canceled).toBe(false);
      expect(result.path).toBe('C:/x/doc.json');
      expect(new TextDecoder().decode(result.data)).toBe('{"a":1}');
    });

    it('surfaces a read error without throwing', async () => {
      dialogMock.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['C:/x/doc.json'] });
      fsMock.readFile.mockRejectedValue(new Error('EACCES'));
      const result = await handlers.get('fs:openFile')!(null, FILTERS);
      expect(result).toEqual({ canceled: false, error: 'EACCES' });
    });
  });

  describe('fs:writeFile', () => {
    it('writes the given path and returns ok', async () => {
      fsMock.writeFile.mockResolvedValue(undefined);
      const data = new TextEncoder().encode('hello').buffer;
      const result = await handlers.get('fs:writeFile')!(null, 'C:/x/out.json', data);
      expect(result).toEqual({ ok: true });
      expect(fsMock.writeFile).toHaveBeenCalledWith('C:/x/out.json', Buffer.from(data));
    });

    it('surfaces a write error without throwing', async () => {
      fsMock.writeFile.mockRejectedValue(new Error('ENOSPC'));
      const result = await handlers.get('fs:writeFile')!(null, 'C:/x/out.json', new ArrayBuffer(0));
      expect(result).toEqual({ ok: false, error: 'ENOSPC' });
    });
  });

  describe('fs:saveFileAs', () => {
    it('returns canceled:true with no main window', async () => {
      registerFsHandlers(() => null);
      const result = await handlers.get('fs:saveFileAs')!(null, { filters: FILTERS }, new ArrayBuffer(0));
      expect(result).toEqual({ canceled: true });
    });

    it('returns canceled:true when the user cancels the save dialog', async () => {
      dialogMock.showSaveDialog.mockResolvedValue({ canceled: true });
      const result = await handlers.get('fs:saveFileAs')!(null, { filters: FILTERS }, new ArrayBuffer(0));
      expect(result).toEqual({ canceled: true });
    });

    it('writes to the chosen path and returns it', async () => {
      dialogMock.showSaveDialog.mockResolvedValue({ canceled: false, filePath: 'C:/x/new.json' });
      fsMock.writeFile.mockResolvedValue(undefined);
      const data = new TextEncoder().encode('{}').buffer;
      const result = await handlers.get('fs:saveFileAs')!(null, { defaultPath: 'new.json', filters: FILTERS }, data);
      expect(result).toEqual({ canceled: false, path: 'C:/x/new.json' });
      expect(fsMock.writeFile).toHaveBeenCalledWith('C:/x/new.json', Buffer.from(data));
    });

    it('surfaces a write error without throwing', async () => {
      dialogMock.showSaveDialog.mockResolvedValue({ canceled: false, filePath: 'C:/x/new.json' });
      fsMock.writeFile.mockRejectedValue(new Error('EPERM'));
      const result = await handlers.get('fs:saveFileAs')!(null, { filters: FILTERS }, new ArrayBuffer(0));
      expect(result).toEqual({ canceled: false, error: 'EPERM' });
    });
  });
});
