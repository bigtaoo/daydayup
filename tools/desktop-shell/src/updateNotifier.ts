import { BrowserView, ipcMain, powerMonitor } from 'electron';

/**
 * Shared "good moment to apply" notice mechanism for both shell-level and
 * content-level updates. The notice renders in the sidebar (the shell's own UI);
 * the user clicks it, or it auto-applies once idle time crosses the threshold.
 */

export type UpdateKind = 'app' | 'content';

interface PendingUpdate {
  kind: UpdateKind;
  toolId?: string;
  apply: () => void;
}

const IDLE_THRESHOLD_SECONDS = 120; // auto-apply after 2 minutes of no input
const IDLE_CHECK_INTERVAL_MS = 30_000;

let sidebarView: BrowserView | null = null;
let pending: PendingUpdate | null = null;
let idleTimer: ReturnType<typeof setInterval> | null = null;

export function initUpdateNotifier(sidebar: BrowserView): void {
  sidebarView = sidebar;
  ipcMain.handle('shell:apply-update', () => {
    applyPending();
  });
}

/** A new notice is ignored while one is already pending (only ever show one at a time). */
export function showUpdateNotice(kind: UpdateKind, toolId: string | undefined, apply: () => void): void {
  if (pending) return;
  pending = { kind, toolId, apply };
  sidebarView?.webContents.send('shell:update-available', { kind, toolId });
  startIdleWatch();
}

function applyPending(): void {
  if (!pending) return;
  const { apply } = pending;
  clearIdleWatch();
  pending = null;
  sidebarView?.webContents.send('shell:update-cleared');
  apply();
}

function startIdleWatch(): void {
  clearIdleWatch();
  idleTimer = setInterval(() => {
    if (pending && powerMonitor.getSystemIdleTime() >= IDLE_THRESHOLD_SECONDS) {
      applyPending();
    }
  }, IDLE_CHECK_INTERVAL_MS);
}

function clearIdleWatch(): void {
  if (idleTimer) {
    clearInterval(idleTimer);
    idleTimer = null;
  }
}
