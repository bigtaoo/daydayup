/**
 * Hands a recorded run to the player as a file (`MatchRecorder` produces it).
 *
 * Split out from the recorder because this half is the only part that touches the
 * host: an anchor, a Blob and an object URL, none of which exist in the WeChat
 * mini-game runtime (`design/04` — no DOM, no Blob, and its file system is
 * `wx.getFileSystemManager`). Every capability is feature-detected and the function
 * reports failure by returning null instead of throwing, so the caller can say
 * "can't save here" rather than the hotkey killing the frame.
 */
import { replayFileName, type ReplayFile } from '@dd/engine';
import type { MatchRecorder } from './MatchRecorder';

/** Downloads `file` as JSON. Returns the file name, or null if the host can't. */
export function downloadReplayFile(file: ReplayFile): string | null {
  if (typeof document === 'undefined' || typeof Blob === 'undefined') return null;
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null;

  const name = replayFileName(file.label, file.recordedAtMs);
  const url = URL.createObjectURL(new Blob([JSON.stringify(file)], { type: 'application/json' }));
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    // Not appended to the document: a synthetic click on a detached anchor downloads in
    // every browser this client targets, and appending would mutate the page the game
    // canvas lives in for the duration of the click.
    a.click();
  } finally {
    // Revoked on a later task, not immediately: Safari has historically cancelled an
    // in-flight download whose object URL was revoked in the same turn as the click.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
  return name;
}

/**
 * The hotkey's whole job: mark this tick, pack the run, save it, and return the one
 * line to show the player. Separated from `Game` so the flow is testable without a
 * Pixi app, and takes `download` as a parameter for the same reason — the default is
 * the real one above.
 *
 * Returns a message either way. A failure here must never be silent: the player is
 * pressing this key BECAUSE something already went wrong, and a hotkey that quietly
 * does nothing would cost a whole report cycle to notice.
 */
export function saveMarkedReplay(
  recorder: MatchRecorder,
  tick: number,
  nowMs: number,
  download: (file: ReplayFile) => string | null = downloadReplayFile,
): string {
  if (!recorder.recording) return 'No offline run to save';
  recorder.mark(tick, `hotkey at tick ${tick}`);
  const file = recorder.pack(tick, nowMs);
  if (!file) return 'No offline run to save';
  const name = download(file);
  return name ? `Replay saved: ${name} (tick ${tick})` : 'Cannot save a replay on this platform';
}
