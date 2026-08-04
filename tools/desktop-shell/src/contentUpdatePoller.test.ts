import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => ({ BrowserView: class {} }));

const showUpdateNoticeMock = vi.hoisted(() => vi.fn());
vi.mock('./updateNotifier', () => ({ showUpdateNotice: showUpdateNoticeMock }));

vi.mock('./tools', () => ({
  resolveToolUrl: (tool: { devUrl: string }) => tool.devUrl,
}));

const TOOL = { id: 'animator', label: 'Animator', devUrl: 'http://localhost:5176', prodUrl: 'https://x' };

function fakeView() {
  return { webContents: { send: vi.fn(), reload: vi.fn() } };
}

function mockFetchOnce(body: unknown, ok = true) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok, json: async () => body }));
}

function mockFetchRejects() {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
}

describe('contentUpdatePoller', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    showUpdateNoticeMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('checkNow is a no-op before any tool is active (no fetch, no crash)', async () => {
    const mod = await import('./contentUpdatePoller');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    mod.checkNow();
    await vi.runOnlyPendingTimersAsync();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('confirmBaseline records the fetched hash as the baseline', async () => {
    const mod = await import('./contentUpdatePoller');
    const view = fakeView();
    mod.setActiveTool(TOOL, view as never);
    mockFetchOnce({ hash: 'abc', builtAt: 't' });

    await mod.confirmBaseline();
    // Unchanged hash on the next poll → no update fired (proves baseline == 'abc').
    mockFetchOnce({ hash: 'abc', builtAt: 't2' });
    mod.checkNow();
    await vi.runOnlyPendingTimersAsync();

    expect(showUpdateNoticeMock).not.toHaveBeenCalled();
    expect(view.webContents.send).not.toHaveBeenCalled();
  });

  it('setActiveTool clears the previous baseline, so a poll right after it is a no-op', async () => {
    const mod = await import('./contentUpdatePoller');
    const view = fakeView();
    mod.setActiveTool(TOOL, view as never);
    mockFetchOnce({ hash: 'abc', builtAt: 't' });
    await mod.confirmBaseline();

    mod.setActiveTool(TOOL, view as never); // baseline reset to null, confirmBaseline not re-awaited yet
    mockFetchOnce({ hash: 'zzz', builtAt: 't2' });
    mod.checkNow();
    await vi.runOnlyPendingTimersAsync();

    expect(showUpdateNoticeMock).not.toHaveBeenCalled();
  });

  it('an offline confirmBaseline (fetch rejects) leaves the baseline null, and polling stays a no-op', async () => {
    const mod = await import('./contentUpdatePoller');
    const view = fakeView();
    mod.setActiveTool(TOOL, view as never);
    mockFetchRejects();

    await expect(mod.confirmBaseline()).resolves.toBeUndefined();

    mockFetchOnce({ hash: 'abc', builtAt: 't' });
    mod.checkNow();
    await vi.runOnlyPendingTimersAsync();
    expect(showUpdateNoticeMock).not.toHaveBeenCalled();
  });

  it('a changed hash requests a save, waits for the ack, then shows an update notice', async () => {
    const mod = await import('./contentUpdatePoller');
    const view = fakeView();
    mod.setActiveTool(TOOL, view as never);
    mockFetchOnce({ hash: 'abc', builtAt: 't' });
    await mod.confirmBaseline();

    mockFetchOnce({ hash: 'new-hash', builtAt: 't2' });
    mod.checkNow();
    await vi.advanceTimersByTimeAsync(0); // flush the fetchVersion/res.json() microtasks
    expect(view.webContents.send).toHaveBeenCalledWith('nw:request-save');

    mod.notifySaveAck(); // tool page acked immediately, no need to wait out the 3s timeout
    await vi.advanceTimersByTimeAsync(0);
    expect(showUpdateNoticeMock).toHaveBeenCalledTimes(1);

    const [kind, toolId, applyReload] = showUpdateNoticeMock.mock.calls[0];
    expect(kind).toBe('content');
    expect(toolId).toBe('animator');
    applyReload();
    expect(view.webContents.reload).toHaveBeenCalledTimes(1);
  });

  it('proceeds via the save-ack timeout when the tool page never acks', async () => {
    const mod = await import('./contentUpdatePoller');
    const view = fakeView();
    mod.setActiveTool(TOOL, view as never);
    mockFetchOnce({ hash: 'abc', builtAt: 't' });
    await mod.confirmBaseline();

    mockFetchOnce({ hash: 'new-hash', builtAt: 't2' });
    mod.checkNow();
    await vi.advanceTimersByTimeAsync(0); // flush the fetchVersion/res.json() microtasks
    expect(view.webContents.send).toHaveBeenCalledWith('nw:request-save');

    await vi.advanceTimersByTimeAsync(3_000); // save-ack timeout, no notifySaveAck() call

    expect(showUpdateNoticeMock).toHaveBeenCalledTimes(1);
  });
});
