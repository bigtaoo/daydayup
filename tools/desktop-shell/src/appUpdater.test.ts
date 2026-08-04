import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const appState = vi.hoisted(() => ({ isPackaged: false }));
vi.mock('electron', () => ({ app: appState }));

// A minimal hand-rolled emitter (not node:events — vi.hoisted() runs before regular
// imports are evaluated, so importing EventEmitter here would throw on init order).
const autoUpdaterMock = vi.hoisted(() => {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    autoDownload: undefined as boolean | undefined,
    autoInstallOnAppQuit: undefined as boolean | undefined,
    checkForUpdates: undefined as unknown,
    quitAndInstall: undefined as unknown,
    on(event: string, cb: (...args: unknown[]) => void) {
      (listeners.get(event) ?? listeners.set(event, []).get(event)!).push(cb);
    },
    emit(event: string, ...args: unknown[]) {
      (listeners.get(event) ?? []).forEach(cb => cb(...args));
    },
    removeAllListeners() {
      listeners.clear();
    },
    listenerCount(event: string) {
      return (listeners.get(event) ?? []).length;
    },
  };
});
vi.mock('electron-updater', () => ({ autoUpdater: autoUpdaterMock }));

const showUpdateNoticeMock = vi.hoisted(() => vi.fn());
vi.mock('./updateNotifier', () => ({ showUpdateNotice: showUpdateNoticeMock }));

describe('appUpdater', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    appState.isPackaged = false;
    autoUpdaterMock.removeAllListeners();
    autoUpdaterMock.checkForUpdates = vi.fn().mockResolvedValue(undefined);
    autoUpdaterMock.quitAndInstall = vi.fn();
    showUpdateNoticeMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('no-ops in dev mode (unpackaged): no listeners, no scheduled checks', async () => {
    const { initAppUpdater } = await import('./appUpdater');
    appState.isPackaged = false;

    initAppUpdater();
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000 + 20_000);

    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();
    expect(autoUpdaterMock.listenerCount('update-downloaded')).toBe(0);
  });

  it('packaged mode: configures autoUpdater and checks 10s after start', async () => {
    const { initAppUpdater } = await import('./appUpdater');
    appState.isPackaged = true;

    initAppUpdater();

    expect(autoUpdaterMock.autoDownload).toBe(true);
    expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(false);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('packaged mode: re-checks every 4 hours after the initial check', async () => {
    const { initAppUpdater } = await import('./appUpdater');
    appState.isPackaged = true;

    initAppUpdater();
    await vi.advanceTimersByTimeAsync(10_000); // initial check
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000); // one interval later

    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('a failed checkForUpdates does not throw unhandled', async () => {
    const { initAppUpdater } = await import('./appUpdater');
    appState.isPackaged = true;
    autoUpdaterMock.checkForUpdates = vi.fn().mockRejectedValue(new Error('network down'));

    initAppUpdater();
    await vi.advanceTimersByTimeAsync(10_000); // would throw/reject if the .catch() in appUpdater didn't swallow it

    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('update-downloaded shows an update notice whose apply() quits and installs', async () => {
    const { initAppUpdater } = await import('./appUpdater');
    appState.isPackaged = true;
    initAppUpdater();

    autoUpdaterMock.emit('update-downloaded');

    expect(showUpdateNoticeMock).toHaveBeenCalledTimes(1);
    const [kind, toolId, apply] = showUpdateNoticeMock.mock.calls[0];
    expect(kind).toBe('app');
    expect(toolId).toBeUndefined();

    apply();
    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1);
  });
});
