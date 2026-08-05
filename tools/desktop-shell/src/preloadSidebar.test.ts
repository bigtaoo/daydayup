import { describe, it, expect, vi, beforeEach } from 'vitest';

const electronMock = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: {
    invoke: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));
vi.mock('electron', () => electronMock);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NwShell = any;

describe('preloadSidebar (nwShell sidebar-page bridge)', () => {
  let nwShell: NwShell;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    await import('./preloadSidebar');
    const call = electronMock.contextBridge.exposeInMainWorld.mock.calls[0];
    nwShell = call[1];
  });

  it('exposes exactly one API named "nwShell"', () => {
    expect(electronMock.contextBridge.exposeInMainWorld).toHaveBeenCalledTimes(1);
    expect(electronMock.contextBridge.exposeInMainWorld.mock.calls[0][0]).toBe('nwShell');
  });

  it('listTools invokes tools:list', () => {
    nwShell.listTools();
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith('tools:list');
  });

  it('switchTool invokes tool:switch with the id', () => {
    nwShell.switchTool('map-editor');
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith('tool:switch', 'map-editor');
  });

  it('applyUpdate invokes shell:apply-update', () => {
    nwShell.applyUpdate();
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith('shell:apply-update');
  });

  describe('onActiveChanged', () => {
    it('subscribes to tool:active and forwards the id', () => {
      const cb = vi.fn();
      nwShell.onActiveChanged(cb);
      expect(electronMock.ipcRenderer.on).toHaveBeenCalledWith('tool:active', expect.any(Function));

      const listener = electronMock.ipcRenderer.on.mock.calls[0][1];
      listener({}, 'animator');

      expect(cb).toHaveBeenCalledWith('animator');
    });

    it('returns an unsubscribe function that removes the same listener', () => {
      const unsubscribe = nwShell.onActiveChanged(() => {});
      const listener = electronMock.ipcRenderer.on.mock.calls[0][1];

      unsubscribe();

      expect(electronMock.ipcRenderer.removeListener).toHaveBeenCalledWith('tool:active', listener);
    });
  });

  describe('onUpdateAvailable', () => {
    it('subscribes to shell:update-available and forwards the info payload', () => {
      const cb = vi.fn();
      nwShell.onUpdateAvailable(cb);
      expect(electronMock.ipcRenderer.on).toHaveBeenCalledWith('shell:update-available', expect.any(Function));

      const listener = electronMock.ipcRenderer.on.mock.calls[0][1];
      const info = { kind: 'app' };
      listener({}, info);

      expect(cb).toHaveBeenCalledWith(info);
    });

    it('returns an unsubscribe function that removes the same listener', () => {
      const unsubscribe = nwShell.onUpdateAvailable(() => {});
      const listener = electronMock.ipcRenderer.on.mock.calls[0][1];

      unsubscribe();

      expect(electronMock.ipcRenderer.removeListener).toHaveBeenCalledWith('shell:update-available', listener);
    });
  });

  describe('onUpdateCleared', () => {
    it('subscribes to shell:update-cleared and invokes the callback with no args', () => {
      const cb = vi.fn();
      nwShell.onUpdateCleared(cb);
      expect(electronMock.ipcRenderer.on).toHaveBeenCalledWith('shell:update-cleared', expect.any(Function));

      const listener = electronMock.ipcRenderer.on.mock.calls[0][1];
      listener({}, 'ignored-arg');

      expect(cb).toHaveBeenCalledWith();
    });

    it('returns an unsubscribe function that removes the same listener', () => {
      const unsubscribe = nwShell.onUpdateCleared(() => {});
      const listener = electronMock.ipcRenderer.on.mock.calls[0][1];

      unsubscribe();

      expect(electronMock.ipcRenderer.removeListener).toHaveBeenCalledWith('shell:update-cleared', listener);
    });
  });
});
