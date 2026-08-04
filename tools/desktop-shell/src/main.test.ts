import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => {
  const ipcHandlers = new Map<string, (...a: unknown[]) => unknown>();
  const ipcOnHandlers = new Map<string, Array<(...a: unknown[]) => unknown>>();
  const appOnHandlers = new Map<string, Array<(...a: unknown[]) => unknown>>();
  let lastMenuTemplate: unknown = null;

  class FakeBrowserView {
    static instances: FakeBrowserView[] = [];
    webPreferences: unknown;
    bounds: unknown = null;
    didFinishLoadHandlers: Array<() => void> = [];
    webContents = {
      loadFile: vi.fn(),
      loadURL: vi.fn(() => Promise.resolve()),
      send: vi.fn(),
      reload: vi.fn(),
      on: (event: string, cb: () => void) => {
        if (event === 'did-finish-load') this.didFinishLoadHandlers.push(cb);
      },
    };
    constructor(opts: { webPreferences?: unknown } = {}) {
      this.webPreferences = opts.webPreferences;
      FakeBrowserView.instances.push(this);
    }
    setBounds(b: unknown) { this.bounds = b; }
  }

  class FakeBrowserWindow {
    static instances: FakeBrowserWindow[] = [];
    options: unknown;
    views: FakeBrowserView[] = [];
    onHandlers = new Map<string, Array<(...a: unknown[]) => unknown>>();
    constructor(opts: unknown) {
      this.options = opts;
      FakeBrowserWindow.instances.push(this);
    }
    getContentSize() { return [1280, 800]; }
    addBrowserView(v: FakeBrowserView) { this.views.push(v); }
    on(event: string, cb: (...a: unknown[]) => unknown) {
      const arr = this.onHandlers.get(event) ?? [];
      arr.push(cb);
      this.onHandlers.set(event, arr);
    }
    static getAllWindows() { return FakeBrowserWindow.instances; }
  }

  const appState = { isPackaged: false };

  return {
    __test: {
      ipcHandlers,
      ipcOnHandlers,
      appOnHandlers,
      appState,
      getLastMenuTemplate: () => lastMenuTemplate,
      // The 'electron' mock module is a singleton that survives vi.resetModules()
      // (only './main' and its sibling mocks get freshly re-evaluated per test), so
      // its accumulated state needs an explicit reset instead.
      reset: () => {
        FakeBrowserWindow.instances.length = 0;
        FakeBrowserView.instances.length = 0;
        ipcHandlers.clear();
        ipcOnHandlers.clear();
        appOnHandlers.clear();
        lastMenuTemplate = null;
      },
    },
    app: {
      get isPackaged() { return appState.isPackaged; },
      whenReady: () => Promise.resolve(),
      on: (event: string, cb: (...a: unknown[]) => unknown) => {
        const arr = appOnHandlers.get(event) ?? [];
        arr.push(cb);
        appOnHandlers.set(event, arr);
      },
      quit: vi.fn(),
    },
    BrowserWindow: FakeBrowserWindow,
    BrowserView: FakeBrowserView,
    ipcMain: {
      handle: vi.fn((ch: string, fn: (...a: unknown[]) => unknown) => ipcHandlers.set(ch, fn)),
      on: vi.fn((ch: string, fn: (...a: unknown[]) => unknown) => {
        const arr = ipcOnHandlers.get(ch) ?? [];
        arr.push(fn);
        ipcOnHandlers.set(ch, arr);
      }),
    },
    Menu: {
      buildFromTemplate: vi.fn((tmpl: unknown) => {
        lastMenuTemplate = tmpl;
        return { __template: tmpl };
      }),
      setApplicationMenu: vi.fn(),
    },
  };
});

const gitSyncMock = vi.hoisted(() => ({ registerGitSyncHandlers: vi.fn() }));
vi.mock('./gitSync', () => gitSyncMock);

const fsBridgeMock = vi.hoisted(() => ({ registerFsHandlers: vi.fn() }));
vi.mock('./fsBridge', () => fsBridgeMock);

const updateNotifierMock = vi.hoisted(() => ({
  initUpdateNotifier: vi.fn(),
  showUpdateNotice: vi.fn(),
}));
vi.mock('./updateNotifier', () => updateNotifierMock);

const appUpdaterMock = vi.hoisted(() => ({ initAppUpdater: vi.fn() }));
vi.mock('./appUpdater', () => appUpdaterMock);

const contentUpdatePollerMock = vi.hoisted(() => ({
  setActiveTool: vi.fn(),
  confirmBaseline: vi.fn(() => Promise.resolve()),
  checkNow: vi.fn(),
  notifySaveAck: vi.fn(),
  startContentUpdatePolling: vi.fn(),
}));
vi.mock('./contentUpdatePoller', () => contentUpdatePollerMock);

function flush() {
  return new Promise<void>(resolve => setImmediate(resolve));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Electron = any;

describe('main (desktop-shell orchestration)', () => {
  let electron: Electron;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    electron = await import('electron');
    electron.__test.reset();
    electron.__test.appState.isPackaged = false;
    await import('./main');
    await flush(); // let app.whenReady().then(createWindow) run
  });

  it('registers tools:list, tool:switch, and nw:save-ack on import', () => {
    const { ipcHandlers, ipcOnHandlers } = electron.__test;
    expect(ipcHandlers.has('tools:list')).toBe(true);
    expect(ipcHandlers.has('tool:switch')).toBe(true);
    expect(ipcOnHandlers.has('nw:save-ack')).toBe(true);
  });

  it('registers git-sync and fs-bridge handlers exactly once', () => {
    expect(gitSyncMock.registerGitSyncHandlers).toHaveBeenCalledTimes(1);
    expect(fsBridgeMock.registerFsHandlers).toHaveBeenCalledTimes(1);
  });

  it('tools:list returns the real tool catalog', async () => {
    const { TOOLS } = await import('./tools');
    const result = electron.__test.ipcHandlers.get('tools:list')();
    expect(result).toBe(TOOLS);
  });

  it('creates one window with the two BrowserViews attached', () => {
    const { BrowserWindow, BrowserView } = electron;
    expect(BrowserWindow.instances).toHaveLength(1);
    expect(BrowserWindow.instances[0].options).toMatchObject({ title: 'DD Tool' });
    expect(BrowserView.instances).toHaveLength(2); // sidebar + content
    expect(BrowserWindow.instances[0].views).toEqual(BrowserView.instances);
  });

  it('lays out the sidebar and content views using SIDEBAR_WIDTH=180', () => {
    const { BrowserView } = electron;
    const [sidebar, content] = BrowserView.instances;
    expect(sidebar.bounds).toEqual({ x: 0, y: 0, width: 180, height: 800 });
    expect(content.bounds).toEqual({ x: 180, y: 0, width: 1280 - 180, height: 800 });
  });

  it('loads the default tool (animator) into the content view on startup', async () => {
    const { TOOLS } = await import('./tools');
    const { BrowserView } = electron;
    const [sidebar, content] = BrowserView.instances;
    expect(content.webContents.loadURL).toHaveBeenCalledWith(TOOLS[0].devUrl);
    expect(sidebar.webContents.send).toHaveBeenCalledWith('tool:active', 'animator');
  });

  it('wires initUpdateNotifier, startContentUpdatePolling, and initAppUpdater on startup', () => {
    const { BrowserView } = electron;
    const [sidebar] = BrowserView.instances;
    expect(updateNotifierMock.initUpdateNotifier).toHaveBeenCalledWith(sidebar);
    expect(contentUpdatePollerMock.startContentUpdatePolling).toHaveBeenCalledTimes(1);
    expect(appUpdaterMock.initAppUpdater).toHaveBeenCalledTimes(1);
  });

  it('tool:switch loads the requested tool and notifies the sidebar', async () => {
    const { TOOLS } = await import('./tools');
    const { BrowserView } = electron;
    const [sidebar, content] = BrowserView.instances;

    await electron.__test.ipcHandlers.get('tool:switch')(null, 'map-editor');

    expect(content.webContents.loadURL).toHaveBeenCalledWith(TOOLS[1].devUrl);
    expect(sidebar.webContents.send).toHaveBeenCalledWith('tool:active', 'map-editor');
    expect(contentUpdatePollerMock.setActiveTool).toHaveBeenCalledWith(TOOLS[1], content);
  });

  it('tool:switch with an unknown id is a no-op', async () => {
    const { BrowserView } = electron;
    const [, content] = BrowserView.instances;
    content.webContents.loadURL.mockClear();

    await electron.__test.ipcHandlers.get('tool:switch')(null, 'does-not-exist');

    expect(content.webContents.loadURL).not.toHaveBeenCalled();
  });

  it('nw:save-ack forwards to contentUpdatePoller.notifySaveAck', () => {
    electron.__test.ipcOnHandlers.get('nw:save-ack')[0]();
    expect(contentUpdatePollerMock.notifySaveAck).toHaveBeenCalledTimes(1);
  });

  it('content view did-finish-load confirms the update-poller baseline', () => {
    const { BrowserView } = electron;
    const [, content] = BrowserView.instances;
    expect(content.didFinishLoadHandlers).toHaveLength(1);

    content.didFinishLoadHandlers[0]();

    expect(contentUpdatePollerMock.confirmBaseline).toHaveBeenCalledTimes(1);
  });

  it('a window resize re-runs layoutViews with the new content size', () => {
    const { BrowserWindow, BrowserView } = electron;
    const win = BrowserWindow.instances[0];
    const [sidebar, content] = BrowserView.instances;
    win.getContentSize = () => [1000, 600];

    win.onHandlers.get('resize')![0]();

    expect(sidebar.bounds).toEqual({ x: 0, y: 0, width: 180, height: 600 });
    expect(content.bounds).toEqual({ x: 180, y: 0, width: 1000 - 180, height: 600 });
  });

  it('window focus checks for content updates now', () => {
    const { BrowserWindow } = electron;
    const win = BrowserWindow.instances[0];

    win.onHandlers.get('focus')![0]();

    expect(contentUpdatePollerMock.checkNow).toHaveBeenCalledTimes(1);
  });

  it('window closed clears the view refs, so a later tool:switch no-ops', async () => {
    const { BrowserWindow, BrowserView } = electron;
    const win = BrowserWindow.instances[0];
    const [, content] = BrowserView.instances;

    win.onHandlers.get('closed')![0]();
    content.webContents.loadURL.mockClear();

    await electron.__test.ipcHandlers.get('tool:switch')(null, 'map-editor');

    expect(content.webContents.loadURL).not.toHaveBeenCalled();
  });

  it('window-all-closed quits the app on non-macOS', () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      electron.__test.appOnHandlers.get('window-all-closed')[0]();
      expect(electron.app.quit).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(process, 'platform', { value: original });
    }
  });

  it('window-all-closed does NOT quit on macOS', () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      electron.__test.appOnHandlers.get('window-all-closed')[0]();
      expect(electron.app.quit).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', { value: original });
    }
  });

  it('activate re-creates the window only if none remain open', () => {
    const { BrowserWindow } = electron;
    expect(BrowserWindow.instances).toHaveLength(1);

    electron.__test.appOnHandlers.get('activate')[0]();
    expect(BrowserWindow.instances).toHaveLength(1); // a window still "exists" (static instances never shrinks)

    BrowserWindow.instances.length = 0; // simulate the window having actually closed
    electron.__test.appOnHandlers.get('activate')[0]();
    expect(BrowserWindow.instances).toHaveLength(1);
  });

  it('the dev "simulate content update" menu item shows a notice that reloads the content view', () => {
    const template = electron.__test.getLastMenuTemplate() as Array<{ submenu: Array<{ label: string; click: () => void }> }>;
    const { BrowserView } = electron;
    const [, content] = BrowserView.instances;
    const item = template[0].submenu.find(i => i.label.startsWith('Simulate: content'))!;

    item.click();

    expect(updateNotifierMock.showUpdateNotice).toHaveBeenCalledWith('content', 'animator', expect.any(Function));
    const applyReload = updateNotifierMock.showUpdateNotice.mock.calls[0][2];
    applyReload();
    expect(content.webContents.reload).toHaveBeenCalledTimes(1);
  });

  it('the dev "simulate shell update" menu item shows an app-kind notice', () => {
    const template = electron.__test.getLastMenuTemplate() as Array<{ submenu: Array<{ label: string; click: () => void }> }>;
    const item = template[0].submenu.find((i: { label: string }) => i.label.startsWith('Simulate: the shell'))!;

    item.click();

    expect(updateNotifierMock.showUpdateNotice).toHaveBeenCalledWith('app', undefined, expect.any(Function));
  });
});
