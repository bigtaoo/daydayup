import { ipcMain } from 'electron';

/**
 * Placeholder interface for a future outsourced-artist git workflow. All methods
 * currently return not_implemented; the IPC channel names are the stable contract —
 * when a real implementation lands (isomorphic-git + a scoped token), only the
 * function bodies here change, not the tool-page call sites.
 */

interface GitStatusResult {
  dirty: boolean;
  branch: string;
  ahead: number;
}

interface GitCommitResult {
  ok: boolean;
  commitSha?: string;
  error?: string;
}

interface GitPrResult {
  ok: boolean;
  prUrl?: string;
  error?: string;
}

function status(_workdir: string): Promise<GitStatusResult & { error?: string }> {
  return Promise.resolve({ dirty: false, branch: '', ahead: 0, error: 'not_implemented' });
}

function commitAndPush(_opts: {
  workdir: string;
  message: string;
  branch?: string;
  authorName: string;
  authorEmail: string;
}): Promise<GitCommitResult> {
  return Promise.resolve({ ok: false, error: 'not_implemented' });
}

function openOrUpdatePR(_opts: { branch: string; title: string; body: string }): Promise<GitPrResult> {
  return Promise.resolve({ ok: false, error: 'not_implemented' });
}

export function registerGitSyncHandlers(): void {
  ipcMain.handle('git:status', (_e, workdir: string) => status(workdir));
  ipcMain.handle('git:commitAndPush', (_e, opts) => commitAndPush(opts));
  ipcMain.handle('git:openOrUpdatePR', (_e, opts) => openOrUpdatePR(opts));
}
