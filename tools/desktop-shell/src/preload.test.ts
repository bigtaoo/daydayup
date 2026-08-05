import { describe, it, expect, vi, beforeEach } from 'vitest';

const electronMock = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: {
    invoke: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    send: vi.fn(),
  },
}));
vi.mock('electron', () => electronMock);

function flush() {
  return new Promise<void>(resolve => setImmediate(resolve));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NwDesktop = any;

describe('preload (nwDesktop content-page bridge)', () => {
  let nwDesktop: NwDesktop;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    await import('./preload');
    const call = electronMock.contextBridge.exposeInMainWorld.mock.calls[0];
    nwDesktop = call[1];
  });

  it('exposes exactly one API named "nwDesktop"', () => {
    expect(electronMock.contextBridge.exposeInMainWorld).toHaveBeenCalledTimes(1);
    expect(electronMock.contextBridge.exposeInMainWorld.mock.calls[0][0]).toBe('nwDesktop');
  });

  it('git.status invokes git:status with the workdir', () => {
    nwDesktop.git.status('/repo');
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith('git:status', '/repo');
  });

  it('git.commitAndPush invokes git:commitAndPush with the opts', () => {
    const opts = { message: 'commit' };
    nwDesktop.git.commitAndPush(opts);
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith('git:commitAndPush', opts);
  });

  it('git.openOrUpdatePR invokes git:openOrUpdatePR with the opts', () => {
    const opts = { title: 'PR' };
    nwDesktop.git.openOrUpdatePR(opts);
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith('git:openOrUpdatePR', opts);
  });

  it('fs.openFile invokes fs:openFile with the filters', () => {
    const filters = [{ name: 'PNG', extensions: ['png'] }];
    nwDesktop.fs.openFile(filters);
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith('fs:openFile', filters);
  });

  it('fs.writeFile invokes fs:writeFile with the path and data', () => {
    const data = new ArrayBuffer(4);
    nwDesktop.fs.writeFile('/tmp/foo.png', data);
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith('fs:writeFile', '/tmp/foo.png', data);
  });

  it('fs.saveFileAs invokes fs:saveFileAs with the opts and data', () => {
    const opts = { defaultPath: 'foo.png', filters: [{ name: 'PNG', extensions: ['png'] }] };
    const data = new ArrayBuffer(4);
    nwDesktop.fs.saveFileAs(opts, data);
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith('fs:saveFileAs', opts, data);
  });

  describe('onRequestSave', () => {
    it('subscribes to nw:request-save', () => {
      nwDesktop.onRequestSave(() => {});
      expect(electronMock.ipcRenderer.on).toHaveBeenCalledWith('nw:request-save', expect.any(Function));
    });

    it('runs the callback and then acks, for a sync callback', async () => {
      const cb = vi.fn();
      nwDesktop.onRequestSave(cb);
      const listener = electronMock.ipcRenderer.on.mock.calls[0][1];

      listener();
      await flush();

      expect(cb).toHaveBeenCalledTimes(1);
      expect(electronMock.ipcRenderer.send).toHaveBeenCalledWith('nw:save-ack');
    });

    it('acks only after an async callback resolves', async () => {
      let resolveCb: () => void = () => {};
      const cb = vi.fn(() => new Promise<void>(resolve => { resolveCb = resolve; }));
      nwDesktop.onRequestSave(cb);
      const listener = electronMock.ipcRenderer.on.mock.calls[0][1];

      listener();
      await flush();
      expect(electronMock.ipcRenderer.send).not.toHaveBeenCalled();

      resolveCb();
      await flush();
      expect(electronMock.ipcRenderer.send).toHaveBeenCalledWith('nw:save-ack');
    });

    it('returns an unsubscribe function that removes the same listener', () => {
      const unsubscribe = nwDesktop.onRequestSave(() => {});
      const listener = electronMock.ipcRenderer.on.mock.calls[0][1];

      unsubscribe();

      expect(electronMock.ipcRenderer.removeListener).toHaveBeenCalledWith('nw:request-save', listener);
    });

    it('still acks and logs (without an unhandled rejection) when the callback rejects', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const err = new Error('save failed');
      const cb = vi.fn(() => Promise.reject(err));
      nwDesktop.onRequestSave(cb);
      const listener = electronMock.ipcRenderer.on.mock.calls[0][1];

      listener();
      await flush();

      expect(consoleErrorSpy).toHaveBeenCalledWith('[desktop-shell] onRequestSave callback failed:', err);
      expect(electronMock.ipcRenderer.send).toHaveBeenCalledWith('nw:save-ack');

      consoleErrorSpy.mockRestore();
    });
  });

  describe('onUpdateAvailable', () => {
    it('subscribes to nw:update-available and forwards the info payload', () => {
      const cb = vi.fn();
      nwDesktop.onUpdateAvailable(cb);
      expect(electronMock.ipcRenderer.on).toHaveBeenCalledWith('nw:update-available', expect.any(Function));

      const listener = electronMock.ipcRenderer.on.mock.calls[0][1];
      const info = { kind: 'content', toolId: 'animator' };
      listener({}, info);

      expect(cb).toHaveBeenCalledWith(info);
    });

    it('returns an unsubscribe function that removes the same listener', () => {
      const unsubscribe = nwDesktop.onUpdateAvailable(() => {});
      const listener = electronMock.ipcRenderer.on.mock.calls[0][1];

      unsubscribe();

      expect(electronMock.ipcRenderer.removeListener).toHaveBeenCalledWith('nw:update-available', listener);
    });
  });
});
