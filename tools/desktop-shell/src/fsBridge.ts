import { ipcMain, dialog, BrowserWindow } from 'electron';
import * as fs from 'fs/promises';

export interface FileFilter {
  name: string;
  extensions: string[];
}

interface OpenFileResult {
  canceled: boolean;
  path?: string;
  data?: ArrayBuffer;
  error?: string;
}

interface WriteFileResult {
  ok: boolean;
  error?: string;
}

interface SaveFileAsResult {
  canceled: boolean;
  path?: string;
  error?: string;
}

/**
 * Local disk file I/O bridge. The main process uses native dialog.showOpenDialog/
 * showSaveDialog + fs/promises to read and write directly, bypassing the sandbox
 * limits of the browser File System Access API (can't recover the directory of an
 * already-open file, write permission has to be reconfirmed repeatedly). openFile
 * shows one native picker and returns the path + contents; writeFile overwrites the
 * given absolute path with no dialog; saveFileAs shows one save dialog and returns
 * the new path.
 */
export function registerFsHandlers(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle('fs:openFile', async (_e, filters: FileFilter[]): Promise<OpenFileResult> => {
    const win = getMainWindow();
    if (!win) return { canceled: true };
    const result = await dialog.showOpenDialog(win, { properties: ['openFile'], filters });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const filePath = result.filePaths[0];
    try {
      const buf = await fs.readFile(filePath);
      return {
        canceled: false,
        path: filePath,
        data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      };
    } catch (err) {
      return { canceled: false, error: (err as Error).message };
    }
  });

  ipcMain.handle(
    'fs:writeFile',
    async (_e, filePath: string, data: ArrayBuffer): Promise<WriteFileResult> => {
      try {
        await fs.writeFile(filePath, Buffer.from(data));
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(
    'fs:saveFileAs',
    async (
      _e,
      opts: { defaultPath?: string; filters: FileFilter[] },
      data: ArrayBuffer,
    ): Promise<SaveFileAsResult> => {
      const win = getMainWindow();
      if (!win) return { canceled: true };
      const result = await dialog.showSaveDialog(win, {
        defaultPath: opts.defaultPath,
        filters: opts.filters,
      });
      if (result.canceled || !result.filePath) return { canceled: true };
      try {
        await fs.writeFile(result.filePath, Buffer.from(data));
        return { canceled: false, path: result.filePath };
      } catch (err) {
        return { canceled: false, error: (err as Error).message };
      }
    },
  );
}
