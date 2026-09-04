/**
 * The webhook event log (design/19-server-platform.md §7, ROADMAP 8.5). A sibling module of
 * free functions over the billing `DatabaseSync` — CLAUDE.md's first split form, and
 * deliberately not a method on `BillingService`: recording what a callback SAID is a
 * different concern from deciding what it MEANS, and it has to happen for callbacks that
 * never reach `settle` at all.
 *
 * WHAT THIS FIXES. Before it, only a callback that parsed, verified and settled left a trace
 * — the `orders`/`receipts`/`ledger` rows. A failed one, a cancelled one, one naming an
 * event type nobody here knows, and one whose body is not even JSON all took a branch in
 * `server.ts` and vanished. "Why did my payment not go through" then has no evidence behind
 * it at all, which is funny's stated reason for shipping this table, and it is the only
 * evidence source for the question in this whole project.
 *
 * THE KEY IS `${txnId}:${eventType}`, AND UPSERT IS THE POINT. Platform redelivery is
 * at-least-once by contract (design/19 §4), so an append-only log of raw callbacks would
 * hold five near-identical rows for one payment and an operator would have to work out
 * which. Keyed and upserted, one payment is one row per event type, carrying how many times
 * it arrived and when it last did.
 *
 * WHEN THE BODY CARRIES NO TRANSACTION ID. That is not an edge case to shrug at — it is
 * precisely the malformed/unparsable callback whose evidence is worth the most, and the case
 * a naive `${txnId}:${eventType}` key collapses into ONE row that every unrelated bad
 * payload then overwrites. `webhookEventKey` therefore falls back twice: to the merchant
 * order id, and failing that to a hash of the raw bytes. The hash is a legitimate key rather
 * than a giving-up value, because a platform retry of an unparsable body repeats the same
 * bytes — so the redelivery still lands on its own row, which is the whole property.
 *
 * WHAT IS AND IS NOT UPDATED ON A REDELIVERY:
 *
 *   raw           KEPT as first written. A retry is supposed to repeat itself, so the first
 *                 body is the evidence; overwriting it would let a later forgery erase what
 *                 the platform originally sent.
 *   divergences   incremented when the new body DIFFERS from the stored one. That is the
 *                 forgery shape design/19 §4's AMENDMENT 1 already had to close on the
 *                 settlement path (a body varying `txnId` under one receipt), seen from the
 *                 other side, and counting it costs one expression in the UPSERT.
 *   outcome       OVERWRITTEN with the latest. The account's state reflects the last
 *                 decision, so a log whose outcome said something else would be misleading
 *                 in exactly the situation it is read in.
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/**
 * The event types this plane recognises. `purchase` is also what an ABSENT `event` field
 * means — every platform's success callback is the one that omits it in this project's
 * shape, and `server.ts` has always treated it that way.
 *
 * `unknown` is a real member rather than a parse failure: a platform that starts sending
 * `refunded` or `chargeback` must be RECORDED and not acted on, and the row is how anyone
 * finds out it started.
 */
export type WebhookEventType = 'purchase' | 'failed' | 'cancelled' | 'unknown';

const KNOWN_EVENTS: readonly string[] = ['purchase', 'failed', 'cancelled'];

/**
 * Normalise the body's `event` field.
 *
 * Absent, empty and non-string all mean `purchase`, because that is what a success callback
 * looks like here and refusing one for lacking a field it never had would break every
 * platform at once. Anything else that is a string but not known is `unknown` — deliberately
 * NOT settled, see `server.ts`.
 */
export function webhookEventType(event: unknown): WebhookEventType {
  if (event === undefined || event === null) return 'purchase';
  if (typeof event !== 'string') return 'unknown';
  const trimmed = event.trim().toLowerCase();
  if (trimmed === '') return 'purchase';
  return KNOWN_EVENTS.includes(trimmed) ? (trimmed as WebhookEventType) : 'unknown';
}

/** What the handler did with a callback. Every value is a branch with its own test. */
export type WebhookOutcome =
  /** Settled and delivered — the happy path. */
  | 'settled'
  /** A settle that won nothing because this receipt had already been consumed by this account. */
  | 'already-delivered'
  /** An explicit failure/cancel event that closed an open order. */
  | 'marked-failed'
  /** A failure/cancel event for an order that was already closed. */
  | 'no-change'
  /** Recognised as a callback, deliberately not acted on (an unknown event type). */
  | 'ignored'
  /** Refused: a `SettleRejectionCode`, an unknown order, or a missing field. */
  | 'rejected';

export interface WebhookEventInput {
  platform: string;
  /** From the parsed body, when there was one. */
  orderId?: string | null;
  txnId?: string | null;
  eventType: WebhookEventType;
  outcome: WebhookOutcome;
  /** Rejection code / reason. `null` on a clean outcome. */
  detail?: string | null;
  /** The ORIGINAL bytes as they arrived — parsed or not. The reason this table exists. */
  raw: string;
  ts: number;
}

/** One `webhook_events` row, in this codebase's camelCase rather than SQL's snake_case. */
export interface WebhookEventRecord {
  id: string;
  platform: string;
  orderId: string | null;
  txnId: string | null;
  eventType: WebhookEventType;
  outcome: WebhookOutcome;
  detail: string | null;
  raw: string;
  firstSeenAt: number;
  lastSeenAt: number;
  seenCount: number;
  divergences: number;
}

interface WebhookEventSqlRow {
  id: string;
  platform: string;
  order_id: string | null;
  txn_id: string | null;
  event_type: string;
  outcome: string;
  detail: string | null;
  raw: string;
  first_seen_at: number;
  last_seen_at: number;
  seen_count: number;
  divergences: number;
}

function toRecord(r: WebhookEventSqlRow): WebhookEventRecord {
  return {
    id: r.id,
    platform: r.platform,
    orderId: r.order_id,
    txnId: r.txn_id,
    eventType: r.event_type as WebhookEventType,
    outcome: r.outcome as WebhookOutcome,
    detail: r.detail,
    raw: r.raw,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    seenCount: r.seen_count,
    divergences: r.divergences,
  };
}

const COLUMNS =
  'id, platform, order_id, txn_id, event_type, outcome, detail, raw, first_seen_at, last_seen_at, seen_count, divergences';

/** Prefix of the order-id fallback key, so an operator can tell the three key shapes apart. */
export const ORDER_KEY_PREFIX = 'order:';
/** Prefix of the raw-hash fallback key. */
export const RAW_KEY_PREFIX = 'raw:';

/**
 * `${txnId}:${eventType}` — design/19 §7's named key — with the two fallbacks the header
 * explains. Pure, and exported separately from the write so a test can pin the key shape
 * without a database.
 *
 * The hash is truncated to 16 hex characters. That is 64 bits over a per-platform,
 * per-event-type namespace of malformed callbacks; a collision there merges two rows in an
 * evidence table, which is a cost worth an id a human can read back out of a terminal.
 */
export function webhookEventKey(input: { txnId?: string | null; orderId?: string | null; raw: string; eventType: WebhookEventType }): string {
  const txn = (input.txnId ?? '').trim();
  if (txn) return `${txn}:${input.eventType}`;
  const order = (input.orderId ?? '').trim();
  if (order) return `${ORDER_KEY_PREFIX}${order}:${input.eventType}`;
  const hash = createHash('sha256').update(input.raw).digest('hex').slice(0, 16);
  return `${RAW_KEY_PREFIX}${hash}:${input.eventType}`;
}

/**
 * Record one callback. Returns the key it was written under, so a caller that wants to log
 * the id (or a test that wants to read the row back) does not have to re-derive it.
 *
 * `divergences = divergences + (raw <> excluded.raw)` does the body comparison in SQL rather
 * than as a read-then-write: this runs on the webhook path, and a look-before-write there
 * would be the one shape the rest of this plane deliberately avoids everywhere else.
 * SQLite's `<>` yields 1/0, so the arithmetic is the comparison.
 *
 * NEVER THROWS ON A LOST RACE, because there is nothing to lose: the UPSERT resolves both
 * orders of arrival to the same row.
 */
export function recordWebhookEvent(db: DatabaseSync, input: WebhookEventInput): string {
  const id = webhookEventKey({
    txnId: input.txnId,
    orderId: input.orderId,
    raw: input.raw,
    eventType: input.eventType,
  });
  db.prepare(
    `INSERT INTO webhook_events
       (id, platform, order_id, txn_id, event_type, outcome, detail, raw,
        first_seen_at, last_seen_at, seen_count, divergences)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)
     ON CONFLICT(id) DO UPDATE SET
       last_seen_at = excluded.last_seen_at,
       seen_count   = seen_count + 1,
       -- The LATEST decision. See the file header: the account state reflects it.
       outcome      = excluded.outcome,
       detail       = excluded.detail,
       -- 'raw' is deliberately absent from this SET. First body wins.
       divergences  = divergences + (raw <> excluded.raw)`,
  ).run(
    id,
    input.platform,
    emptyToNull(input.orderId),
    emptyToNull(input.txnId),
    input.eventType,
    input.outcome,
    input.detail ?? null,
    input.raw,
    input.ts,
    input.ts,
  );
  return id;
}

/** `''` and `undefined` both mean "the body did not carry one" and must not be stored apart. */
function emptyToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/** One event by key — the audit read, and how a test asks what was recorded. */
export function webhookEventById(db: DatabaseSync, id: string): WebhookEventRecord | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM webhook_events WHERE id = ?`).get(id) as
    | WebhookEventSqlRow
    | undefined;
  return row ? toRecord(row) : null;
}

/**
 * Every event recorded against one merchant order, oldest first. THE support query: a player
 * says "I paid and got nothing", support has their order id, and this is the list of what
 * the platform actually told this server about it.
 *
 * A callback that named no order is not here, by construction — it could not be attributed
 * to one. `recentWebhookEvents` is what finds those.
 */
export function webhookEventsForOrder(db: DatabaseSync, orderId: string): WebhookEventRecord[] {
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM webhook_events WHERE order_id = ? ORDER BY first_seen_at ASC, id ASC`)
    .all(orderId) as unknown as WebhookEventSqlRow[];
  return rows.map(toRecord);
}

/** The operator sweep: most recently seen first, bounded. */
export function recentWebhookEvents(db: DatabaseSync, limit: number): WebhookEventRecord[] {
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM webhook_events ORDER BY last_seen_at DESC, id ASC LIMIT ?`)
    .all(limit) as unknown as WebhookEventSqlRow[];
  return rows.map(toRecord);
}
