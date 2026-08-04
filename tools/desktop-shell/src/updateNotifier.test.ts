import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
const powerMonitorMock = vi.hoisted(() => ({ getSystemIdleTime: vi.fn(() => 0) }));
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, fn);
    }),
  },
  powerMonitor: powerMonitorMock,
}));

function fakeSidebar() {
  return { webContents: { send: vi.fn() } };
}

describe('updateNotifier', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    ipcHandlers.clear();
    powerMonitorMock.getSystemIdleTime.mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('showUpdateNotice sends shell:update-available to the sidebar', async () => {
    const { initUpdateNotifier, showUpdateNotice } = await import('./updateNotifier');
    const sidebar = fakeSidebar();
    initUpdateNotifier(sidebar as never);

    showUpdateNotice('content', 'animator', vi.fn());

    expect(sidebar.webContents.send).toHaveBeenCalledWith('shell:update-available', { kind: 'content', toolId: 'animator' });
  });

  it('ignores a second notice while one is already pending', async () => {
    const { initUpdateNotifier, showUpdateNotice } = await import('./updateNotifier');
    const sidebar = fakeSidebar();
    initUpdateNotifier(sidebar as never);

    showUpdateNotice('content', 'animator', vi.fn());
    showUpdateNotice('app', undefined, vi.fn());

    expect(sidebar.webContents.send).toHaveBeenCalledTimes(1);
  });

  it('shell:apply-update IPC handler applies the pending update and notifies the sidebar', async () => {
    const { initUpdateNotifier, showUpdateNotice } = await import('./updateNotifier');
    const sidebar = fakeSidebar();
    initUpdateNotifier(sidebar as never);
    const apply = vi.fn();
    showUpdateNotice('app', undefined, apply);

    await ipcHandlers.get('shell:apply-update')!();

    expect(apply).toHaveBeenCalledTimes(1);
    expect(sidebar.webContents.send).toHaveBeenCalledWith('shell:update-cleared');
  });

  it('a new notice can be shown again after the pending one was applied', async () => {
    const { initUpdateNotifier, showUpdateNotice } = await import('./updateNotifier');
    const sidebar = fakeSidebar();
    initUpdateNotifier(sidebar as never);
    showUpdateNotice('content', 'animator', vi.fn());
    await ipcHandlers.get('shell:apply-update')!();

    showUpdateNotice('content', 'map-editor', vi.fn());

    expect(sidebar.webContents.send).toHaveBeenCalledWith('shell:update-available', { kind: 'content', toolId: 'map-editor' });
  });

  it('does NOT auto-apply while the system is still active (idle time below threshold)', async () => {
    const { initUpdateNotifier, showUpdateNotice } = await import('./updateNotifier');
    const sidebar = fakeSidebar();
    initUpdateNotifier(sidebar as never);
    const apply = vi.fn();
    powerMonitorMock.getSystemIdleTime.mockReturnValue(5);
    showUpdateNotice('app', undefined, apply);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(apply).not.toHaveBeenCalled();
  });

  it('auto-applies once the system has been idle past the threshold', async () => {
    const { initUpdateNotifier, showUpdateNotice } = await import('./updateNotifier');
    const sidebar = fakeSidebar();
    initUpdateNotifier(sidebar as never);
    const apply = vi.fn();
    powerMonitorMock.getSystemIdleTime.mockReturnValue(0);
    showUpdateNotice('app', undefined, apply);

    // Idle check runs every 30s; only crosses the 120s threshold once idle time itself reads that high.
    powerMonitorMock.getSystemIdleTime.mockReturnValue(120);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(apply).toHaveBeenCalledTimes(1);
  });
});
