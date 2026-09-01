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
  } catch (e) {
    // The header's promise ("reports failure by returning null instead of throwing") has
    // to hold for a host that HAS all three capabilities and still refuses — a sandboxed
    // iframe, a hardened CSP, an extension that replaced `createElement`. Before this
    // catch existed the guards above covered only the ABSENT-capability shape and a throw
    // from here propagated straight out of the F9 keydown handler, killing the frame the
    // player pressed it on. Returning null routes it to the same "this device cannot save"
    // toast the WeChat shape already gets: the player is told, and the run keeps running.
    console.warn('replay download failed', e);
    return null;
  } finally {
    // Revoked on a later task, not immediately: Safari has historically cancelled an
    // in-flight download whose object URL was revoked in the same turn as the click.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
  return name;
}

/**
 * What a save attempt did. A structured result rather than a sentence, because both
 * entry points (the F9 hotkey and the HUD button) show it to a PLAYER: the wording is
 * `Game`'s to localise (design/17 — `t()`, never an English literal in a widget), and
 * this file has no business knowing which language it is being read in.
 */
export type ReplaySaveResult =
  | { ok: true; name: string; tick: number }
  /** Nothing is being recorded — an online match, or no run started yet. */
  | { ok: false; reason: 'no-run' }
  /** The host cannot hand a file to the player (WeChat: no Blob, no anchor). */
  | { ok: false; reason: 'unsupported' };

/**
 * The save verb behind both entry points: mark this tick, pack the run, hand it over.
 * Separated from `Game` so the flow is testable without a Pixi app, and takes `download`
 * as a parameter for the same reason — the default is the real one above.
 *
 * A failure must never be silent: whoever is pressing this is doing it BECAUSE something
 * already went wrong, and a control that quietly does nothing costs a whole report cycle
 * to notice. Hence a result for every path, and a toast on every one of them.
 */
export function saveMarkedReplay(
  recorder: MatchRecorder,
  tick: number,
  nowMs: number,
  download: (file: ReplayFile) => string | null = downloadReplayFile,
): ReplaySaveResult {
  // No `recorder.recording` early-out: `pack` already returns null in exactly that case
  // and this returns the same result either way. A mutation battery found the guard
  // survived being deleted, which is what a redundant check looks like.
  recorder.mark(tick, `hotkey at tick ${tick}`);
  const file = recorder.pack(tick, nowMs);
  if (!file) return { ok: false, reason: 'no-run' };
  const name = download(file);
  return name ? { ok: true, name, tick } : { ok: false, reason: 'unsupported' };
}
