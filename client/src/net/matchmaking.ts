/**
 * Client matchmaking (ROADMAP 3.3, design/06) — the client counterpart to the server's
 * matchsvc control plane. It asks for a match and returns the signed seat ticket the
 * client then redeems on the gameserver socket (`${wsUrl}?ticket=${token}`), so the
 * player never hand-picks a roomId/seat — the control plane assigns and signs them.
 *
 * Poll-based to match matchsvc: `POST /find` enqueues (and may return the match inline if
 * this player completes a group), else we poll `GET /find/:queueId` until `matched`.
 * `fetch`/`sleep` are injected so the whole flow is unit-testable with a fake — the ONLY
 * real-network dependency, mirroring how transport.ts isolates the WebSocket.
 */

/** Everything needed to open the gameserver socket for the assigned seat. */
export interface MatchInfo {
  wsUrl: string;
  roomId: string;
  owner: number;
  seed: number;
  playerCount: number;
  token: string;
}

export interface FindMatchOptions {
  playerCount: number;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Injected for tests; defaults to a real timer sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Poll cadence while queued (ms). Default 500. */
  pollIntervalMs?: number;
  /** Give up after this long queued (ms). Default 60 s. */
  timeoutMs?: number;
  /** Cooperative cancel — checked each poll; when true, throws `matchmaking cancelled`. */
  signal?: { cancelled: boolean };
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Find (or wait for) a match. Resolves with the seat's MatchInfo, or rejects if the
 * queue times out / the request expires server-side / the service errors. `baseUrl` is
 * the matchsvc origin (e.g. `http://localhost:8788`), no trailing slash.
 */
export async function findMatch(baseUrl: string, opts: FindMatchOptions): Promise<MatchInfo> {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? realSleep;
  const pollIntervalMs = opts.pollIntervalMs ?? 500;
  const timeoutMs = opts.timeoutMs ?? 60_000;

  const findRes = await doFetch(`${baseUrl}/find`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerCount: opts.playerCount }),
  });
  const found = (await findRes.json()) as { queueId?: string; match?: MatchInfo; error?: string };
  if (!findRes.ok || found.error) throw new Error(found.error ?? `matchmaking failed (${findRes.status})`);
  if (found.match) return found.match; // this arrival completed the group
  if (!found.queueId) throw new Error('matchmaking: no queueId returned');

  const deadline = timeoutMs; // relative budget, tracked by elapsed polls below
  let elapsed = 0;
  for (;;) {
    if (opts.signal?.cancelled) throw new Error('matchmaking cancelled');
    await sleep(pollIntervalMs);
    elapsed += pollIntervalMs;

    const pollRes = await doFetch(`${baseUrl}/find/${encodeURIComponent(found.queueId)}`);
    const status = (await pollRes.json()) as { status?: string; match?: MatchInfo };
    if (status.status === 'matched' && status.match) return status.match;
    if (status.status === 'expired') throw new Error('matchmaking: request expired');
    if (elapsed >= deadline) throw new Error('matchmaking: timed out waiting for a match');
    // otherwise 'queued' → keep polling
  }
}
