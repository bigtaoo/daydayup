/**
 * Split of `matchsvc.ts` (P0, 2026-09-04, prep for ROADMAP Phase 8) — the transport
 * primitives every route group in this directory shares: the CORS header block, the JSON
 * responder, the bounded JSON body reader, and the one shape a route handler has.
 *
 * This file owns no service and no route. It deliberately sits BELOW `routes/*` and below
 * the `matchsvc.ts` shell, so a handler may import it while nothing here imports a handler
 * back — CLAUDE.md's rule that a split-out sibling never imports the assembly shell (which
 * is what a `send` left behind in `matchsvc.ts` would have forced).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * The uniform shape of a matchsvc route handler: the request, the response, the already
 * parsed URL (a handler owning a `/:param` route re-matches its own pattern out of this
 * rather than taking a positional capture), and its group's typed dependency bundle.
 *
 * Handlers are free functions, not methods — the whole point of the split. `matchsvc.ts`
 * keeps the dispatch chain that decides which one runs.
 */
export type RouteHandler<D> = (req: IncomingMessage, res: ServerResponse, url: URL, deps: D) => void;

export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  // 'authorization' (design/16-accounts.md) — every /auth/me and /account/* call sends
  // a bearer token; omitting it here makes the browser's CORS preflight reject the
  // real request before it's even sent (fails as a bare "Failed to fetch", no server
  // log at all — caught live via claude-in-chrome, not by any unit test, since node's
  // fetch/undici and curl don't enforce browser CORS preflight rules).
  'access-control-allow-headers': 'content-type, authorization',
};

export function send(res: ServerResponse, status: number, body: unknown): void {
  const json = status === 204 ? '' : JSON.stringify(body);
  res.writeHead(status, { ...CORS, 'content-type': 'application/json' });
  res.end(json);
}

/** Read a JSON request body (bounded), then invoke `done`. Malformed/oversized → {}. */
export function readJson(req: IncomingMessage, done: (body: unknown) => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size > 4096) return; // a find request is tiny; ignore the overflow tail
    chunks.push(c);
  });
  req.on('end', () => {
    try {
      done(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
    } catch {
      done({});
    }
  });
  req.on('error', () => done({}));
}
