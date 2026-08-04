import { contextBridge, ipcRenderer } from 'electron';

/**
 * Bridge injected into each tool's content page (BrowserView). Tool pages call this
 * on an opt-in basis — window.nwDesktop is undefined when a tool runs standalone
 * (`npm run dev` outside the shell), so callers must check for its presence.
 */
contextBridge.exposeInMainWorld('nwDesktop', {
  git: {
    status: (workdir: string) => ipcRenderer.invoke('git:status', workdir),
    commitAndPush: (opts: unknown) => ipcRenderer.invoke('git:commitAndPush', opts),
    openOrUpdatePR: (opts: unknown) => ipcRenderer.invoke('git:openOrUpdatePR', opts),
  },
  /** Local disk file read/write, see fsBridge.ts. */
  fs: {
    openFile: (filters: Array<{ name: string; extensions: string[] }>) =>
      ipcRenderer.invoke('fs:openFile', filters),
    writeFile: (path: string, data: ArrayBuffer) => ipcRenderer.invoke('fs:writeFile', path, data),
    saveFileAs: (
      opts: { defaultPath?: string; filters: Array<{ name: string; extensions: string[] }> },
      data: ArrayBuffer,
    ) => ipcRenderer.invoke('fs:saveFileAs', opts, data),
  },
  /** Shell asks the tool page to save immediately (first step of the content hot-update flow). Returns an unsubscribe function. */
  onRequestSave(cb: () => void | Promise<void>): () => void {
    const listener = () => {
      Promise.resolve(cb()).finally(() => ipcRenderer.send('nw:save-ack'));
    };
    ipcRenderer.on('nw:request-save', listener);
    return () => ipcRenderer.removeListener('nw:request-save', listener);
  },
  /** Shell/tool has a new version available. Returns an unsubscribe function. */
  onUpdateAvailable(cb: (info: { kind: 'app' | 'content'; toolId?: string }) => void): () => void {
    const listener = (_e: unknown, info: { kind: 'app' | 'content'; toolId?: string }) => cb(info);
    ipcRenderer.on('nw:update-available', listener);
    return () => ipcRenderer.removeListener('nw:update-available', listener);
  },
});
