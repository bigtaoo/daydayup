/**
 * Plays a recorded run back INSIDE the client (`?replay=<url>`), which is the half of
 * the recorder that makes it useful for the report it was built for.
 *
 * A replay re-run headless answers sim questions, and the sim questions on the
 * "无法拾取的掉落物" report are already answered — 903 measured drops, zero unreachable
 * (ROADMAP v50). What is still open is a render-vs-sim disagreement: what the client
 * OFFERS versus what the sim ACCEPTS. That question cannot be asked headlessly, because
 * half of it is what the frame looks like. Playing the recording back through the real
 * client, with `?pickupDebug=1` on, puts the reported moment in front of the real
 * renderer, frame-accurate and repeatable — instead of asking the reporter to reproduce
 * it again while holding a debug flag.
 *
 * Playback freezes at the recorded moment rather than running to the end of the stream:
 * the interesting tick is the one the player marked, and a frozen sim with a live render
 * loop is exactly what a screenshot needs (the camera still moves, the overlay still
 * draws, nothing advances underneath).
 */
import { parseReplayFileText, type ReplayFile } from '@dd/engine';

/** Fetch + parse a replay file. Rejects with a message worth showing a human. */
export async function loadReplayFile(
  url: string,
  fetchFn: typeof fetch = fetch,
): Promise<ReplayFile> {
  let text: string;
  try {
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (e) {
    throw new Error(`Could not load replay ${url}: ${(e as Error).message}`);
  }
  return parseReplayFileText(text);
}

/**
 * The tick playback stops at: the LAST mark if the file has any (a player who marked
 * twice cared about both, and the later one is the one they were still looking at),
 * otherwise the end of the recording. Clamped to the recording's own length — a mark
 * past the stream would otherwise freeze on a run that idled to get there.
 */
export function replayStopTick(file: ReplayFile): number {
  const ticks = Math.max(0, file.ticks);
  const marked = file.marks.filter((m) => m.tick > 0);
  const last = marked.length ? marked[marked.length - 1]!.tick : ticks;
  return Math.min(ticks, last);
}
