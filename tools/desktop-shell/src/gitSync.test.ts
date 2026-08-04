import { describe, it, expect, vi } from 'vitest';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));

import { registerGitSyncHandlers } from './gitSync';

describe('gitSync', () => {
  registerGitSyncHandlers();

  it('registers the three expected IPC channels', () => {
    expect([...handlers.keys()].sort()).toEqual(
      ['git:commitAndPush', 'git:openOrUpdatePR', 'git:status'].sort(),
    );
  });

  it('git:status resolves not_implemented (placeholder, no real git access yet)', async () => {
    const result = await handlers.get('git:status')!(null, '/some/workdir');
    expect(result).toEqual({ dirty: false, branch: '', ahead: 0, error: 'not_implemented' });
  });

  it('git:commitAndPush resolves not_implemented', async () => {
    const result = await handlers.get('git:commitAndPush')!(null, {
      workdir: '/w', message: 'm', authorName: 'a', authorEmail: 'a@x.com',
    });
    expect(result).toEqual({ ok: false, error: 'not_implemented' });
  });

  it('git:openOrUpdatePR resolves not_implemented', async () => {
    const result = await handlers.get('git:openOrUpdatePR')!(null, {
      branch: 'b', title: 't', body: 'body',
    });
    expect(result).toEqual({ ok: false, error: 'not_implemented' });
  });
});
