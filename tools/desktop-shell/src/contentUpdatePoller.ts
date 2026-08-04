import { BrowserView } from 'electron';
import type { ToolConfig } from './tools';
import { resolveToolUrl } from './tools';
import { showUpdateNotice } from './updateNotifier';

/**
 * Content-level hot-update polling for each tool's built assets. Each tool's Vite
 * build emits version.json (see build/versionManifestPlugin.mjs), which the dev
 * server also serves as a build artifact — no extra config needed.
 */

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const SAVE_ACK_TIMEOUT_MS = 3_000;

interface VersionManifest {
  hash: string;
  builtAt: string;
}

let activeTool: ToolConfig | null = null;
let contentView: BrowserView | null = null;
let baselineHash: string | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let saveAckWaiters: Array<() => void> = [];

async function fetchVersion(tool: ToolConfig): Promise<VersionManifest | null> {
  try {
    const url = new URL('/version.json', resolveToolUrl(tool)).toString();
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as VersionManifest;
  } catch {
    return null; // offline / no manifest: skip this round, not treated as an error
  }
}

/** Tool page received 'nw:request-save', flushed to disk, and sent back 'nw:save-ack'; main.ts forwards here to release the wait. */
export function notifySaveAck(): void {
  const waiters = saveAckWaiters;
  saveAckWaiters = [];
  waiters.forEach((resolve) => resolve());
}

function waitForSaveAck(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    saveAckWaiters.push(resolve);
    setTimeout(resolve, timeoutMs);
  });
}

/**
 * Called synchronously on tool switch: clears the old baseline immediately so the
 * previous tool's hash never gets compared against the new one. The real baseline
 * is written by the subsequent confirmBaseline() call.
 */
export function setActiveTool(tool: ToolConfig, view: BrowserView): void {
  activeTool = tool;
  contentView = view;
  baselineHash = null;
}

/** Called once the active tool's page finishes loading (covers both switchTool's first load and a hot-update-triggered reload). */
export async function confirmBaseline(): Promise<void> {
  if (!activeTool) return;
  const manifest = await fetchVersion(activeTool);
  baselineHash = manifest?.hash ?? null;
}

async function pollOnce(): Promise<void> {
  if (!activeTool || !contentView || baselineHash === null) return;
  const manifest = await fetchVersion(activeTool);
  if (!manifest || manifest.hash === baselineHash) return;

  const tool = activeTool;
  const view = contentView;
  view.webContents.send('nw:request-save');
  await waitForSaveAck(SAVE_ACK_TIMEOUT_MS);

  showUpdateNotice('content', tool.id, () => {
    view.webContents.reload();
  });
}

function safePollOnce(): void {
  pollOnce().catch((err) => console.error('[desktop-shell] content update poll failed:', err));
}

export function startContentUpdatePolling(): void {
  if (pollTimer) return;
  pollTimer = setInterval(safePollOnce, POLL_INTERVAL_MS);
}

/** Check early when the window regains focus, instead of waiting for the next poll cycle. */
export function checkNow(): void {
  safePollOnce();
}
