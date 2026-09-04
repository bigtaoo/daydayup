/**
 * `server/src/routes/account.ts` at the unit layer — the two `/account/meta` handlers
 * after ROADMAP 8.2 moved ownership into the `entitlements` table
 * (design/19-server-platform.md §2).
 *
 * `matchsvc.http.test.ts` drives the same handlers through a real `node:http` server and
 * asserts the end-to-end shape; it is not repeated here. What this file adds is the set of
 * cases a real client cannot easily produce, and which are exactly the branches a
 * whole-blob route grew when it stopped being blind:
 *
 *  - a stored blob that is NOT an object (a string, `null`, an array), which the pre-8.2
 *    route accepted and stored verbatim and so can still be sitting in a real database;
 *  - the two 401 refusals, which never reach the table at all;
 *  - the `data === undefined` 400, asserted to have written nothing;
 *  - a granted entitlement showing up in BOTH places the response carries it — overwritten
 *    into `data`, and listed with its `source` alongside.
 *
 * The database is real (`openDb(':memory:')`) and only `AuthService` is faked: the whole
 * question here is what reaches and leaves SQLite, and a mocked db would answer none of it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { AuthService } from '../src/AuthService';
import { openDb } from '../src/db';
import { EntitlementService, blueprintSku, characterSku } from '../src/EntitlementService';
import { getMeta, postMeta, type AccountRouteDeps } from '../src/routes/account';

const ACCOUNT = 'acct-1';
const SESSION = { accountId: ACCOUNT, username: 'ada' };

let db: DatabaseSync;
let ents: EntitlementService;

interface Recorded {
  status: number;
  body: string;
}

function fakeRes(): { res: ServerResponse; sent: Recorded } {
  const sent: Recorded = { status: 0, body: '' };
  const res = {
    writeHead(status: number) {
      sent.status = status;
      return res;
    },
    end(body?: string) {
      sent.body = body ?? '';
    },
  };
  return { res: res as unknown as ServerResponse, sent };
}

function fakeReq(headers: Record<string, string> = {}): IncomingMessage & EventEmitter {
  const req = new EventEmitter() as EventEmitter & { headers: Record<string, string> };
  req.headers = headers;
  return req as unknown as IncomingMessage & EventEmitter;
}

/** A session for anyone presenting a Bearer token, none otherwise — `requireAuth`'s two
 * inputs, without standing up password hashing. */
function fakeAuth(): AuthService {
  return {
    verifySession: vi.fn((token: string) => (token ? SESSION : null)),
  } as unknown as AuthService;
}

const url = new URL('http://match.test/account/meta');
const parsed = (sent: Recorded) => JSON.parse(sent.body) as Record<string, unknown>;
const authed = () => fakeReq({ authorization: 'Bearer tok-1' });

function deps(): AccountRouteDeps {
  return { auth: fakeAuth(), db };
}

/** Drive `postMeta` to completion — `readJson` resolves on the stream's `end`. */
function post(body: unknown): Recorded {
  const req = authed();
  const { res, sent } = fakeRes();
  postMeta(req, res, url, deps());
  req.emit('data', Buffer.from(JSON.stringify(body)));
  req.emit('end');
  return sent;
}

function storedBlob(): string | undefined {
  const row = db.prepare('SELECT data FROM meta_state WHERE account_id = ?').get(ACCOUNT) as { data: string } | undefined;
  return row?.data;
}

/** Write a blob past the route, to reproduce a row a PRE-8.2 server stored. */
function seedRawBlob(raw: string): void {
  db.prepare('INSERT INTO meta_state (account_id, data) VALUES (?, ?)').run(ACCOUNT, raw);
}

beforeEach(() => {
  db = openDb(':memory:');
  db.prepare('INSERT INTO accounts (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run(
    ACCOUNT,
    'ada',
    'hash',
    1,
  );
  ents = new EntitlementService(db);
});

afterEach(() => {
  db.close();
});

describe('GET /account/meta — the session boundary', () => {
  it('401s an unauthenticated read without touching the tables', () => {
    const { res, sent } = fakeRes();
    getMeta(fakeReq(), res, url, deps());
    expect(sent.status).toBe(401);
    expect(parsed(sent)).toEqual({ error: 'invalid or expired session' });
  });
});

describe('GET /account/meta — ownership comes from entitlements, not the blob', () => {
  it('answers { data: null, entitlements: [] } for an account that has saved nothing', () => {
    const { res, sent } = fakeRes();
    getMeta(authed(), res, url, deps());
    expect(sent.status).toBe(200);
    // `data: null` is load-bearing and unchanged by 8.2: the client answers it by pushing
    // its own (possibly guest-accumulated) local state up, rather than overwriting it.
    expect(parsed(sent)).toEqual({ data: null, entitlements: [] });
  });

  it('still answers { data: null } when the account owns something but has never saved', () => {
    // The window `pullAccountMeta`'s optional `local` argument exists for: a purchase made
    // before this device ever wrote a blob. The server must NOT invent a blob here — that
    // would replace the player's local materials with defaults.
    ents.grant(ACCOUNT, characterSku('hero'), 'purchase', { orderId: 'ord-1', nowMs: 42 });
    const { res, sent } = fakeRes();
    getMeta(authed(), res, url, deps());
    expect(parsed(sent)).toEqual({
      data: null,
      entitlements: [{ sku: 'character:hero', source: 'purchase', grantedAt: 42 }],
    });
  });

  it('overwrites the stored blob ownership with the entitlements table, and lists them alongside', () => {
    seedRawBlob(JSON.stringify({ materialBank: { mat_fire: 2 }, unlockedBlueprints: ['smuggled'], ownedCharacters: ['smuggled'] }));
    ents.grant(ACCOUNT, blueprintSku('cannon'), 'purchase', { orderId: 'ord-1', nowMs: 10 });
    ents.grant(ACCOUNT, characterSku('hero'), 'grant', { nowMs: 20 });

    const { res, sent } = fakeRes();
    getMeta(authed(), res, url, deps());
    expect(parsed(sent)).toEqual({
      data: { materialBank: { mat_fire: 2 }, unlockedBlueprints: ['cannon'], ownedCharacters: ['hero'] },
      entitlements: [
        { sku: 'blueprint:cannon', source: 'purchase', grantedAt: 10 },
        { sku: 'character:hero', source: 'grant', grantedAt: 20 },
      ],
    });
  });

  it('never leaks order_id to the client — it addresses a row in billsvc private database', () => {
    ents.grant(ACCOUNT, characterSku('hero'), 'purchase', { orderId: 'ord-secret', nowMs: 1 });
    const { res, sent } = fakeRes();
    getMeta(authed(), res, url, deps());
    expect(sent.body).not.toContain('ord-secret');
    expect(Object.keys((parsed(sent).entitlements as Record<string, unknown>[])[0]!)).toEqual(['sku', 'source', 'grantedAt']);
  });

  it('reads only THIS account entitlements', () => {
    db.prepare('INSERT INTO accounts (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run(
      'acct-2',
      'bob',
      'hash',
      1,
    );
    ents.grant('acct-2', characterSku('hero'), 'grant');
    seedRawBlob(JSON.stringify({ loadout: [] }));
    const { res, sent } = fakeRes();
    getMeta(authed(), res, url, deps());
    expect(parsed(sent).data).toEqual({ loadout: [], unlockedBlueprints: [], ownedCharacters: [] });
  });

  it.each([
    ['a bare string', '"not-a-blob"', 'not-a-blob'],
    ['a stored null', 'null', null],
    ['an array', '[1,2]', [1, 2]],
  ])('returns %s verbatim rather than crashing — a pre-8.2 server accepted and stored it', (_label, raw, expected) => {
    seedRawBlob(raw);
    ents.grant(ACCOUNT, characterSku('hero'), 'grant');
    const { res, sent } = fakeRes();
    getMeta(authed(), res, url, deps());
    expect(sent.status).toBe(200);
    // The ownership still comes back in `entitlements`, so the client is not left blind.
    expect(parsed(sent).data).toEqual(expected);
    expect(parsed(sent).entitlements).toHaveLength(1);
  });
});

describe('POST /account/meta — ownership is ignored, not rejected', () => {
  it('401s an unauthenticated write without reading the body', () => {
    const req = authed();
    req.headers = {};
    const { res, sent } = fakeRes();
    postMeta(req, res, url, deps());
    expect(sent.status).toBe(401);
    // No listener was attached, so nothing would consume a body if one arrived.
    expect(req.listenerCount('end')).toBe(0);
  });

  it('400s a body with no data field and writes no row', () => {
    expect(post({}).status).toBe(400);
    expect(storedBlob()).toBeUndefined();
  });

  it('200s a blob carrying self-granted ownership, and stores it with that ownership removed', () => {
    // The free-money hole design/19 §2 closes. Accepting-and-ignoring rather than rejecting
    // is deliberate: every pre-existing guest/offline path POSTs the full MetaState.
    const sent = post({
      data: {
        materialBank: { mat_ice: 1 },
        unlockedBlueprints: ['cannon', 'emberblade'],
        ownedCharacters: ['paid-hero'],
        loadout: ['repeater'],
      },
    });
    expect(sent.status).toBe(200);
    expect(parsed(sent)).toEqual({ ok: true });
    // Stripped on WRITE, not merely overwritten on read: `meta_state` must never hold a
    // client-authored ownership claim, or a human reading the table is misled by one.
    expect(JSON.parse(storedBlob()!)).toEqual({ materialBank: { mat_ice: 1 }, loadout: ['repeater'] });
    expect(storedBlob()).not.toContain('paid-hero');
  });

  it('grants nothing — a POST is not a grant seam', () => {
    post({ data: { ownedCharacters: ['paid-hero'], unlockedBlueprints: ['cannon'] } });
    expect(ents.list(ACCOUNT)).toEqual([]);
  });

  it('upserts: a second write replaces the first blob rather than accumulating', () => {
    post({ data: { materialBank: { mat_fire: 1 } } });
    post({ data: { materialBank: { mat_ice: 9 } } });
    expect(JSON.parse(storedBlob()!)).toEqual({ materialBank: { mat_ice: 9 } });
  });

  it.each([
    ['a bare string', 'not-a-blob'],
    ['a null', null],
    ['an array', [1, 2]],
  ])('stores %s verbatim — there is nothing to strip, exactly as before 8.2', (_label, data) => {
    expect(post({ data }).status).toBe(200);
    expect(JSON.parse(storedBlob()!)).toEqual(data);
  });

  it('round-trips through GET with the server ownership written over it', () => {
    ents.grant(ACCOUNT, blueprintSku('cannon'), 'event', { nowMs: 5 });
    post({ data: { materialBank: { mat_fire: 4 }, unlockedBlueprints: ['smuggled'], ownedCharacters: ['smuggled'] } });
    const { res, sent } = fakeRes();
    getMeta(authed(), res, url, deps());
    expect(parsed(sent).data).toEqual({
      materialBank: { mat_fire: 4 },
      unlockedBlueprints: ['cannon'],
      ownedCharacters: [],
    });
  });
});
