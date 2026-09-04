/**
 * billsvc's HTTP surface (design/19-server-platform.md §4/§5) — the billing plane, a
 * third process on `BILL_PORT` (default 8789), deliberately not folded into the control
 * plane: matchsvc restarts on a matchmaking cadence, and platform callbacks need a stable
 * entry point, pinned credentials and an audit boundary.
 *
 * The ONLY file in this package that touches `node:http`, exactly as `matchsvc.ts` is for
 * the control plane and `index.ts` for the data plane. `createBillsvcServer` builds the
 * server WITHOUT starting it — the seam that makes real requests testable on an ephemeral
 * port — and `main.ts` is the CLI entry point.
 *
 *   GET  /health                                            → { ok, service }
 *   GET  /skus                                              → { skus }                       (public)
 *   POST /order/create   { accountId, sku, platform }        → { order, payment } | 400 | 401 (internal)
 *   GET  /order/:id                                         → { order } | 404 | 401          (internal)
 *   POST /webhook/:platform { orderId, receipt, txnId, event? }
 *                                                           → { delivered } | 400 | 404      (platform-signed)
 *
 * WHO MAY CALL WHAT. Every route except the webhook is behind the internal-key guard: a
 * player's client never talks to this port, it asks the control plane, which forwards with
 * its internal key. `/skus` is the exception in the other direction — a price list is
 * public by definition and holding it behind a key buys nothing.
 *
 * The webhook is NOT internal-key authenticated, by design (§3: "authenticated by the
 * platform's own signature instead"). No platform credential exists in this project (§9),
 * so today the only thing standing between that route and the database is receipt
 * verification — which is precisely why `iap/factory.ts` fails closed on missing
 * credentials, and why a `product:` receipt is inert unless the dev stub is enabled.
 *
 * `POST /order/create` DROPS `amount`. Reading the field and ignoring it would be the same
 * behaviour; not reading it is the version that survives someone adding a "pass-through"
 * later (design/19 §4: "An `amount` in the request body is discarded").
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { openBillingDb } from '../billingDb';
import { BillingService, type BillingServiceDeps } from './BillingService';
import { internalKeys } from '../config';
import { createInternalVerifier, describeInternalAuthFailure, type InternalVerifier } from '../internalAuth';
import { createReceiptVerifier, devStubEnabled, type BillingEnv } from './iap/factory';
import { asIapPlatform, type ReceiptVerifier } from './iap/types';
import type { EntitlementDelivery } from './delivery';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  // `x-internal-key` is deliberately NOT advertised here. Every internal route is called
  // process-to-process, never from a browser, so a preflight never needs it — and listing
  // it would invite a client to try. `internalAuth.ts`'s own header note says the same.
  'access-control-allow-headers': 'content-type',
};

/**
 * What billsvc calls the process on the other end of an internal call, for audit lines.
 * The control plane is the only one: a player's client never reaches this port, it asks
 * matchsvc, which forwards with its internal key.
 */
export const INTERNAL_CALLER_CONTROL_PLANE = 'matchsvc';

export interface BillsvcServerOptions {
  /** Billing DB path. Tests pass `':memory:'`; defaults to `defaultBillingDbPath()`. */
  dbPath?: string;
  /** An already-open billing DB, for a test that wants to inspect rows directly. */
  db?: DatabaseSync;
  /** Environment the credential/stub policy is read from. Defaults to `process.env`. */
  env?: BillingEnv;
  /** Receipt verifier override. Defaults to `createReceiptVerifier(env)`. */
  verify?: ReceiptVerifier;
  /** Entitlement delivery, called inside the settlement transaction (`delivery.ts`). */
  deliver?: EntitlementDelivery;
  /**
   * A pre-built `BillingService`, replacing everything above it. The routes are a thin
   * shell over this object, so this is the only seam from which a test can make a
   * settlement REJECT rather than resolve — the case the webhook's last-resort `.catch`
   * exists for, and which no `verify`/`deliver` override can produce now that `settle`
   * swallows both. Same reason `matchsvc.ts` injects `spawnBot`.
   */
  billing?: BillingService;
  /**
   * Internal-key verifier override. OPTIONAL, and the default is not "no auth" — it is
   * `internalAuth`'s verifier over `config.ts`'s env-derived registry, the same default
   * `routes/rating.ts` takes. The seam exists so a test can pin a registry without touching
   * `process.env`.
   */
  internalAuth?: InternalVerifier;
  nowMs?: BillingServiceDeps['nowMs'];
  newOrderId?: BillingServiceDeps['newOrderId'];
}

export interface BillsvcServer {
  server: Server;
  billing: BillingService;
  db: DatabaseSync;
}

export function createBillsvcServer(opts: BillsvcServerOptions = {}): BillsvcServer {
  const env = opts.env ?? process.env;
  const db = opts.db ?? openBillingDb(opts.dbPath);
  const billing =
    opts.billing ??
    new BillingService({
      db,
      verify: opts.verify ?? createReceiptVerifier(env),
      deliver: opts.deliver,
      nowMs: opts.nowMs,
      newOrderId: opts.newOrderId,
      devStubOn: devStubEnabled(env),
    });
  // ROADMAP 8.1's shared verifier (`server/src/internalAuth.ts`), not a billsvc-local check:
  // one namespace, one fail-closed posture, one place to add per-caller keys. `config.ts`'s
  // registry names its single entry `gameserver` because that was the first hop to need a
  // key; the caller that reaches BILLSVC is the control plane, so the label is corrected
  // here rather than left to say something false in an audit line. Splitting the shared
  // secret into a key per caller is the growth path that registry already anticipates —
  // when it happens, this relabel is what gets deleted.
  const internalAuth =
    opts.internalAuth ??
    createInternalVerifier(internalKeys().registry.map((entry) => ({ ...entry, caller: INTERNAL_CALLER_CONTROL_PLANE })));

  /** Verifies an internal call, logging the rejection and telling the caller only "unauthorized". */
  const refuseUnlessInternal = (req: IncomingMessage, res: ServerResponse, route: string): boolean => {
    const auth = internalAuth.verify(req.headers);
    if (auth.ok) return false;
    // The reason (and the caller's own advisory, untrusted claim) goes to the operator, not
    // into the response — design/19 §7's "log every event, not just the successful one".
    console.warn(describeInternalAuthFailure(auth, route));
    send(res, 401, { error: 'unauthorized' });
    return true;
  };

  const server = createServer((req, res) => {
    if (req.method === 'OPTIONS') return send(res, 204, {});
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { ok: true, service: 'daydayup-billsvc' });
    }

    if (req.method === 'GET' && url.pathname === '/skus') {
      return send(res, 200, { skus: billing.listSkus() });
    }

    if (req.method === 'POST' && url.pathname === '/order/create') {
      if (refuseUnlessInternal(req, res, 'POST /order/create')) return;
      return readJson(req, (body) => {
        const b = (body ?? {}) as { accountId?: unknown; sku?: unknown; platform?: unknown };
        // `amount` is not read. See the file header.
        const result = billing.createOrder({ accountId: b.accountId, sku: b.sku, platform: b.platform });
        if (!result.ok) return send(res, 400, { error: result.error });
        send(res, 200, { order: result.order, payment: result.payment });
      });
    }

    const orderLookup = url.pathname.match(/^\/order\/([^/]+)$/);
    if (req.method === 'GET' && orderLookup) {
      if (refuseUnlessInternal(req, res, 'GET /order/:id')) return;
      const order = billing.getOrder(decodeURIComponent(orderLookup[1]!));
      if (!order) return send(res, 404, { error: 'not found' });
      return send(res, 200, { order });
    }

    const webhook = url.pathname.match(/^\/webhook\/([^/]+)$/);
    if (req.method === 'POST' && webhook) {
      const platform = asIapPlatform(decodeURIComponent(webhook[1]!));
      if (!platform) return send(res, 404, { error: 'unknown platform' });
      return readJson(req, (body) => {
        const b = (body ?? {}) as { orderId?: unknown; receipt?: unknown; txnId?: unknown; event?: unknown };
        const orderId = typeof b.orderId === 'string' ? b.orderId : '';

        // A failure/cancel callback closes the order and grants nothing. Handled here
        // rather than inside `settle` because it has no receipt to verify — treating it as
        // a settlement with a missing receipt would report it as a verification failure,
        // which is a different (and alarming) thing from "the player cancelled".
        if (b.event === 'failed' || b.event === 'cancelled') {
          if (!orderId) return send(res, 400, { error: 'orderId required' });
          const marked = billing.markFailed({ orderId });
          if (!marked.ok) return send(res, 404, { error: 'not found' });
          return send(res, 200, { ok: true, state: 'failed', changed: marked.changed });
        }

        void billing
          .settle({
            platform,
            orderId,
            receipt: typeof b.receipt === 'string' ? b.receipt : '',
            txnId: typeof b.txnId === 'string' ? b.txnId : '',
          })
          .then((result) => {
            if (result.ok) {
              return send(res, 200, {
                ok: true,
                orderId: result.orderId,
                sku: result.sku,
                delivered: result.delivered,
                note: result.note,
              });
            }
            // A rejection is a 4xx so the platform's retry stops on a permanent refusal and
            // an operator sees it. Which codes a specific platform wants folded into a 200
            // to stop ITS retry loop is a per-platform question, and belongs with ROADMAP
            // 8.5's webhook event log rather than being guessed at here.
            send(res, result.code === 'unknown-order' ? 404 : 400, { error: result.reason, code: result.code });
          })
          // `settle` is written to be total — it catches a throwing verifier and a throwing
          // delivery — but this route is the one place where losing that promise means no
          // response is ever sent and the platform's request hangs until its own timeout.
          // A 500 tells it to retry; silence tells it nothing.
          .catch((e: unknown) => send(res, 500, { error: (e as Error).message, code: 'internal' }));
      });
    }

    send(res, 404, { error: 'not found' });
  });

  return { server, billing, db };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = status === 204 ? '' : JSON.stringify(body);
  res.writeHead(status, { ...CORS, 'content-type': 'application/json' });
  res.end(json);
}

/**
 * Read a JSON request body (bounded), then invoke `done`. Malformed/oversized → `{}`.
 * Same shape as `matchsvc.ts`'s, with a larger cap: an Apple receipt is a base64 blob of
 * several kilobytes, so matchsvc's 4 KB find-request ceiling would silently truncate a
 * real webhook body into a parse failure.
 */
function readJson(req: IncomingMessage, done: (body: unknown) => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let overflow = false;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size > 256 * 1024) {
      overflow = true;
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (overflow) return done({});
    try {
      done(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
    } catch {
      done({});
    }
  });
  // UNOBSERVABLE, AND KEPT ANYWAY — recorded here so the next reader does not have to
  // re-derive it. A 2026-09-04 mutation battery deleted this line and all 221 tests stayed
  // green. That is not a test gap: probed directly on node v26, an aborted request emits
  // 'aborted' and 'error' on `req` and never emits 'end', but with NO 'error' listener node
  // routes it internally — no uncaughtException, process unharmed. So there is no behaviour
  // for a test to pin, and `done({})` here only ever writes to a socket that is already
  // gone. It stays for two reasons: it is the same idiom `matchsvc.ts`'s `readJson` uses, and
  // node's "unhandled 'error' throws" rule is a runtime detail this file should not depend
  // on. `billsvc.http.test.ts`'s mid-upload-disconnect case covers the OUTCOME that matters
  // either way (the process keeps serving and books nothing); it does not cover this line.
  req.on('error', () => done({}));
}
